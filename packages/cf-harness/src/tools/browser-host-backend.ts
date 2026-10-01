/**
 * The `browser` tool's host backend: turning a validated call into one
 * operation for the browser host attached to the run, and the host's result
 * into the tool's output.
 *
 * The host executes the operation in the one session it holds for this run and
 * shows it to the owner. What this side decides is what the operation carries:
 * a value a handle resolves to is resolved here, trusted-side, and marked as a
 * handle value, so the host keeps it out of later observations. A profile
 * field is only named here; its value never leaves the host.
 */

import { decodeBase64 } from "@std/encoding/base64";

import {
  BROWSER_HOST_LOAD_STATES,
  BROWSER_HOST_SCROLL_DIRECTIONS,
  type BrowserHostLoadState,
  type BrowserHostOperation,
  type BrowserHostRefusal,
  type BrowserHostResult,
  type BrowserHostScrollDirection,
  type BrowserHostValue,
  type HarnessBrowserHost,
  isBrowserHostResult,
} from "../contracts/browser-host.ts";
import { createHarnessImageAttachmentFromBytes } from "../image-attachments.ts";
import type {
  BrowserToolAction,
  BrowserToolErrorCode,
  BrowserToolInput,
  BrowserToolOutput,
} from "./browser.ts";
import { httpOriginOf, resolveHandleValue } from "./handle-values.ts";
import type { HarnessToolContext } from "./types.ts";

const MAX_HOST_OUTPUT_CHARS = 20_000;

/** The longest hand-off prompt the owner is shown. */
const MAX_HANDOFF_PROMPT_CHARS = 1_000;

/** What the owner is told a handle's value is, by where it came from. */
const HANDLE_VALUE_DESCRIPTIONS = {
  space: "a value from your space",
  return: "a value an agent found",
} as const;

/** The error code each host refusal is reported under. */
const REFUSAL_CODES: Record<BrowserHostRefusal, BrowserToolErrorCode> = {
  "stale-ref": "stale_ref",
  "owner-only-field": "owner_only_field",
  "session-ended": "session_ended",
  "invalid": "invalid_input",
  "failed": "command_failed",
};

/**
 * An operation whose value, if it enters one, is still to be resolved: the
 * shape of the call, settled before anything is read.
 */
type PlannedOperation =
  | { operation: BrowserHostOperation; binding?: undefined }
  | {
    operation?: undefined;
    binding: {
      field: "url" | "value";
      handle: string;
      complete(resolved: {
        text: string;
        description: string;
      }): BrowserHostOperation | string;
    };
  };

type PlanResult =
  | { plan: PlannedOperation; error?: undefined }
  | { plan?: undefined; error: string };

const isRef = (ref: unknown): ref is string =>
  typeof ref === "string" && ref.startsWith("@");

const refError = (action: string): string =>
  `${action} requires a ref starting with @, taken from a snapshot`;

/** The scroll direction `value` names, or `undefined` when it names none. */
const scrollDirection = (
  value: unknown,
): BrowserHostScrollDirection | undefined =>
  BROWSER_HOST_SCROLL_DIRECTIONS.find((direction) => direction === value);

/** The load state `value` names, or `undefined` when it names none. */
const loadState = (value: unknown): BrowserHostLoadState | undefined =>
  BROWSER_HOST_LOAD_STATES.find((state) => state === value);

const isPoint = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * The operation `input` describes, or the handle it binds and how the value
 * completes the operation once resolved. `input` has already passed the
 * tool's field checks, so every field it carries is one its action reads.
 */
