import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { ConsoleBrowserHost } from "../../console/browser-host.ts";
import type { ConsoleSocketServerFrame } from "../../console/socket-protocol.ts";

const PAGE = { url: "https://shop.example/", title: "Shop" };

/** A channel for turn `t`, and every frame it has sent its host. */
const channel = () => {
  const sent: ConsoleSocketServerFrame[] = [];
  return {
    host: new ConsoleBrowserHost("t", (frame) => sent.push(frame)),
    sent,
  };
};

const request = (id: string, action: "reload" | "back") => ({
  type: "browser-host-request",
  turnId: "t",
  id,
  operation: { action },
});

const CLOSE = { type: "browser-host-close", turnId: "t" };

describe("console/browser-host", () => {
  describe("ConsoleBrowserHost", () => {
    it("delivers an operation sent before the host attached once it does", async () => {
      const { host, sent } = channel();
      const answer = host.perform({ action: "reload" });

      const before = [...sent];
      host.attach();
      const accepted = host.acceptResult("1", { status: "ok", page: PAGE });

      expect(before).toEqual([]);
      expect(sent).toEqual([request("1", "reload")]);
      expect(accepted).toBe("accepted");
      expect(await answer).toEqual({ status: "ok", page: PAGE });
    });

    it("refuses a second attach, and any attach once the channel has ended", () => {
      const attached = channel().host;
      const closed = channel().host;
      const detached = channel().host;

      expect(attached.attach()).toBe(true);
      closed.close();
      detached.detach();

      expect(attached.attach()).toBe(false);
      expect(closed.attach()).toBe(false);
      expect(detached.attach()).toBe(false);
    });

    it("returns session-ended for an operation sent after the turn ended", async () => {
      const { host, sent } = channel();
      const outstanding = host.perform({
        action: "snapshot",
        interactive: false,
      });
      host.attach();

      host.close();

      expect(await outstanding).toEqual({
        status: "session-ended",
        message: "the turn has ended",
      });
      expect(await host.perform({ action: "reload" })).toEqual({
        status: "session-ended",
        message: "the turn has ended",
      });
      expect(sent.at(-1)).toEqual(CLOSE);
    });

    it("returns session-ended once the host's socket closes, and sends it nothing more", async () => {
      const { host, sent } = channel();
      host.attach();
      const outstanding = host.perform({ action: "reload" });

      host.detach();
      const later = host.perform({ action: "back" });
      host.close();

      const ended = {
        status: "session-ended",
        message: "the browser host's connection ended",
      };
      expect(await outstanding).toEqual(ended);
      expect(await later).toEqual(ended);
      expect(sent).toEqual([request("1", "reload")]);
    });

    it("rejects an operation with the signal's reason when the run aborts it", async () => {
      const { host } = channel();
      const controller = new AbortController();
      const answer = host.perform({ action: "reload" }, controller.signal);

      controller.abort(new Error("canceled"));

      await expect(answer).rejects.toThrow("canceled");
      expect(host.acceptResult("1", { status: "ok", page: PAGE })).toBe(
        "unknown",
      );
    });

    it("never delivers an operation the run withdrew before the host attached, and rejects an aborted signal outright", async () => {
      const { host, sent } = channel();
      const controller = new AbortController();
      const withdrawn = host.perform({ action: "reload" }, controller.signal);
      controller.abort(new Error("canceled"));
      const refused = host.perform({ action: "back" }, controller.signal);
      host.attach();

      host.close();

      await expect(withdrawn).rejects.toThrow("canceled");
      await expect(refused).rejects.toThrow("canceled");
      expect(sent).toEqual([CLOSE]);
    });

    it("withdraws an operation the host holds when the run aborts it, and sends the host nothing more until it answers that one", async () => {
      const { host, sent } = channel();
      host.attach();
      const controller = new AbortController();
      const withdrawn = host.perform({ action: "reload" }, controller.signal);
      controller.abort(new Error("canceled"));
      const next = host.perform({ action: "back" });

      const beforeAcknowledgment = [...sent];
      const acknowledged = host.acceptResult("1", {
        status: "failed",
        message: "stopped",
      });
      const answered = host.acceptResult("2", { status: "ok", page: PAGE });
      host.close();

      await expect(withdrawn).rejects.toThrow("canceled");
      expect(acknowledged).toBe("accepted");
      expect(answered).toBe("accepted");
      expect(await next).toEqual({ status: "ok", page: PAGE });
      expect(beforeAcknowledgment).toEqual([
        request("1", "reload"),
        { type: "browser-host-withdraw", turnId: "t", id: "1" },
      ]);
      expect(sent).toEqual([
        ...beforeAcknowledgment,
        request("2", "back"),
        CLOSE,
      ]);
    });

    it("takes no answer for an operation the host has not been sent, and sends it once the host attaches", async () => {
      const { host, sent } = channel();
      const answer = host.perform({ action: "reload" });

      const early = host.acceptResult("1", { status: "ok", page: PAGE });
      host.attach();
      const accepted = host.acceptResult("1", { status: "ok", page: PAGE });

      expect(early).toBe("unknown");
      expect(accepted).toBe("accepted");
      expect(await answer).toEqual({ status: "ok", page: PAGE });
      expect(sent).toEqual([request("1", "reload")]);
    });

    it("settles an operation as failed when the host answers with something that is not a result", async () => {
      const { host } = channel();
      const answer = host.perform({ action: "reload" });
      host.attach();

      const acceptance = host.acceptResult("1", { status: "ok" });

      expect(acceptance).toBe("invalid");
      expect(await answer).toEqual({
        status: "failed",
        message:
          "the browser host answered with something that is not a result",
      });
      expect(host.acceptResult("1", { status: "ok", page: PAGE })).toBe(
        "unknown",
      );
    });
  });
});
