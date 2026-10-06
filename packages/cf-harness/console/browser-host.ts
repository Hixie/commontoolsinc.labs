/**
 * The console's end of a browser host: the channel one turn's browser
 * operations travel to the host that shows them, and their results travel
 * back on.
 *
 * The host is a client that declared, when it started the task over its
 * console socket, that it can host a browser. That socket is the channel:
 * once the host attaches, saying it is ready, each operation arrives on it as
 * a frame, and the host answers each one over the same socket, naming the
 * operation it answers. No other client can answer, because no other client
 * holds that socket.
 *
 * The host answers every operation it is sent, one at a time. When the run
 * withdraws one the host already holds, the socket says so with a withdraw
 * frame; the host stops it if it can, and answers it as it ended, and that
 * answer is the acknowledgment: no later operation reaches the host until it
 * arrives, so nothing the host does for a withdrawn call overlaps what comes
 * next.
 *
 * Nothing here waits on a clock. An operation waits until the host answers
 * it, the host's socket closes, the turn ends, or the run aborts it — a
 * hand-off waits for the owner, however long that takes.
 */

import {
  type BrowserHostOperation,
  type BrowserHostResult,
  type HarnessBrowserHost,
  isBrowserHostResult,
} from "../src/contracts/browser-host.ts";
import type { ConsoleSocketServerFrame } from "./socket-protocol.ts";

/** One operation sent to the host and not yet answered. */
interface PendingOperation {
  settle(result: BrowserHostResult): void;
}

/** What {@link ConsoleBrowserHost.acceptResult} made of a posted result. */
export type BrowserHostResultAcceptance = "accepted" | "unknown" | "invalid";

/**
 * One turn's channel to its browser host. The harness calls
 * {@link perform}; the console hands in the host's results, and ends the
 * channel when the turn or the host's socket ends.
 */
export class ConsoleBrowserHost implements HarnessBrowserHost {
  readonly #turnId: string;
  readonly #send: (frame: ConsoleSocketServerFrame) => void;
  readonly #pending = new Map<string, PendingOperation>();

  /**
   * Operations not yet sent, by id: the host has not attached, or has not
   * yet answered an operation the run withdrew.
   */
  readonly #queued = new Map<string, BrowserHostOperation>();

  /** Operations sent that the host has not answered. */
  readonly #delivered = new Set<string>();

  /** Withdrawn operations the host has not answered. */
  readonly #withdrawn = new Set<string>();

  /**
   * Why the channel takes no more operations, once it does not: the host's
   * socket closed, or the turn ended.
   */
  #ended: string | undefined;
  #attached = false;
  #nextId = 0;

  /**
   * Constructs the channel for turn `turnId`, whose frames `send` writes to
   * the host's socket.
   */
  constructor(
    turnId: string,
    send: (frame: ConsoleSocketServerFrame) => void,
  ) {
    this.#turnId = turnId;
    this.#send = send;
  }

  /**
   * Sends `operation` to the host and resolves with its answer. Resolves with
   * `session-ended` when the host's socket or the turn has ended, or ends
   * while the operation is outstanding. Rejects with the signal's reason when
   * `signal` aborts first, withdrawing the operation.
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
      const onAbort = () => {
        this.#pending.delete(id);
        if (!this.#queued.delete(id) && this.#delivered.delete(id)) {
          this.#withdrawn.add(id);
          this.#send({
            type: "browser-host-withdraw",
            turnId: this.#turnId,
            id,
          });
        }
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        settle: (result) => {
          signal?.removeEventListener("abort", onAbort);
          this.#pending.delete(id);
          this.#delivered.delete(id);
          resolve(result);
        },
      });
      this.#queued.set(id, operation);
      this.#flush();
    });
  }

  /**
   * Starts sending the host its operations, every one not yet sent first.
   * The first attach is the only one. Returns `false` when the host has
   * already attached or the channel has ended.
   */
  attach(): boolean {
    if (this.#attached || this.#ended !== undefined) {
      return false;
    }
    this.#attached = true;
    this.#flush();
    return true;
  }

  /**
   * Hands in the host's answer to operation `id`. The answer to a withdrawn
   * operation acknowledges the withdrawal, and lets the next operation reach
   * the host. An answer for an operation nobody is waiting on is `unknown`.
   * One that is not a result is `invalid`, and settles the operation as
   * `failed` rather than leaving it waiting: the host answered, and what it
   * answered is not something the run can read, which is a refusal rather
   * than an observation.
   */
  acceptResult(id: unknown, result: unknown): BrowserHostResultAcceptance {
    if (typeof id === "string" && this.#withdrawn.delete(id)) {
      this.#flush();
      return "accepted";
    }
    // Only an operation the host was sent can be answered: one still queued
    // has not reached it, and an answer for it is not one.
    const pending = typeof id === "string" && this.#delivered.has(id)
      ? this.#pending.get(id)
      : undefined;
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

  /**
   * Ends the channel because the turn ended: the host is told, and anything
   * outstanding settles as `session-ended`.
   */
  close(): void {
    if (this.#ended !== undefined) {
      return;
    }
    this.#end("the turn has ended");
    this.#send({ type: "browser-host-close", turnId: this.#turnId });
  }

  /**
   * Ends the channel because the host's socket closed or the host gave the
   * turn up: there is nobody left to tell, and anything outstanding settles as
   * `session-ended`.
   */
  detach(): void {
    this.#end("the browser host's connection ended");
  }

  /**
   * Sends the queued operations, once the host has attached and owes no
   * answer to a withdrawn operation.
   */
  #flush(): void {
    if (!this.#attached || this.#withdrawn.size > 0) {
      return;
    }
    for (const [id, operation] of this.#queued) {
      this.#send({
        type: "browser-host-request",
        turnId: this.#turnId,
        id,
        operation,
      });
      this.#delivered.add(id);
    }
    this.#queued.clear();
  }

  #end(reason: string): void {
    this.#ended ??= reason;
    this.#queued.clear();
    this.#withdrawn.clear();
    const message = this.#ended;
    for (const pending of [...this.#pending.values()]) {
      pending.settle({ status: "session-ended", message });
    }
  }
}
