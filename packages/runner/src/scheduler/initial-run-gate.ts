import type { Cancel } from "../cancel.ts";
import { noOp } from "../cancel.ts";

/**
 * The consumer side of an initial-run gate: registrations passed a gate defer
 * until it releases, and gate cancellation discards them. A gate settles once,
 * as released or cancelled, and never changes afterwards.
 */
export interface InitialRunGate {
  isReleased(): boolean;
  /**
   * Invokes `callback` when the gate releases — synchronously when it already
   * has. On a cancelled gate the callback is dropped. The returned cancel
   * unsubscribes a callback that has not fired.
   */
  onRelease(callback: () => void): Cancel;
}

export interface InitialRunGateController {
  gate: InitialRunGate;
  release(): void;
  cancel(): void;
}

/**
 * Creates a gate that holds scheduler registrations until its owner settles
 * it. The owner releases the gate when the transaction that establishes the
 * gated work commits, and cancels it when that transaction fails, so work
 * created by uncommitted setup never runs against state that did not land.
 *
 * `release` invokes every pending callback even when one throws, then
 * rethrows the failure (an `AggregateError` for more than one) to the
 * releaser. `cancel` drops the pending callbacks. Both are idempotent, and
 * whichever settles the gate first wins.
 */
export function createInitialRunGate(): InitialRunGateController {
  let state: "pending" | "released" | "cancelled" = "pending";
  const callbacks = new Set<() => void>();

  const gate: InitialRunGate = {
    isReleased: () => state === "released",
    onRelease(callback) {
      if (state === "released") {
        callback();
        return noOp;
      }
      if (state === "cancelled") return noOp;
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
  };

  return {
    gate,
    release() {
      if (state !== "pending") return;
      state = "released";
      const pendingCallbacks = [...callbacks];
      callbacks.clear();
      const errors: unknown[] = [];
      for (const callback of pendingCallbacks) {
        try {
          callback();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Multiple initial-run gate callbacks failed",
        );
      }
    },
    cancel() {
      if (state !== "pending") return;
      state = "cancelled";
      callbacks.clear();
    },
  };
}
