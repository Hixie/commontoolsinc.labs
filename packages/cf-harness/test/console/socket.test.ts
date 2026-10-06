import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { ConsoleServer } from "../../console/server.ts";
import {
  type ConsoleSocketServerFrame,
  readConsoleSocketClientFrame,
} from "../../console/socket-protocol.ts";
import { ConsoleSocket } from "../../console/src/socket.ts";
import type { ConsoleChatEventEnvelope } from "../../console/turn-result.ts";
import {
  type HarnessInteractiveChatEventListener,
  HarnessInteractiveChatService,
} from "../../src/interactive-chat-service.ts";
import type {
  BrowserHostResult,
  HarnessBrowserHost,
} from "../../src/contracts/browser-host.ts";
import {
  createHarnessChatErrorResponse,
  createHarnessChatEventEnvelope,
  createHarnessChatOkResponse,
  type HarnessChatResponse,
  type HarnessChatStartTurnParams,
  type HarnessChatTurnStatus,
} from "../../src/contracts/interactive-chat.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";
import { artifactLoop } from "./turn-artifacts.ts";
import { answeringLoop, serveConsole } from "../support/console-serving.ts";
import { connectToConsole } from "../support/console-connection.ts";

/** One console serving on a loopback port, and what reaches it. */
interface Serving {
  server: ConsoleServer;
  socketUrl: string;
  open(): ConsoleSocket;
}

const PAGE = { url: "https://shop.example/", title: "Shop" };

