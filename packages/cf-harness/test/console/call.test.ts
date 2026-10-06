import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { consoleSocketUrl, runConsoleCall } from "../../console/call.ts";
import { serveConsole } from "../support/console-serving.ts";

describe("console/call", () => {
  const stops: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const stop of stops.splice(0)) {
      await stop();
    }
  });

  /** Runs one command line, answering with its exit code and what it wrote. */
  const run = async (args: readonly string[]) => {
    const printed: string[] = [];
    const reported: string[] = [];
    const code = await runConsoleCall(
      args,
      (line) => printed.push(line),
      (line) => reported.push(line),
    );
    return { code, printed, reported };
  };

  const serve = async () => {
    const serving = await serveConsole();
    stops.push(serving.stop);
    return serving;
  };

  describe("consoleSocketUrl()", () => {
    it("addresses the socket under the console URL, over wss for https", () => {
      expect(consoleSocketUrl("http://127.0.0.1:8135")).toBe(
        "ws://127.0.0.1:8135/api/socket",
      );
      expect(consoleSocketUrl("https://loom.example/harness-console/")).toBe(
        "wss://loom.example/harness-console/api/socket",
      );
    });
  });

  describe("runConsoleCall()", () => {
    it("prints a route's answer and exits 0 for a 2xx, and reports the status and exits 1 otherwise", async () => {
      const { url } = await serve();

      const health = await run([url, "GET", "/api/health"]);
      const missing = await run([url, "GET", "/api/nothing-here"]);

      expect(health.code).toBe(0);
      expect(JSON.parse(health.printed[0])).toMatchObject({ ok: true });
      expect(health.reported).toEqual([]);
      expect(missing.code).toBe(1);
      expect(missing.reported).toEqual(["the console answered 404"]);
    });

    it("starts a task, and follows the turn's events until it ends", async () => {
      const { url } = await serve();

      const started = await run([url, "POST", "/api/task", '{"text":"hi"}']);
      const { sessionId, turnId } = JSON.parse(started.printed[0]);
      const followed = await run([url, "follow", sessionId, turnId]);

      expect(started.code).toBe(0);
      expect(followed.code).toBe(0);
      expect(followed.reported).toEqual([]);
      const kinds = followed.printed.map((line) => JSON.parse(line).event.kind);
      expect(kinds[0]).toBe("turn_started");
      expect(kinds.at(-1)).toBe("turn_completed");
    });

    it("reports a console it cannot reach and exits 1", async () => {
      const { url, stop } = await serveConsole();
      await stop();

      const unreachable = await run([url, "GET", "/api/health"]);

      expect(unreachable.code).toBe(1);
      expect(unreachable.reported).toEqual([
        "the console socket did not open",
      ]);
    });

    it("exits 2 with the usage for a command line it cannot read", async () => {
      const usage = await run(["http://127.0.0.1:1"]);
      const getWithBody = await run([
        "http://127.0.0.1:1",
        "GET",
        "/api/health",
        "{}",
      ]);

      expect(usage.code).toBe(2);
      expect(usage.reported[0]).toContain("usage: console:call");
      expect(getWithBody.code).toBe(2);
    });
  });
});