const planHostOperation = (
  host: HarnessBrowserHost,
  input: BrowserToolInput,
  action: BrowserToolAction,
): PlanResult => {
  const done = (operation: BrowserHostOperation): PlanResult => ({
    plan: { operation },
  });
  switch (action) {
    case "open": {
      if (input.urlHandle !== undefined) {
        return {
          plan: {
            binding: {
              field: "url",
              handle: input.urlHandle,
              complete: ({ text }) =>
                httpOriginOf(text) === undefined
                  ? "open only allows http(s) URLs"
                  : { action: "open", url: text },
            },
          },
        };
      }
      if (typeof input.url !== "string" || input.url === "") {
        return { error: "open requires a url" };
      }
      if (httpOriginOf(input.url) === undefined) {
        return { error: "open only allows http(s) URLs" };
      }
      return done({ action: "open", url: input.url });
    }
    case "back":
    case "forward":
    case "reload":
    case "console":
    case "errors":
    case "screenshot":
      return done({ action });
    case "scroll": {
      const direction = scrollDirection(input.direction);
      if (direction === undefined) {
        return {
          error: `scroll requires a direction: ${
            BROWSER_HOST_SCROLL_DIRECTIONS.join(", ")
          }`,
        };
      }
      if (input.ref !== undefined && !isRef(input.ref)) {
        return { error: refError(action) };
      }
      return done({
        action,
        direction,
        ...(input.ref !== undefined ? { ref: input.ref } : {}),
      });
    }
    case "snapshot":
      return done({ action, interactive: input.interactive === true });
    case "get": {
      if (input.kind === "title" || input.kind === "url") {
        return input.target === undefined
          ? done({ action, kind: input.kind })
          : { error: `get ${input.kind} does not take a target` };
      }
      if (input.kind === "text") {
        return typeof input.target === "string" && input.target !== ""
          ? done({ action, kind: "text", target: input.target })
          : {
            error:
              "get text requires a target: a CSS selector such as body, or an @ref from a snapshot",
          };
      }
      return { error: "get requires kind title, url, or text" };
    }
    case "wait": {
      if (input.ms !== undefined) {
        return {
          error:
            "this run's browser waits for something to happen rather than for a time: wait for a ref, a loadState, or a urlPattern",
        };
      }
      const forms = [input.ref, input.loadState, input.urlPattern]
        .filter((form) => form !== undefined);
      if (forms.length !== 1) {
        return {
          error: "wait requires exactly one of ref, loadState, or urlPattern",
        };
      }
      if (input.ref !== undefined) {
        return isRef(input.ref)
          ? done({ action, ref: input.ref })
          : { error: refError(action) };
      }
      if (input.loadState !== undefined) {
        const state = loadState(input.loadState);
        return state !== undefined ? done({ action, loadState: state }) : {
          error:
            "wait loadState must be domcontentloaded, load, or networkidle",
        };
      }
      const urlPattern = input.urlPattern;
      return typeof urlPattern === "string" && urlPattern !== "" &&
          !/^file:/i.test(urlPattern)
        ? done({ action, urlPattern })
        : { error: "wait urlPattern requires a non-file pattern" };
    }
    case "click": {
      if (input.x !== undefined || input.y !== undefined) {
        if (input.ref !== undefined) {
          return {
            error: "click takes a ref or a point (x and y), never both",
          };
        }
        return isPoint(input.x) && isPoint(input.y)
          ? done({ action, x: input.x, y: input.y })
          : {
            error:
              "click at a point requires both x and y, each a non-negative number of screenshot pixels",
          };
      }
      return isRef(input.ref)
        ? done({ action, ref: input.ref })
        : { error: refError(action) };
    }
    case "check":
      return isRef(input.ref)
        ? done({ action, ref: input.ref })
        : { error: refError(action) };
    case "press":
      return typeof input.key === "string" &&
          /^[A-Za-z0-9_+.-]+$/.test(input.key)
        ? done({ action, key: input.key })
        : { error: "press requires one key of letters, digits, _, +, ., or -" };
    case "fill":
    case "type":
    case "select": {
      const ref = input.ref;
      if (!isRef(ref)) {
        return { error: refError(action) };
      }
      const withValue = (value: BrowserHostValue): BrowserHostOperation => ({
        action,
        ref,
        value,
      });
      if (input.profileField !== undefined) {
        const field = input.profileField;
        return host.profileFields.some((offered) => offered.name === field)
          ? done(withValue({ kind: "profile-field", field }))
          : {
            error: host.profileFields.length === 0
              ? "the owner's profile offers no fields to this run"
              : `the owner's profile offers no field named ${field}; it offers ${
                host.profileFields.map((offered) => offered.name).join(", ")
              }`,
          };
      }
      if (input.valueHandle !== undefined) {
        return {
          plan: {
            binding: {
              field: "value",
              handle: input.valueHandle,
              complete: ({ text, description }) =>
                withValue({ kind: "handle-value", text, description }),
            },
          },
        };
      }
      return typeof input.value === "string"
        ? done(withValue({ kind: "text", text: input.value }))
        : {
          error: `${action} requires a value, a valueHandle, or a profileField`,
        };
    }
    case "handoff": {
      const prompt = typeof input.prompt === "string"
        ? input.prompt.trim()
        : "";
      if (prompt === "") {
        return {
          error: "handoff requires a prompt telling the owner what to do",
        };
      }
      if (prompt.length > MAX_HANDOFF_PROMPT_CHARS) {
        return {
          error:
            `handoff prompt must be at most ${MAX_HANDOFF_PROMPT_CHARS} characters`,
        };
      }
      return done({ action, prompt });
    }
  }
};

