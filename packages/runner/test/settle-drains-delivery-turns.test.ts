/// <reference path="./clock.d.ts" />
// The in-process memory transport hands each server frame to the client on
// its own turn of the event loop, and the emulated server flushes its
// subscription fan-out on one too. Both turns come from `setImmediate`, and
// the fake-clock harness replaces it alongside `setTimeout` so those turns
// join the zero-delay timers `clock.settle()` drains to a fixpoint. A test
// that settles and then reads state depends on that: a deferral the harness
// cannot see is one `settle()` can return in front of, leaving the read a
// frame short of the cascade it was waiting for.
//
// Real immediates do not carry this on their own. The event loop runs a
// pending immediate before a pending timer, so a chain that arms the next
// immediate from inside the previous callback drains ahead of one — but an
// immediate armed from a microtask of that callback runs after the timer,
// and a timer is what each round of `settle()` waits on. The first case
// below reads the order of a timer and an immediate armed after it, and
// finds the harness's order rather than the event loop's.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

// Arm `count` immediates, each armed by the one before it, recording the
// order they run in. This is the shape a queued run of frames takes: the
// transport delivers one frame per turn and arms the next turn from inside
// the delivery.
const armImmediateChain = (count: number, log: string[]): void => {
  let armed = 0;
  const step = () => {
    log.push(`immediate-${armed}`);
    if (++armed < count) setImmediate(step);
  };
  setImmediate(step);
};

describe("clock.settle() drains the turns memory delivery runs on", () => {
  it("queues an immediate behind a zero-delay timer armed before it", async () => {
    const log: string[] = [];
    setTimeout(() => log.push("timer"), 0);
    setImmediate(() => log.push("immediate"));
    await clock.settle();
    // Arming order, because the harness holds both in one queue and fires
    // them in one pass. The event loop left to itself runs every pending
    // immediate first, and would report these the other way round.
    expect(log).toEqual(["timer", "immediate"]);
  });

  it("returns with a chain of immediates fully drained", async () => {
    const log: string[] = [];
    armImmediateChain(4, log);
    await clock.settle();
    expect(log).toEqual([
      "immediate-0",
      "immediate-1",
      "immediate-2",
      "immediate-3",
    ]);
  });

  it("leaves a cleared immediate unfired", async () => {
    const log: string[] = [];
    const handle = setImmediate(() => log.push("cancelled"));
    clearImmediate(handle);
    setImmediate(() => log.push("kept"));
    await clock.settle();
    expect(log).toEqual(["kept"]);
  });
});