describe("console socket", () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  /** Serves a console, closing it when the test ends. */
  const serve = async (
    ...args: Parameters<typeof serveConsole>
  ): Promise<Serving> => {
    const serving = await serveConsole(...args);
    cleanups.push(() => serving.stop());
    return {
      server: serving.server,
      socketUrl: serving.socketUrl,
      open: () => {
        const socket = new ConsoleSocket(serving.socketUrl);
        cleanups.push(() => closed(socket));
        return socket;
      },
    };
  };

  /** Closes `socket`, resolving once it has closed. */
  const closed = async (socket: ConsoleSocket): Promise<void> => {
    socket.close();
    await socket.closed;
  };

  /** A raw socket's frames, as they arrive, and a way to send to it. */
  const rawSocket = async (url: string) => {
    const socket = new WebSocket(url);
    const frames: ConsoleSocketServerFrame[] = [];
    const waiters: (() => void)[] = [];
    socket.addEventListener("message", (message) => {
      frames.push(JSON.parse(message.data));
      for (const waiter of waiters.splice(0)) waiter();
    });
    const closedSocket = Promise.withResolvers<void>();
    socket.addEventListener("close", () => closedSocket.resolve());
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    cleanups.push(async () => {
      socket.close();
      await closedSocket.promise;
    });
    return {
      socket,
      closed: closedSocket.promise,
      send: (frame: unknown) => socket.send(JSON.stringify(frame)),
      /**
       * What `pick` makes of the first frame it makes something of, once one
       * has arrived.
       */
      next: async <Picked>(
        pick: (frame: ConsoleSocketServerFrame) => Picked | undefined,
      ): Promise<Picked> => {
        for (;;) {
          for (const [index, frame] of frames.entries()) {
            const picked = pick(frame);
            if (picked !== undefined) {
              frames.splice(index, 1);
              return picked;
            }
          }
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      },
    };
  };

  /** The envelopes a subscription delivers, up to one of `finalKind`. */
  const envelopesUntil = (
    socket: ConsoleSocket,
    request: { sessionId?: string; turnId?: string; afterSequence?: number },
    finalKind: string,
  ): Promise<readonly ConsoleChatEventEnvelope[]> => {
    const envelopes: ConsoleChatEventEnvelope[] = [];
    const done = Promise.withResolvers<readonly ConsoleChatEventEnvelope[]>();
    const subscription = socket.subscribe(request, (envelope) => {
      envelopes.push(envelope);
      if (envelope.event.kind === finalKind) {
        subscription.close();
        done.resolve(envelopes);
      }
    });
    void subscription.ended.then((end) => {
      if (end.reason !== "the subscription was closed") {
        done.reject(new Error(end.reason));
      }
    });
    return done.promise;
  };

  const startTask = async (
    socket: ConsoleSocket,
    body: Record<string, unknown>,
  ): Promise<{ sessionId: string; turnId: string; browserHost?: true }> => {
    const response = await socket.request("POST", "/api/task", body);
    expect(response.status).toBe(200);
    return await response.json();
  };

  describe("requests", () => {
    it("answers a request with the status and body its route answers", async () => {
      const { open, server } = await serve();
      const socket = open();

      const health = await socket.request("GET", "/api/health");
      const status = await socket.request("GET", "/api/status");
      const missing = await socket.request("GET", "/api/nothing-here");

      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true });
      expect(await status.json()).toEqual(
        await (await server.route(
          new Request("http://127.0.0.1/api/status"),
        )).json(),
      );
      expect(missing.status).toBe(404);
    });

    it("answers a request it cannot read as a 400 under its own id, and a frame with no id with an error", async () => {
      const { socketUrl } = await serve();
      const raw = await rawSocket(socketUrl);

      raw.send({ type: "request", id: "a", method: "PUT", path: "/api/task" });
      raw.send({ type: "request", id: "b", method: "GET", path: "/live/x" });
      raw.send({ type: "request", method: "GET", path: "/api/health" });
      raw.send({ type: "teleport", id: "d" });

      for (const id of ["a", "b"]) {
        expect(
          await raw.next((frame) =>
            frame.type === "response" && frame.id === id ? frame : undefined
          ),
        ).toMatchObject({ type: "response", id, status: 400 });
      }
      expect(
        await raw.next((frame) => frame.type === "error" ? frame : undefined),
      ).toEqual({
        type: "error",
        message: "a socket frame names no id",
      });
      expect(
        await raw.next((frame) => frame.type === "error" ? frame : undefined),
      ).toEqual({
        type: "error",
        message: "a socket frame has the unknown type teleport",
      });
    });
  });

  describe("subscriptions", () => {
    it("delivers a session's recorded events and then its live ones, the completed turn carrying its result", async () => {
      const release = Promise.withResolvers<string>();
      const { open } = await serve(answeringLoop(() => release.promise));
      const socket = open();
      const started = await startTask(socket, { text: "track my books" });
      const recorded = await envelopesUntil(
        socket,
        { sessionId: started.sessionId },
        "turn_started",
      );

      const live = envelopesUntil(
        socket,
        {
          sessionId: started.sessionId,
          afterSequence: recorded.at(-1)!.sequence,
        },
        "turn_completed",
      );
      release.resolve("built it");
      const delivered = await live;

      expect(recorded.map((envelope) => envelope.event.kind)).toContain(
        "session_started",
      );
      expect(delivered[0].sequence).toBeGreaterThan(recorded.at(-1)!.sequence);
      const sequences = delivered.map((envelope) => envelope.sequence);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      const completed = delivered.at(-1)!.event;
      expect(completed.kind).toBe("turn_completed");
      expect(completed.kind === "turn_completed" && completed.result)
        .toMatchObject({ sessionId: started.sessionId, finalText: "built it" });
    });

    it("replays a session's whole history from sequence zero, and no other session's", async () => {
      const { open, server } = await serve();
      const socket = open();
      const first = await startTask(socket, { text: "first task" });
      await server.service.waitForTurn(first.sessionId, first.turnId);
      const second = await startTask(socket, { text: "second task" });
      await server.service.waitForTurn(second.sessionId, second.turnId);

      const replayed = await envelopesUntil(
        socket,
        { sessionId: second.sessionId, afterSequence: 0 },
        "turn_completed",
      );

      expect(replayed.map((envelope) => envelope.event.kind)).toEqual([
        "session_started",
        "turn_started",
        "assistant_delta",
        "assistant_completed",
        "turn_completed",
      ]);
      expect(
        replayed.every((envelope) => envelope.sessionId === second.sessionId),
      ).toBe(true);
    });

    it("delivers only the named turn's events to a subscription that names one", async () => {
      const { open, server } = await serve();
      const socket = open();
      const first = await startTask(socket, { text: "first" });
      await server.service.waitForTurn(first.sessionId, first.turnId);
      const second = await startTask(socket, {
        text: "second",
        sessionId: first.sessionId,
      });

      const delivered = await envelopesUntil(
        socket,
        { sessionId: first.sessionId, turnId: second.turnId },
        "turn_completed",
      );

      expect(delivered.length).toBeGreaterThan(1);
      expect(delivered.every((envelope) => envelope.turnId === second.turnId))
        .toBe(true);
    });

    describe("a completed turn's result", () => {
      /** The result the event that completes a turn writing `messages` carries. */
      const completedResult = async (
        messages: readonly HarnessTranscriptMessage[],
      ): Promise<unknown> => {
        const artifactRoot = await Deno.makeTempDir({
          prefix: "cf-harness-console-result-event-",
        });
        cleanups.push(() => Deno.remove(artifactRoot, { recursive: true }));
        let clock = Date.parse("2026-01-01T00:00:00.000Z");
        const { open } = await serve(
          answeringLoop(),
          ["--artifact-root", artifactRoot],
          (onEvent) =>
            new HarnessInteractiveChatService({
              basePromptLoopOptions: { artifactRoot },
              createPromptLoop: artifactLoop(messages, () => clock += 1750),
              now: () => new Date(clock).toISOString(),
              onEvent,
              runIdForTurn: (_sessionId, turnId) => turnId,
            }),
        );
        const socket = open();
        const started = await startTask(socket, { text: "track my books" });
        const completed = (await envelopesUntil(
          socket,
          { sessionId: started.sessionId },
          "turn_completed",
        )).at(-1)!.event;
        return completed.kind === "turn_completed" ? completed.result : {};
      };

      it("carries the pieces the turn named", async () => {
        expect(
          await completedResult([
            {
              role: "assistant",
              content: "",
              toolCalls: [{
                id: "call-1",
                type: "function",
                function: { name: "assign_slug", arguments: "{}" },
              }],
            },
            {
              role: "tool",
              toolCallId: "call-1",
              toolName: "assign_slug",
              content: JSON.stringify({
                outputId: "run:assign_slug:1",
                status: "ok",
                slug: "reading-list",
                url: "http://localhost:8000/console-test/reading-list",
              }),
            },
            { role: "assistant", content: "built it" },
          ]),
        ).toEqual({
          looms: [],
          pieces: [{
            slug: "reading-list",
            url: "http://localhost:8000/console-test/reading-list",
          }],
          spaceName: "console-test",
          outcome: "completed",
          sessionId: expect.any(String),
          continuable: true,
          finalText: "built it",
          elapsedMs: 1750,
        });
      });

      it("carries `pieces: []` when the turn assigned no slug", async () => {
        expect(
          await completedResult([
            { role: "assistant", content: "calculated it" },
          ]),
        ).toEqual({
          looms: [],
          pieces: [],
          spaceName: "console-test",
          outcome: "completed",
          sessionId: expect.any(String),
          continuable: true,
          finalText: "calculated it",
          elapsedMs: 1750,
        });
      });
    });

    it("sends a subscription ended before its recorded events were read none of them", async () => {
      const replaying = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      /** A service whose first replay answers only once the test releases it. */
      class GatedReplayService extends HarnessInteractiveChatService {
        #gated = true;

        override async listEventsForReplay(
          ...args: Parameters<
            HarnessInteractiveChatService["listEventsForReplay"]
          >
        ): ReturnType<HarnessInteractiveChatService["listEventsForReplay"]> {
          if (this.#gated) {
            this.#gated = false;
            replaying.resolve();
            await release.promise;
          }
          return await super.listEventsForReplay(...args);
        }
      }
      const { server } = await serve(
        answeringLoop(),
        [],
        (onEvent) =>
          new GatedReplayService({
            createPromptLoop: answeringLoop(),
            onEvent,
          }),
      );
      const started = await connectToConsole(server).request(
        "POST",
        "/api/task",
        { text: "track my books" },
      );
      const { sessionId, turnId } = await started.json();
      await server.service.waitForTurn(sessionId, turnId);
      const frames: ConsoleSocketServerFrame[] = [];
      const ended = Promise.withResolvers<void>();
      const connection = server.connect((frame) => {
        frames.push(frame);
        if (
          frame.type === "event" && frame.subscription === "after" &&
          frame.envelope.event.kind === "turn_completed"
        ) {
          ended.resolve();
        }
        return true;
      });

      connection.receive(
        JSON.stringify({ type: "subscribe", id: "before", sessionId }),
      );
      await replaying.promise;
      connection.receive(JSON.stringify({ type: "unsubscribe", id: "before" }));
      release.resolve();
      connection.receive(
        JSON.stringify({ type: "subscribe", id: "after", sessionId }),
      );
      await ended.promise;

      expect(
        frames.filter((frame) =>
          frame.type === "event" && frame.subscription === "before"
        ),
      ).toEqual([]);
    });

    it("ends a subscription it cannot read with the reason, under its own id", async () => {
      const { socketUrl } = await serve();
      const raw = await rawSocket(socketUrl);

      raw.send({ type: "subscribe", id: "s", afterSequence: -1 });

      expect(
        await raw.next((frame) =>
          frame.type === "unsubscribed" ? frame : undefined
        ),
      ).toEqual({
        type: "unsubscribed",
        subscription: "s",
        error: "subscription s: afterSequence must be a non-negative integer",
      });
    });
  });

  describe("plain HTTP", () => {
    it("answers only health and the socket among the routes", async () => {
      const { server, socketUrl } = await serve();
      const origin = `http://127.0.0.1:${new URL(socketUrl).port}`;
      const get = (path: string) => server.handle(new Request(origin + path));

      expect((await get("/api/health")).status).toBe(200);
      expect((await get("/api/status")).status).toBe(404);
      expect((await get("/api/events?sessionId=x")).status).toBe(404);
      expect(
        (await server.handle(
          new Request(`${origin}/api/task`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "no" }),
          }),
        )).status,
      ).toBe(404);
      expect(server.service.turns()).toHaveLength(0);
    });

    it("admits a socket the console's own page opens, under either of its names", async () => {
      const { socketUrl } = await serve();
      const port = Number(new URL(socketUrl).port);
      /** The status line a raw handshake carrying `origin` is answered with. */
      const handshake = async (origin: string): Promise<string> => {
        const connection = await Deno.connect({ hostname: "127.0.0.1", port });
        try {
          await connection.write(new TextEncoder().encode(
            `GET /api/socket HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
              "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
              `Sec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`,
          ));
          const reader = connection.readable.pipeThrough(
            new TextDecoderStream(),
          ).getReader();
          let head = "";
          while (!head.includes("\r\n")) {
            const chunk = await reader.read();
            if (chunk.done) break;
            head += chunk.value;
          }
          await reader.cancel();
          return head.split("\r\n")[0];
        } finally {
          try {
            connection.close();
          } catch {
            // The reader's cancel already closed it.
          }
        }
      };

      const numbered = await handshake(`http://127.0.0.1:${port}`);
      const named = await handshake(`http://localhost:${port}`);
      const neighbor = await handshake(`http://127.0.0.1:${port + 1}`);

      expect(numbered).toBe("HTTP/1.1 101 Switching Protocols");
      expect(named).toBe("HTTP/1.1 101 Switching Protocols");
      expect(neighbor).toBe("HTTP/1.1 403 Forbidden");
    });

    it("refuses a socket a page of another origin opens, and asks for an upgrade of a plain request", async () => {
      const { server, socketUrl } = await serve();
      const port = new URL(socketUrl).port;
      const open = (headers: Record<string, string>) =>
        server.handle(
          new Request(`http://127.0.0.1:${port}/api/socket`, { headers }),
        );

      const foreign = await open({
        upgrade: "websocket",
        origin: "https://evil.example",
      });
      const crossSite = await open({
        upgrade: "websocket",
        "sec-fetch-site": "cross-site",
      });
      const plain = await open({});

      expect(foreign.status).toBe(403);
      expect(crossSite.status).toBe(403);
      expect(plain.status).toBe(426);
    });
  });

  describe("browser hosts", () => {
    /**
     * A console whose turns ask their browser host for a snapshot and answer
     * with what the host returned.
     */
    const hostedServe = async () => {
      const results: (BrowserHostResult | undefined)[] = [];
      const serving = await serve(
        answeringLoop(async (options) => {
          const result = await options.browserHost?.perform({
            action: "snapshot",
            interactive: true,
          });
          results.push(result);
          return result?.status === "ok"
            ? result.text ?? ""
            : `refused: ${result?.status}`;
        }),
        ["--allow-browser-host"],
      );
      return { ...serving, results };
    };

    /** Starts a hosted turn over `host`, and answers with the task's answer. */
    const startHosted = async (
      host: Awaited<ReturnType<typeof rawSocket>>,
    ): Promise<{ sessionId: string; turnId: string; browserHost?: true }> => {
      host.send({
        type: "request",
        id: "task",
        method: "POST",
        path: "/api/task",
        body: { text: "use the web", browserHost: {} },
      });
      const started = await host.next((frame) =>
        frame.type === "response" && frame.id === "task" ? frame : undefined
      );
      return JSON.parse(started.body);
    };

    /** Attaches `host` to `turnId`, answering with the route's status. */
    const attach = async (
      host: Awaited<ReturnType<typeof rawSocket>>,
      turnId: string,
      id: string,
    ): Promise<number> => {
      host.send({
        type: "request",
        id,
        method: "POST",
        path: "/api/browser-host/attach",
        body: { turnId },
      });
      const answer = await host.next((frame) =>
        frame.type === "response" && frame.id === id ? frame : undefined
      );
      return answer.status;
    };

    it("sends a hosted turn's operations to the socket that started it once it attaches, and takes the answer only from that socket", async () => {
      const { socketUrl, server, results } = await hostedServe();
      const host = await rawSocket(socketUrl);
      const other = await rawSocket(socketUrl);
      const body = await startHosted(host);
      const foreignAttach = await attach(other, body.turnId, "other-attach");
      const attached = await attach(host, body.turnId, "attach");
      const again = await attach(host, body.turnId, "again");
      const operation = await host.next((frame) =>
        frame.type === "browser-host-request" ? frame : undefined
      );
      const answer = (socket: typeof host, id: string, result: unknown) =>
        socket.send({
          type: "request",
          id,
          method: "POST",
          path: "/api/browser-host/result",
          body: { turnId: body.turnId, id: "1", result },
        });

      answer(other, "forged", { status: "ok", page: PAGE, text: "forged" });
      const forged = await other.next((frame) =>
        frame.type === "response" ? frame : undefined
      );
      answer(host, "answered", { status: "ok", page: PAGE, text: "Buy" });
      const answered = await host.next((frame) =>
        frame.type === "response" ? frame : undefined
      );
      const closing = await host.next((frame) =>
        frame.type === "browser-host-close" ? frame : undefined
      );
      await server.service.waitForTurn(body.sessionId, body.turnId);

      expect(body.browserHost).toBe(true);
      expect([foreignAttach, attached, again]).toEqual([404, 200, 409]);
      expect(operation).toEqual({
        type: "browser-host-request",
        turnId: body.turnId,
        id: "1",
        operation: { action: "snapshot", interactive: true },
      });
      expect(forged).toMatchObject({ status: 404 });
      expect(answered).toMatchObject({ status: 200 });
      expect(closing).toEqual({
        type: "browser-host-close",
        turnId: body.turnId,
      });
      expect(results).toEqual([{ status: "ok", page: PAGE, text: "Buy" }]);
    });

    it("answers 400 for a result that is not one, which fails the operation, and 404 for an id nobody waits on", async () => {
      const { socketUrl, server, results } = await hostedServe();
      const raw = await rawSocket(socketUrl);
      const body = await startHosted(raw);
      await attach(raw, body.turnId, "attach");
      await raw.next((frame) =>
        frame.type === "browser-host-request" ? frame : undefined
      );
      const post = (id: string, operationId: string, result: unknown) =>
        raw.send({
          type: "request",
          id,
          method: "POST",
          path: "/api/browser-host/result",
          body: { turnId: body.turnId, id: operationId, result },
        });

      post("unknown", "2", { status: "ok", page: PAGE });
      const unknown = await raw.next((frame) =>
        frame.type === "response" && frame.id === "unknown" ? frame : undefined
      );
      post("malformed", "1", { status: "ok" });
      const malformed = await raw.next((frame) =>
        frame.type === "response" && frame.id === "malformed"
          ? frame
          : undefined
      );
      await server.service.waitForTurn(body.sessionId, body.turnId);

      expect(unknown).toMatchObject({ status: 404 });
      expect(malformed).toMatchObject({ status: 400 });
      expect(results).toEqual([{
        status: "failed",
        message:
          "the browser host answered with something that is not a result",
      }]);
    });

    it("settles a hosted turn's operations as session-ended when its host detaches, and keeps the socket open", async () => {
      const { socketUrl, server, results } = await hostedServe();
      const host = await rawSocket(socketUrl);
      const body = await startHosted(host);
      await attach(host, body.turnId, "attach");
      await host.next((frame) =>
        frame.type === "browser-host-request" ? frame : undefined
      );
      const call = async (
        id: string,
        method: "GET" | "POST",
        path: string,
        request?: unknown,
      ) => {
        host.send({
          type: "request",
          id,
          method,
          path,
          ...(request !== undefined ? { body: request } : {}),
        });
        return await host.next((frame) =>
          frame.type === "response" && frame.id === id ? frame : undefined
        );
      };

      const detached = await call(
        "detach",
        "POST",
        "/api/browser-host/detach",
        {
          turnId: body.turnId,
        },
      );
      await server.service.waitForTurn(body.sessionId, body.turnId);
      const after = await call("after", "GET", "/api/health");
      const again = await attach(host, body.turnId, "again");

      expect(detached.status).toBe(200);
      expect(results).toEqual([{
        status: "session-ended",
        message: "the browser host's connection ended",
      }]);
      expect(after.status).toBe(200);
      expect(again).toBe(404);
    });

    it("settles a hosted turn's operations as session-ended when its socket closes", async () => {
      const { socketUrl, server, results } = await hostedServe();
      const host = await rawSocket(socketUrl);
      const body = await startHosted(host);

      host.socket.close();
      await host.closed;
      await server.service.waitForTurn(body.sessionId, body.turnId);

      expect(results).toEqual([{
        status: "session-ended",
        message: "the browser host's connection ended",
      }]);
    });

    it("answers 400 for a host call that names no turn, and 404 for one on a turn with no host", async () => {
      const { socketUrl, server, open } = await hostedServe();
      const raw = await rawSocket(socketUrl);
      const plain = await startTask(open(), { text: "no browser" });
      await server.service.waitForTurn(plain.sessionId, plain.turnId);
      const call = async (id: string, path: string, body: unknown) => {
        raw.send({ type: "request", id, method: "POST", path, body });
        return await raw.next((frame) =>
          frame.type === "response" && frame.id === id ? frame : undefined
        );
      };

      const noTurn = await call("a", "/api/browser-host/attach", {});
      const notJson = await call("b", "/api/browser-host/result", "turn");
      const unhosted = await call("c", "/api/browser-host/attach", {
        turnId: plain.turnId,
      });

      expect(noTurn).toMatchObject({
        status: 400,
        body: JSON.stringify({ error: "turnId is required" }),
      });
      expect(notJson.status).toBe(400);
      expect(unhosted).toMatchObject({
        status: 404,
        body: JSON.stringify({ error: "no browser host for that turn" }),
      });
    });

    it("ends a turn's channel when the turn ends before its start returns, and when it fails to start or throws", async () => {
      const attached: (HarnessBrowserHost | undefined)[] = [];
      /** A service whose turn ends inside its own start, or never starts. */
      class ShortTurnService extends HarnessInteractiveChatService {
        readonly #onEvent: HarnessInteractiveChatEventListener;
        readonly #start: "ends" | "refuses" | "throws";

        constructor(
          onEvent: HarnessInteractiveChatEventListener,
          start: "ends" | "refuses" | "throws",
        ) {
          super({
            createPromptLoop: () => {
              throw new Error("no turn runs here");
            },
            onEvent,
          });
          this.#onEvent = onEvent;
          this.#start = start;
        }

        override async startTurn(
          requestId: string,
          params: HarnessChatStartTurnParams,
          extra: { browserHost?: HarnessBrowserHost } = {},
        ): Promise<HarnessChatResponse<HarnessChatTurnStatus>> {
          attached.push(extra.browserHost);
          const turnId = params.turnId ?? "";
          if (this.#start === "throws") {
            throw new Error("this turn could not be started");
          }
          if (this.#start === "refuses") {
            return createHarnessChatErrorResponse(requestId, {
              code: "invalid_request",
              message: "this turn does not start",
            });
          }
          await this.#onEvent(createHarnessChatEventEnvelope({
            sessionId: params.sessionId,
            turnId,
            sequence: 1,
            event: { kind: "turn_canceled", turnId },
          }));
          const at = new Date().toISOString();
          return createHarnessChatOkResponse(requestId, {
            turnId,
            status: "canceled",
            startedAt: at,
            updatedAt: at,
          });
        }
      }
      const task = async (start: "ends" | "refuses" | "throws") => {
        const { open } = await serve(
          answeringLoop(),
          ["--allow-browser-host"],
          (onEvent) => new ShortTurnService(onEvent, start),
        );
        const socket = open();
        const response = await socket.request("POST", "/api/task", {
          text: "use the web",
          browserHost: {},
        });
        return { socket, response };
      };

      const ended = await task("ends");
      const started = await ended.response.json();
      const attach = await ended.socket.request(
        "POST",
        "/api/browser-host/attach",
        { turnId: started.turnId },
      );
      const refused = await task("refuses");
      const thrown = await task("throws");

      expect(attach.status).toBe(404);
      expect(refused.response.ok).toBe(false);
      expect(thrown.response.status).toBe(500);
      expect(attached).toHaveLength(3);
      for (const host of attached) {
        expect(await host?.perform({ action: "reload" })).toEqual({
          status: "session-ended",
          message: "the turn has ended",
        });
      }
    });

    it("ends a hosted turn's channel when its socket closes while the session is still starting", async () => {
      const sessionStarting = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const results: (BrowserHostResult | undefined)[] = [];
      /** A service whose sessions start only once the test releases them. */
      class GatedSessionService extends HarnessInteractiveChatService {
        override async startSession(
          ...args: Parameters<HarnessInteractiveChatService["startSession"]>
        ): ReturnType<HarnessInteractiveChatService["startSession"]> {
          sessionStarting.resolve();
          await release.promise;
          return await super.startSession(...args);
        }
      }
      const { server } = await serve(
        answeringLoop(),
        ["--allow-browser-host"],
        (onEvent) =>
          new GatedSessionService({
            createPromptLoop: answeringLoop(async (options) => {
              const result = await options.browserHost?.perform({
                action: "reload",
              });
              results.push(result);
              return "done";
            }),
            onEvent,
          }),
      );
      const client = connectToConsole(server);
      const started = client.request("POST", "/api/task", {
        text: "use the web",
        browserHost: {},
      });
      await sessionStarting.promise;

      client.close();
      release.resolve();
      const body = await (await started).json();
      await server.service.waitForTurn(body.sessionId, body.turnId);

      expect(results).toEqual([{
        status: "session-ended",
        message: "the browser host's connection ended",
      }]);
    });

    it("answers 400 for a host declared over no socket", async () => {
      const { server } = await hostedServe();

      const response = await server.route(
        new Request("http://127.0.0.1/api/task", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "use the web", browserHost: {} }),
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "a browser host is declared over the console socket",
      });
      expect(server.service.turns()).toHaveLength(0);
    });
  });

  describe("readConsoleSocketClientFrame()", () => {
    it("reads each kind of client frame, and refuses a GET that carries a body", () => {
      expect(readConsoleSocketClientFrame(JSON.stringify({
        type: "request",
        id: "1",
        method: "POST",
        path: "/api/task",
        body: { text: "x" },
      }))).toEqual({
        ok: true,
        frame: {
          type: "request",
          id: "1",
          method: "POST",
          path: "/api/task",
          body: { text: "x" },
        },
      });
      expect(readConsoleSocketClientFrame(JSON.stringify({
        type: "subscribe",
        id: "2",
        sessionId: "s",
        turnId: "t",
        afterSequence: 4,
        unknownField: true,
      }))).toEqual({
        ok: true,
        frame: {
          type: "subscribe",
          id: "2",
          sessionId: "s",
          turnId: "t",
          afterSequence: 4,
        },
      });
      expect(readConsoleSocketClientFrame('{"type":"unsubscribe","id":"2"}'))
        .toEqual({ ok: true, frame: { type: "unsubscribe", id: "2" } });
      expect(readConsoleSocketClientFrame(JSON.stringify({
        type: "request",
        id: "3",
        method: "GET",
        path: "/api/health",
        body: {},
      }))).toEqual({
        ok: false,
        answer: {
          type: "response",
          id: "3",
          status: 400,
          body: JSON.stringify({
            error: "request 3 is a GET, which carries no body",
          }),
        },
      });
      expect(readConsoleSocketClientFrame("[")).toEqual({
        ok: false,
        answer: { type: "error", message: "a socket message is not JSON" },
      });
    });
  });
});
