/**
 * The console's end of a browser host: the channel one turn's browser
 * operations travel to the host that shows them, and their results travel
 * back on.
 *
 * The host is a client that declared, when it started the task, that it can
 * host a browser. The console answered it with a token for that turn, and
 * nobody else holds it. The host then holds a stream open, on which each
 * operation arrives as an event, and posts each result back naming the
 * operation it answers. The token is what binds the stream and the results to
 * that client: a request that names the turn without it is refused.
 *
 * Nothing here waits on a clock. An operation waits until the host answers
 * it, the host's stream ends, the turn ends, or the run aborts it — a
 * hand-off waits for the owner, however long that takes.
 */

import { timingSafeEqual } from "@std/crypto/timing-safe-equal";

import {
  type BrowserHostOperation,
  type BrowserHostProfileField,
  type BrowserHostResult,
  type HarnessBrowserHost,
  isBrowserHostResult,
} from "../src/contracts/browser-host.ts";
import { sseFrame } from "./sse.ts";

/** The SSE event name an operation for the host arrives under. */
export const BROWSER_HOST_REQUEST_EVENT = "request";

/** The SSE event name that tells the host the turn is over. */
export const BROWSER_HOST_CLOSE_EVENT = "close";

/** The most profile fields a host may offer one turn. */
const MAX_PROFILE_FIELDS = 64;

/** The shape of a profile field's name: a dotted path of lowercase words. */
const PROFILE_FIELD_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

const MAX_PROFILE_FIELD_LABEL = 80;

const encoder = new TextEncoder();

/** One operation sent to the host and not yet answered. */
interface PendingOperation {
  settle(result: BrowserHostResult): void;
}

/** What {@link ConsoleBrowserHost.acceptResult} made of a posted result. */
export type BrowserHostResultAcceptance = "accepted" | "unknown" | "invalid";

/**
 * The profile fields a task body's `browserHost` declares, or an explanation
 * of why they are not a list of fields. The names reach the model as the
 * vocabulary of `profileField`, and the labels reach it beside them, so both
 * are held to a shape rather than passed through as the client wrote them.
 */
export const parseBrowserHostDeclaration = (
  value: unknown,
):
  | { profileFields: BrowserHostProfileField[]; error?: undefined }
  | { profileFields?: undefined; error: string } => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "browserHost must be an object" };
  }
  const fields = "profileFields" in value ? value.profileFields : undefined;
  if (fields === undefined) {
    return { profileFields: [] };
  }
  if (!Array.isArray(fields) || fields.length > MAX_PROFILE_FIELDS) {
    return {
      error:
        `browserHost.profileFields must be a list of at most ${MAX_PROFILE_FIELDS} fields`,
    };
  }
  const profileFields: BrowserHostProfileField[] = [];
  const names = new Set<string>();
  for (const field of fields) {
    const name = typeof field === "object" && field !== null &&
        "name" in field
      ? field.name
      : undefined;
    const label = typeof field === "object" && field !== null &&
        "label" in field
      ? field.label
      : undefined;
    if (typeof name !== "string" || !PROFILE_FIELD_NAME.test(name)) {
      return {
        error:
          "each browserHost.profileFields name must be lowercase words joined by dots, dashes, or underscores",
      };
    }
    if (
      typeof label !== "string" || label.trim() === "" ||
      label.length > MAX_PROFILE_FIELD_LABEL || /[\p{Cc}]/u.test(label)
    ) {
      return {
        error:
          `each browserHost.profileFields label must be one line of at most ${MAX_PROFILE_FIELD_LABEL} characters`,
      };
    }
    if (names.has(name)) {
      return { error: `browserHost.profileFields names ${name} twice` };
    }
    names.add(name);
    profileFields.push({ name, label: label.trim() });
  }
  return { profileFields };
};

/**
 * One turn's channel to its browser host. The harness calls
 * {@link perform}; the console's routes attach the host's stream and hand in
 * its results.
 */
export class ConsoleBrowserHost implements HarnessBrowserHost {
  readonly #token: Uint8Array;
  readonly #profileFields: readonly BrowserHostProfileField[];
  readonly #pending = new Map<string, PendingOperation>();

  /** Operations sent before the host attached, by id. */
  #queued = new Map<string, string>();
  #stream: ReadableStreamDefaultController<Uint8Array> | undefined;

  /**
   * Why the channel takes no more operations, once it does not: the host's
   * stream ended, or the turn did.
   */
  #ended: string | undefined;
  #nextId = 0;

