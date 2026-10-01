/**
 * The protocol between the harness and a browser host: the trusted component
 * that owns a web engine, executes the `browser` tool's operations in a
 * session it holds, and shows that session to the owner. The Weaver is the
 * host this protocol is written for; the harness side reaches it through
 * whatever channel the dispatcher opened, so nothing here names a transport.
 *
 * A session is the host's, bound to one turn, and never named in an
 * operation: the host executes every operation in the one session the
 * channel is attached to. An operation names no jar, no endpoint, and no
 * grant.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";

/** Where the page model places an operation's target: a ref from a snapshot. */
export type BrowserHostRef = string;

/** A direction `scroll` moves the page, or the scrollable element at a ref. */
export const BROWSER_HOST_SCROLL_DIRECTIONS = [
  "up",
  "down",
  "left",
  "right",
] as const;

/** One of {@link BROWSER_HOST_SCROLL_DIRECTIONS}. */
export type BrowserHostScrollDirection =
  typeof BROWSER_HOST_SCROLL_DIRECTIONS[number];

/** A load state `wait` can wait for. */
export const BROWSER_HOST_LOAD_STATES = [
  "domcontentloaded",
  "load",
  "networkidle",
] as const;

/** One of {@link BROWSER_HOST_LOAD_STATES}. */
export type BrowserHostLoadState = typeof BROWSER_HOST_LOAD_STATES[number];

/**
 * A value an operation enters into a page.
 *
 * - `text` is text the agent composed: the host enters it as given.
 * - `handle-value` is a value a handle resolved to, which no model that saw it
 *   chose for this page: one from the owner's space, or a string a child
 *   returned; `description` says which. The host enters it and keeps it out of
 *   every later observation of the page.
 * - `profile-field` names a field of the owner's profile, which the host holds
 *   and the harness never does. The host resolves it, enters it, and keeps it
 *   out of every later observation of the page.
 *
 * Nothing here asks the owner whether a value may go to a page: a question at
 * every step teaches a person to agree without reading. Whether it may is for
 * release rules over the value's CFC label, which the harness states and the
 * host enforces.
 */
export type BrowserHostValue =
  | { kind: "text"; text: string }
  | { kind: "handle-value"; text: string; description: string }
  | { kind: "profile-field"; field: string };

/** One operation the host executes in the session. */
export type BrowserHostOperation =
  | {
    action: "open";

    /** The address, as the agent wrote it or as a handle resolved it. */
    url: string;
  }
  | { action: "back" }
  | { action: "forward" }
  | { action: "reload" }
  | {
    action: "scroll";
    direction: BrowserHostScrollDirection;
    ref?: BrowserHostRef;
  }
  | { action: "snapshot"; interactive: boolean }
  | { action: "get"; kind: "title" | "url" }
  | { action: "get"; kind: "text"; target: string }
  | { action: "console" }
  | { action: "errors" }
  | { action: "screenshot" }
  | { action: "wait"; ref: BrowserHostRef }
  | { action: "wait"; loadState: BrowserHostLoadState }
  | { action: "wait"; urlPattern: string }
  | { action: "click"; ref: BrowserHostRef }
  | { action: "click"; x: number; y: number }
  | { action: "check"; ref: BrowserHostRef }
  | { action: "press"; key: string }
  | {
    action: "fill" | "type" | "select";
    ref: BrowserHostRef;
    value: BrowserHostValue;
  }
  | { action: "handoff"; prompt: string };

/** The page a result was observed on, as the host committed it. */
export interface BrowserHostPage {
  /** The URL the engine committed for the main frame. */
  url: string;

  /** The document's title, as the page wrote it. */
  title: string;
}

/**
 * The ways a host declines or fails an operation. Each is a fixed word, so a
 * refusal carries no page-authored text in its code.
 *
 * - `stale-ref`: the ref names an element of a document the page has since
 *   replaced; take a new snapshot.
 * - `owner-only-field`: the target is a password or one-time-code field, or a
 *   challenge; only the owner may enter a value there, through a hand-off.
 * - `session-ended`: the session is gone — the owner closed it, or the host
 *   detached.
 * - `invalid`: the operation does not describe anything the host can do.
 * - `failed`: the operation was attempted and did not complete.
 */
export const BROWSER_HOST_REFUSALS = [
  "stale-ref",
  "owner-only-field",
  "session-ended",
  "invalid",
  "failed",
] as const;

/** One of {@link BROWSER_HOST_REFUSALS}. */
export type BrowserHostRefusal = typeof BROWSER_HOST_REFUSALS[number];

/** What a host returns for one operation. */
export type BrowserHostResult =
  | {
    status: "ok";
    page: BrowserHostPage;

    /** The operation's observation as text, when it has one. */
    text?: string;

    /** A screenshot's pixels. */
    image?: { mediaType: "image/png"; base64: string };

    /** How the owner ended a hand-off. */
    handoff?: "done" | "declined";
  }
  | {
    status: BrowserHostRefusal;
    message: string;
    page?: BrowserHostPage;
  };

/**
 * A field of the owner's profile the host can fill: its name, which an
 * operation names, and the label the owner knows it by. The value stays with
 * the host.
 */
export interface BrowserHostProfileField {
  name: string;
  label: string;
}

/**
 * The harness side of an attached host: what the `browser` tool calls when a
 * run has one. `perform` settles when the host answers or `signal` aborts,
 * and never on a clock of its own, since an operation that needs the owner
 * waits for the owner.
 */
export interface HarnessBrowserHost {
  /** The profile fields the host offers, named when it attached. */
  readonly profileFields: readonly BrowserHostProfileField[];

  /** Executes `operation` in the host's session for this run. */
  perform(
    operation: BrowserHostOperation,
    signal?: AbortSignal,
  ): Promise<BrowserHostResult>;
}

/**
 * Whether `value` is a result a host could have sent: a known status with the
 * fields that status carries. A host is trusted to execute operations, not to
 * be free of bugs, so what crosses the channel is checked before the harness
 * reads it.
 */
export const isBrowserHostResult = (
  value: unknown,
): value is BrowserHostResult => {
  if (!isObjectNotArray(value)) {
    return false;
  }
  const page = value.page;
  const pageValid = page === undefined ||
    (isObjectNotArray(page) && typeof page.url === "string" &&
      typeof page.title === "string");
  if (!pageValid) {
    return false;
  }
  if (value.status === "ok") {
    const image = value.image;
    return page !== undefined &&
      (value.text === undefined || typeof value.text === "string") &&
      (value.handoff === undefined || value.handoff === "done" ||
        value.handoff === "declined") &&
      (image === undefined ||
        (isObjectNotArray(image) && image.mediaType === "image/png" &&
          typeof image.base64 === "string"));
  }
  return typeof value.status === "string" && REFUSALS.has(value.status) &&
    typeof value.message === "string";
};

const REFUSALS: ReadonlySet<string> = new Set(BROWSER_HOST_REFUSALS);
