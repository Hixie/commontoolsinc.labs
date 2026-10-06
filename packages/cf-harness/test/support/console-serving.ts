/**
 * A console served on a loopback port the system chose, for tests that reach
 * it the way a client does: over a real socket.
 */

import { ConsoleServer, resolveConsoleConfig } from "../../console/server.ts";
import {
  type HarnessInteractiveChatEventListener,
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../../src/interactive-chat-service.ts";
import type {
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../../src/prompt-loop.ts";

/** A loop that answers the task it was given, after `before` settles. */
export const answeringLoop = (
  before: (
    options: Parameters<HarnessInteractivePromptLoopFactory>[0],
  ) => Promise<string> = () => Promise.resolve("built it"),
): HarnessInteractivePromptLoopFactory =>
(loopOptions) => ({
  runTranscript: async (
    options: RunHarnessTranscriptOptions,
  ): Promise<HarnessPromptLoopResult> => {
    const answer = {
      role: "assistant" as const,
      content: await before(loopOptions),
    };
    const transcript = [...options.transcript, answer];
    await options.onTranscriptEvent?.({ message: answer, transcript });
    return {
      model: "gpt-test",
      finalAssistantText: answer.content,
      transcript,
      modelTurns: 1,
      runState: {} as HarnessPromptLoopResult["runState"],
    };
  },
});

/**
 * Serves a console configured for the port it is served on, so its `Host`
 * gate admits what reaches it there. `stop` shuts it down.
 */
export const serveConsole = async (
  loop: HarnessInteractivePromptLoopFactory = answeringLoop(),
  flags: readonly string[] = [],
  createService: (
    onEvent: HarnessInteractiveChatEventListener,
  ) => HarnessInteractiveChatService = (onEvent) =>
    new HarnessInteractiveChatService({ createPromptLoop: loop, onEvent }),
): Promise<{
  server: ConsoleServer;
  url: string;
  socketUrl: string;
  stop: () => Promise<void>;
}> => {
  const ready = Promise.withResolvers<ConsoleServer>();
  const http = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => await (await ready.promise).handle(request),
  );
  const port = http.addr.port;
  const server = new ConsoleServer(
    await resolveConsoleConfig(
      [
        "--fabric-identity",
        "key.pkcs8",
        "--fabric-space",
        "console-test",
        "--session-db",
        "none",
        "--port",
        String(port),
        ...flags,
      ],
      {},
      "/console",
    ),
    createService,
  );
  ready.resolve(server);
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    socketUrl: `ws://127.0.0.1:${port}/api/socket`,
    stop: () => http.shutdown(),
  };
};
