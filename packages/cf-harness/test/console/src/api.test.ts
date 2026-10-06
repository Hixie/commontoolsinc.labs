import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cancelTurn } from "../../../console/src/api.ts";
import type { ConsoleSocketRequestFrame } from "../../../console/socket-protocol.ts";
import { FakeConsoleSocket } from "./fake-socket.ts";

let uninstall: (() => void) | undefined;

/**
 * Opens the page at `pathname` with a console that answers every request with
 * `status` and `body`, and remembers what was asked.
 */
const answerWith = (
  status: number,
  body: string,
  pathname = "/",
): ConsoleSocketRequestFrame[] => {
  const asked: ConsoleSocketRequestFrame[] = [];
  uninstall = FakeConsoleSocket.install((frame) => {
    asked.push(frame);
    return { status, body };
  }, pathname);
  return asked;
};

describe("console/src/api", () => {
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  describe("cancelTurn", () => {
    it("resolves when the server takes the cancel", async () => {
      const asked = answerWith(200, JSON.stringify({ sessionId: "session-a" }));

      await cancelTurn("session-a", "turn-a");

      expect(asked).toHaveLength(1);
    });

    it("asks under the page's mount, which is the root outside a page", async () => {
      // Every path goes through console/src/mount.ts: the socket opens under
      // the mount, and the route it calls is the console's own.
      const asked = answerWith(
        200,
        JSON.stringify({ sessionId: "session-a" }),
        "/harness-console/",
      );

      await cancelTurn("session-a", "turn-a");

      expect(FakeConsoleSocket.opened.map((socket) => socket.url)).toEqual([
        "ws://127.0.0.1:8100/harness-console/api/socket",
      ]);
      expect(asked.map((frame) => [frame.method, frame.path])).toEqual([
        ["POST", "/api/cancel"],
      ]);
    });

    it("tells the server the console page asked for the cancel", async () => {
      const asked = answerWith(200, JSON.stringify({ sessionId: "session-a" }));

      await cancelTurn("session-a", "turn-a");

      expect(asked.map((frame) => frame.body)).toEqual([{
        sessionId: "session-a",
        turnId: "turn-a",
        reason: "canceled from the console page",
      }]);
    });

    it("rejects with the reason a refused cancel reported", async () => {
      answerWith(
        404,
        JSON.stringify({ error: "no turn is running", code: "turn_not_found" }),
      );

      await expect(cancelTurn("session-a", "turn-a")).rejects.toThrow(
        "no turn is running",
      );
    });

    it("rejects with the status a refusal carrying no body reported", async () => {
      answerWith(403, "");

      await expect(cancelTurn("session-a")).rejects.toThrow(
        "the console answered 403",
      );
    });
  });
});