const truncate = (text: string, label: string): string => {
  if (text.length <= MAX_HOST_OUTPUT_CHARS) {
    return text;
  }
  const omitted = text.length - MAX_HOST_OUTPUT_CHARS;
  return `${
    text.slice(0, MAX_HOST_OUTPUT_CHARS)
  }\n[cf-harness truncated ${label}: ${omitted} chars omitted]`;
};

/** The longest page title the model is shown; a title is the page's words. */
const MAX_TITLE_CHARS = 200;

/**
 * `title`, cut to {@link MAX_TITLE_CHARS} characters as a reader counts them,
 * never inside one: an emoji joined from several, or a letter and its accents,
 * is one.
 */
const truncateTitle = (title: string): string => {
  const characters = Array.from(
    new Intl.Segmenter().segment(title),
    ({ segment }) => segment,
  );
  return characters.length <= MAX_TITLE_CHARS
    ? title
    : `${characters.slice(0, MAX_TITLE_CHARS).join("")}…`;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Executes one validated `browser` call on `host` and returns the tool's
 * output. `action` is the call's action, already established by the tool's
 * field checks.
 *
 * The call waits for the host however long it takes — a hand-off waits for
 * the owner — and ends early only when the run's signal aborts.
 */
export const invokeBrowserOnHost = async (
  context: HarnessToolContext,
  host: HarnessBrowserHost,
  input: BrowserToolInput,
  action: BrowserToolAction,
  outputId: string,
): Promise<BrowserToolOutput> => {
  const errorOutput = (
    code: BrowserToolErrorCode,
    message: string,
  ): BrowserToolOutput => ({ outputId, status: "error", code, message });
  if (input.timeoutMs !== undefined) {
    return errorOutput(
      "invalid_input",
      "timeoutMs does not apply to this run's browser: an action ends when the page does what was asked, or the owner answers",
    );
  }
  // The whole call is planned before anything is read, so a call that cannot
  // execute never reads a value out of the run's space.
  const planned = planHostOperation(host, input, action);
  if (planned.error !== undefined) {
    return errorOutput("invalid_input", planned.error);
  }
  let operation: BrowserHostOperation;
  if (planned.plan.binding === undefined) {
    operation = planned.plan.operation;
  } else {
    const { binding } = planned.plan;
    const resolution = await resolveHandleValue(
      context,
      binding.handle,
      binding.field === "url" ? "browser urlHandle" : "browser valueHandle",
      { returnReferents: true },
    );
    if (resolution.error !== undefined) {
      return errorOutput("invalid_input", resolution.error);
    }
    const completed = binding.complete({
      text: resolution.value,
      description: HANDLE_VALUE_DESCRIPTIONS[resolution.source],
    });
    if (typeof completed === "string") {
      return errorOutput("invalid_input", completed);
    }
    operation = completed;
  }
  let result: BrowserHostResult;
  try {
    const answer: unknown = await host.perform(operation, context.signal);
    if (!isBrowserHostResult(answer)) {
      return errorOutput(
        "host_unavailable",
        "the browser host answered with something that is not a result",
      );
    }
    result = answer;
  } catch (error) {
    context.signal?.throwIfAborted();
    return errorOutput(
      "host_unavailable",
      `the browser host could not be reached: ${errorMessage(error)}`,
    );
  }
  if (result.status !== "ok") {
    return errorOutput(
      REFUSAL_CODES[result.status],
      truncate(result.message, "message"),
    );
  }
  let imageAttachment;
  if (result.image !== undefined) {
    if (context.imageAttachmentSnapshotDir === undefined) {
      return errorOutput(
        "command_failed",
        "this run keeps no artifacts, so a screenshot has nowhere to be held",
      );
    }
    try {
      imageAttachment = await createHarnessImageAttachmentFromBytes({
        snapshotDir: context.imageAttachmentSnapshotDir,
        bytes: decodeBase64(result.image.base64),
        mediaType: result.image.mediaType,
      });
    } catch (error) {
      return errorOutput(
        "command_failed",
        `the screenshot could not be kept: ${errorMessage(error)}`,
      );
    }
  }
  return {
    outputId,
    status: "ok",
    output: truncate(result.text ?? "done", "output"),
    page: { url: result.page.url, title: truncateTitle(result.page.title) },
    ...(result.handoff !== undefined ? { handoff: result.handoff } : {}),
    ...(imageAttachment !== undefined ? { imageAttachment } : {}),
  };
};
