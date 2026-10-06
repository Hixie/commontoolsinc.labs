import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ConsoleRunDetail } from "../../../console/run-store.ts";
import { ConsoleRunView } from "../../../console/src/run-view.ts";
import { FakeConsoleSocket } from "./fake-socket.ts";

/** What a console answers one request with. */
type Answer = { status: number; body: string };

let uninstall: (() => void) | undefined;

/**
 * A console whose answers the test releases by hand, in whatever order it
 * likes. Nothing here waits on a span of time: each read is resolved
 * explicitly, and the promise the view returned is what the test awaits.
 */
const heldAnswers = (): readonly PromiseWithResolvers<Answer>[] => {
  const held: PromiseWithResolvers<Answer>[] = [];
  uninstall = FakeConsoleSocket.install(() => {
    const pending = Promise.withResolvers<Answer>();
    held.push(pending);
    return pending.promise;
  });
  return held;
};

/**
 * Settles once the console has been asked `count` questions, so a test can
 * release one it knows has been asked.
 */
const asked = async (count: number): Promise<void> => {
  const socket = await FakeConsoleSocket.socket(0);
  while (
    socket.sent.filter((frame) => frame.type === "request").length < count
  ) {
    await socket.nextFrame();
  }
};

const detailOf = (runId: string): Answer => ({
  status: 200,
  body: JSON.stringify(
    {
      summary: { runId },
      steps: [],
      handles: [],
      artifactNames: [],
      toolOutputNames: [],
    } as unknown as ConsoleRunDetail,
  ),
});

describe("console/src/run-view", () => {
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  describe("refresh", () => {
    it("keeps the run that was asked for last when an earlier read answers after it", async () => {
      const held = heldAnswers();
      const view = new ConsoleRunView();
      view.runId = "run-first";
      const first = view.refresh();
      view.runId = "run-second";
      const second = view.refresh();

      await asked(2);
      held[1].resolve(detailOf("run-second"));
      await second;
      held[0].resolve(detailOf("run-first"));
      await first;

      expect(view.detail?.summary.runId).toBe("run-second");
    });

    it("leaves the newest run showing when an earlier read fails after it", async () => {
      const held = heldAnswers();
      const view = new ConsoleRunView();
      view.runId = "run-first";
      const first = view.refresh();
      view.runId = "run-second";
      const second = view.refresh();

      await asked(2);
      held[1].resolve(detailOf("run-second"));
      await second;
      held[0].resolve({ status: 404, body: "not found" });
      await first;

      expect(view.error).toBeUndefined();
      expect(view.detail?.summary.runId).toBe("run-second");
    });

    it("clears the detail rather than adopting a read of the run that was closed", async () => {
      const held = heldAnswers();
      const view = new ConsoleRunView();
      view.runId = "run-first";
      const first = view.refresh();
      view.runId = undefined;
      await view.refresh();

      await asked(1);
      held[0].resolve(detailOf("run-first"));
      await first;

      expect(view.detail).toBeUndefined();
    });
  });
});