  /** Constructs the channel for a host holding `token`. */
  constructor(
    token: string,
    profileFields: readonly BrowserHostProfileField[],
  ) {
    this.#token = encoder.encode(token);
    this.#profileFields = profileFields;
  }

  /** The profile fields the host offered when it declared itself. */
  get profileFields(): readonly BrowserHostProfileField[] {
    return this.#profileFields;
  }

  /** Whether `token` is the one this channel was minted with. */
  admits(token: unknown): boolean {
    if (typeof token !== "string") {
      return false;
    }
    const candidate = encoder.encode(token);
    return candidate.byteLength === this.#token.byteLength &&
      timingSafeEqual(candidate, this.#token);
  }

  /**
   * Sends `operation` to the host and resolves with its answer. Resolves with
   * `session-ended` when the host's stream or the turn has ended, or ends
   * while the operation is outstanding. Rejects with the signal's reason when
   * `signal` aborts first.
   */
  perform(
    operation: BrowserHostOperation,
    signal?: AbortSignal,
  ): Promise<BrowserHostResult> {
    if (this.#ended !== undefined) {
      return Promise.resolve({ status: "session-ended", message: this.#ended });
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    const id = String(++this.#nextId);
    return new Promise<BrowserHostResult>((resolve, reject) => {
      // An operation the host has not been sent yet is withdrawn with it.
      const onAbort = () => {
        this.#pending.delete(id);
        this.#queued.delete(id);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        settle: (result) => {
          signal?.removeEventListener("abort", onAbort);
          this.#pending.delete(id);
          resolve(result);
        },
      });
      this.#send(
        sseFrame(BROWSER_HOST_REQUEST_EVENT, JSON.stringify({ id, operation })),
        id,
      );
    });
  }

  /**
   * The host's stream: every operation not yet delivered, then each one as
   * it is sent. The first attach is the only one; the channel ends when the
   * stream does, since a host that went away holds no session to continue
   * in. Returns `undefined` when the channel already has a stream or has
   * ended.
   */
  attach(): ReadableStream<Uint8Array> | undefined {
    if (this.#stream !== undefined || this.#ended !== undefined) {
      return undefined;
    }
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#stream = controller;
        for (const frame of this.#queued.values()) {
          controller.enqueue(encoder.encode(frame));
        }
        this.#queued.clear();
      },
      cancel: () => {
        this.#stream = undefined;
        this.#end("the browser host's connection ended");
      },
    });
  }

  /**
   * Hands in the host's answer to operation `id`. A result for an operation
   * nobody is waiting on is `unknown`. One that is not a result is `invalid`,
   * and settles the operation as `failed` rather than leaving it waiting:
   * the host answered, and what it answered is not something the run can
   * read, which is a refusal (AH-BRW-46) rather than an observation.
   */
  acceptResult(id: unknown, result: unknown): BrowserHostResultAcceptance {
    const pending = typeof id === "string" ? this.#pending.get(id) : undefined;
    if (pending === undefined) {
      return "unknown";
    }
    if (!isBrowserHostResult(result)) {
      pending.settle({
        status: "failed",
        message:
          "the browser host answered with something that is not a result",
      });
      return "invalid";
    }
    pending.settle(result);
    return "accepted";
  }

  /** Keeps a quiet stream visibly alive through proxies between the two. */
  ping(beat: number): void {
    if (this.#stream !== undefined) {
      this.#stream.enqueue(encoder.encode(`: ${beat}\n\n`));
    }
  }

  /**
   * Ends the channel because the turn ended: the host is told, its stream
   * closes, and anything outstanding settles as `session-ended`.
   */
  close(): void {
    if (this.#ended !== undefined) {
      return;
    }
    this.#end("the turn has ended");
    this.#queued.clear();
    const stream = this.#stream;
    this.#stream = undefined;
    stream?.enqueue(encoder.encode(sseFrame(BROWSER_HOST_CLOSE_EVENT, "{}")));
    stream?.close();
  }

  /**
   * Writes operation `id`'s frame to the stream, or holds it until the host
   * attaches.
   */
  #send(frame: string, id: string): void {
    if (this.#stream === undefined) {
      this.#queued.set(id, frame);
      return;
    }
    this.#stream.enqueue(encoder.encode(frame));
  }

  #end(reason: string): void {
    this.#ended ??= reason;
    const message = this.#ended;
    for (const pending of [...this.#pending.values()]) {
      pending.settle({ status: "session-ended", message });
    }
  }
}
