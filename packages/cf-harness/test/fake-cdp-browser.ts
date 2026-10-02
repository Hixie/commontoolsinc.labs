/**
 * A stand-in for a browser's DevTools endpoint: enough of the protocol for a
 * navigation guard to attach to its pages and decide their navigations.
 *
 * It answers every command with an empty result and records it. A test opens
 * a page, which the endpoint announces to every attached client as waiting
 * for one, and starts a navigation on it, which it holds until a client
 * continues or fails it.
 */

/** One command a client sent. */
export interface FakeCdpCommand {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** A browser's DevTools endpoint, served on this device. */
export class FakeCdpBrowser {
  readonly commands: FakeCdpCommand[] = [];
  readonly #server: Deno.HttpServer<Deno.NetAddr>;
  readonly #sockets = new Set<WebSocket>();
  readonly #commandWaiters: {
    matches(command: FakeCdpCommand): boolean;
    resolve(command: FakeCdpCommand): void;
  }[] = [];
  readonly #clientWaiters: (() => void)[] = [];
  #nextSession = 0;
  #nextRequest = 0;

  constructor() {
    this.#server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      (request) => this.#serve(request),
    );
  }

  /** The endpoint's origin, as a lease names it. */
  get origin(): string {
    return `http://127.0.0.1:${this.#server.addr.port}`;
  }

  /** Resolves once a client is connected. */
  connected(): Promise<void> {
    return this.#sockets.size > 0
      ? Promise.resolve()
      : new Promise((resolve) => this.#clientWaiters.push(resolve));
  }

  /**
   * Resolves with the first command named `method` a client sends from now
   * on, or the earliest already received when `includeReceived` holds.
   */
  command(method: string, includeReceived = false): Promise<FakeCdpCommand> {
    const received = includeReceived
      ? this.commands.find((command) => command.method === method)
      : undefined;
    return received !== undefined
      ? Promise.resolve(received)
      : this.#next((command) => command.method === method);
  }

  /**
   * Announces a page, held until a client lets it run, and returns its
   * session id once a client has enabled request holding on it.
   */
  async openPage(targetId: string): Promise<string> {
    const sessionId = `session-${++this.#nextSession}`;
    const enabled = this.command("Fetch.enable");
    this.#broadcast({
      method: "Target.attachedToTarget",
      params: {
        sessionId,
        targetInfo: { targetId, type: "page", url: "about:blank" },
        waitingForDebugger: true,
      },
    });
    await enabled;
    return sessionId;
  }

  /**
   * Starts a document request to `url` in frame `frameId` of the page
   * `sessionId` attaches, and resolves with what a client decided.
   */
  async navigate(
    sessionId: string,
    frameId: string,
    url: string,
  ): Promise<"continued" | "failed"> {
    const requestId = `request-${++this.#nextRequest}`;
    const decided = this.#next((command) =>
      (command.method === "Fetch.continueRequest" ||
        command.method === "Fetch.failRequest") &&
      command.params.requestId === requestId
    );
    this.#broadcast({
      method: "Fetch.requestPaused",
      sessionId,
      params: {
        requestId,
        frameId,
        resourceType: "Document",
        request: { url, method: "GET", headers: {} },
      },
    });
    return (await decided).method === "Fetch.continueRequest"
      ? "continued"
      : "failed";
  }

  /** Disconnects every client. */
  disconnect(): void {
    for (const socket of this.#sockets) {
      socket.close();
    }
  }

  /** Disconnects every client and stops serving. */
  async close(): Promise<void> {
    this.disconnect();
    await this.#server.shutdown();
  }

  #next(
    matches: (command: FakeCdpCommand) => boolean,
  ): Promise<FakeCdpCommand> {
    return new Promise((resolve) =>
      this.#commandWaiters.push({ matches, resolve })
    );
  }

  #serve(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname === "/json/version") {
      return Response.json({
        webSocketDebuggerUrl:
          `ws://127.0.0.1:${this.#server.addr.port}/devtools/browser/fake`,
      });
    }
    const { socket, response } = Deno.upgradeWebSocket(request);
    socket.addEventListener("open", () => {
      this.#sockets.add(socket);
      for (const waiter of this.#clientWaiters.splice(0)) {
        waiter();
      }
    });
    socket.addEventListener("close", () => this.#sockets.delete(socket));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const command: FakeCdpCommand = {
        method: message.method,
        params: message.params ?? {},
        ...(message.sessionId !== undefined
          ? { sessionId: message.sessionId }
          : {}),
      };
      this.commands.push(command);
      socket.send(JSON.stringify({
        id: message.id,
        result: {},
        ...(message.sessionId !== undefined
          ? { sessionId: message.sessionId }
          : {}),
      }));
      const waiters = this.#commandWaiters.filter((waiter) =>
        waiter.matches(command)
      );
      for (const waiter of waiters) {
        this.#commandWaiters.splice(this.#commandWaiters.indexOf(waiter), 1);
        waiter.resolve(command);
      }
    });
    return response;
  }

  #broadcast(message: Record<string, unknown>): void {
    for (const socket of this.#sockets) {
      socket.send(JSON.stringify(message));
    }
  }
}
