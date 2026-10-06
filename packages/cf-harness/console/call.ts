#!/usr/bin/env -S deno run -A

/**
 * The console socket from a shell: one route called, or one turn's events
 * followed, over a socket opened for the purpose.
 *
 *   deno task console:call <console-url> GET /api/status
 *   deno task console:call <console-url> POST /api/task '{"text": "…"}'
 *   deno task console:call <console-url> follow <sessionId> [<turnId>]
 *
 * A call prints the route's answer and exits 0 when its status is 2xx, and
 * otherwise prints the status to stderr as well and exits 1. A body that is
 * not JSON, or a console the socket cannot reach, is reported and exits 1.
 *
 * `follow` prints each event as one JSON line, recorded events first. Given a
 * turn, it prints only that turn's events and exits after the event that ends
 * the turn; otherwise it prints the session's events until the console closes
 * the socket.
 */

import { CONSOLE_SOCKET_PATH } from "./socket-protocol.ts";
import { ConsoleSocket } from "./src/socket.ts";

const USAGE = `usage: console:call <console-url> GET|POST <path> [<json-body>]
       console:call <console-url> follow <sessionId> [<turnId>]`;

/** The events that end a turn. */
const TURN_ENDS: ReadonlySet<string> = new Set([
  "turn_completed",
  "turn_failed",
  "turn_canceled",
]);

/** The console socket's address under the console URL `base`. */
export const consoleSocketUrl = (base: string): string => {
  const url = new URL(base.replace(/\/+$/, "") + CONSOLE_SOCKET_PATH);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
};

/**
 * Runs one command line, writing what it prints through `print` and what it
 * reports through `report`, and answers with its exit code.
 */
export const runConsoleCall = async (
  args: readonly string[],
  print: (line: string) => void,
  report: (line: string) => void,
): Promise<number> => {
  const [base, verb, ...rest] = args;
  if (base === undefined || verb === undefined) {
    report(USAGE);
    return 2;
  }
  const socket = new ConsoleSocket(consoleSocketUrl(base));
  try {
    if (verb === "follow") {
      const [sessionId, turnId] = rest;
      if (sessionId === undefined || rest.length > 2) {
        report(USAGE);
        return 2;
      }
      const done = Promise.withResolvers<number>();
      let finished = false;
      const subscription = socket.subscribe(
        { sessionId, ...(turnId !== undefined ? { turnId } : {}) },
        (envelope) => {
          print(JSON.stringify(envelope));
          if (turnId !== undefined && TURN_ENDS.has(envelope.event.kind)) {
            finished = true;
            done.resolve(0);
          }
        },
      );
      void subscription.ended.then((end) => {
        // A subscription that ends after its turn did is the socket closing
        // behind a finished command, which is nothing to report.
        if (!finished) {
          report(end.reason);
          done.resolve(turnId === undefined ? 0 : 1);
        }
      });
      return await done.promise;
    }
    if ((verb !== "GET" && verb !== "POST") || rest.length < 1) {
      report(USAGE);
      return 2;
    }
    const [path, body] = rest;
    if (
      rest.length > 2 || (verb === "GET" && body !== undefined) ||
      (verb === "POST" && body === undefined)
    ) {
      report(USAGE);
      return 2;
    }
    let response: Response;
    try {
      response = await socket.request(
        verb,
        path,
        body === undefined ? undefined : JSON.parse(body),
      );
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
      return 1;
    }
    print(await response.text());
    if (!response.ok) {
      report(`the console answered ${response.status}`);
      return 1;
    }
    return 0;
  } finally {
    socket.close();
    await socket.closed;
  }
};

if (import.meta.main) {
  Deno.exit(
    await runConsoleCall(
      Deno.args,
      (line) => console.log(line),
      (line) => console.error(line),
    ),
  );
}
