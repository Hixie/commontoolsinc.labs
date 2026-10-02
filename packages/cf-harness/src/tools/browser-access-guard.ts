/**
 * The navigation guard of a Browser Access lease: the part of the browser
 * host the harness itself plays when its browser is a Chrome it reaches over
 * the DevTools protocol.
 *
 * Every top-level navigation of the leased browser, whatever starts it — an
 * address the agent opened, a link it clicked, a redirect, page script — sends
 * what the session holds to its destination. The guard holds each top-level
 * document request before it leaves and lets it go only to an origin the
 * latest release decision covers; any other it fails, and remembers the
 * origin, so the action that caused it is reported as refused.
 *
 * The guard attaches to every page of the browser, those open now and those
 * opened later, and a new page waits for it before it loads anything.
 */

import {
  BROWSER_RELEASE_PUBLIC_WEB,
  type BrowserReleaseCovers,
  browserReleaseCovers,
} from "../contracts/browser-host.ts";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { HarnessBrowserAccessLease } from "../contracts/browser-access.ts";

/** One DevTools protocol message the browser sent. */
interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

/** Holds and checks the top-level navigations of one leased browser. */
export class BrowserAccessNavigationGuard {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    number,
    { resolve(result: unknown): void; reject(error: Error): void }
  >();

  /** The page each attached session drives, by session id. */
  readonly #pages = new Map<string, string>();
  #nextId = 0;
  #covers: BrowserReleaseCovers = BROWSER_RELEASE_PUBLIC_WEB;
  #refused: string[] = [];
  #ended: string | undefined;
  readonly #endedWith = Promise.withResolvers<string>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      this.#receive(event.data);
    });
    socket.addEventListener("close", () => {
      this.#end("the guard's connection to the browser closed");
    });
  }

  /**
   * Connects to the browser whose DevTools endpoint is `cdpOrigin` and
   * attaches to every page it has and every page it opens.
   */
  static async connect(
    cdpOrigin: string,
  ): Promise<BrowserAccessNavigationGuard> {
    const response = await fetch(`${cdpOrigin}/json/version`);
    const version: unknown = await response.json();
    const debuggerUrl = isObjectNotArray(version) &&
        typeof version.webSocketDebuggerUrl === "string"
      ? new URL(version.webSocketDebuggerUrl)
      : undefined;
    if (debuggerUrl === undefined) {
      throw new Error("the browser named no DevTools socket");
    }
    // The browser names its socket by the address it listens on, which is
    // not the one this side reaches it by when the two are in different
    // network namespaces.
    debuggerUrl.host = new URL(cdpOrigin).host;
    const socket = new WebSocket(debuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("the browser's DevTools socket did not open")),
        { once: true },
      );
    });
    const guard = new BrowserAccessNavigationGuard(socket);
    await guard.#send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "page" }],
    });
    return guard;
  }

  /**
   * Why the guard no longer holds the browser's navigations, or `undefined`
   * while it does.
   */
  get ended(): string | undefined {
    return this.#ended;
  }

  /** Resolves with why the guard ended, once it has. */
  get whenEnded(): Promise<string> {
    return this.#endedWith.promise;
  }

  /** Lets top-level navigations go only where `covers` says. */
  arm(covers: BrowserReleaseCovers): void {
    this.#covers = covers;
  }

  /** The origins of the navigations refused since the last call. */
  takeRefused(): readonly string[] {
    const refused = this.#refused;
    this.#refused = [];
    return refused;
  }

  /** Stops holding the browser's navigations and disconnects. */
  close(): void {
    this.#end("the guard was closed");
    this.#socket.close();
  }

  #send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    if (this.#ended !== undefined) {
      return Promise.reject(new Error(this.#ended));
    }
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({
        id,
        method,
        params,
        ...(sessionId !== undefined ? { sessionId } : {}),
      }));
    });
  }

  #receive(data: unknown): void {
    if (typeof data !== "string") {
      return;
    }
    const message = JSON.parse(data) as CdpMessage;
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        pending?.reject(
          new Error(message.error.message ?? "the browser refused a command"),
        );
      } else {
        pending?.resolve(message.result);
      }
      return;
    }
    const params = message.params ?? {};
    if (message.method === "Target.attachedToTarget") {
      this.#attached(params).catch((error) => {
        this.#end(`a page could not be guarded: ${String(error)}`);
      });
    } else if (message.method === "Target.detachedFromTarget") {
      if (typeof params.sessionId === "string") {
        this.#pages.delete(params.sessionId);
      }
    } else if (
      message.method === "Fetch.requestPaused" &&
      message.sessionId !== undefined
    ) {
      this.#paused(message.sessionId, params).catch((error) => {
        this.#end(`a navigation could not be decided: ${String(error)}`);
      });
    }
  }

  /**
   * Holds the top-level documents of a page just attached, then lets it
   * run.
   */
  async #attached(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.sessionId;
    const targetInfo = params.targetInfo;
    if (
      typeof sessionId !== "string" || !isObjectNotArray(targetInfo) ||
      typeof targetInfo.targetId !== "string"
    ) {
      return;
    }
    this.#pages.set(sessionId, targetInfo.targetId);
    await this.#send("Fetch.enable", {
      patterns: [{ resourceType: "Document", requestStage: "Request" }],
    }, sessionId);
    if (params.waitingForDebugger === true) {
      await this.#send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    }
  }

  /**
   * Decides a held document request: one for a page's own frame goes only
   * to a covered origin, and one for a frame within the page goes ahead.
   */
  async #paused(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const requestId = params.requestId;
    const request = params.request;
    if (typeof requestId !== "string" || !isObjectNotArray(request)) {
      return;
    }
    // A page's own frame has the id of the target that holds it.
    const topLevel = params.frameId === this.#pages.get(sessionId);
    const url = typeof request.url === "string" ? request.url : "";
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = "null";
    }
    if (topLevel && !browserReleaseCovers(this.#covers, origin)) {
      this.#refused.push(origin);
      await this.#send(
        "Fetch.failRequest",
        { requestId, errorReason: "BlockedByClient" },
        sessionId,
      );
      return;
    }
    await this.#send("Fetch.continueRequest", { requestId }, sessionId);
  }

  #end(reason: string): void {
    this.#ended ??= reason;
    this.#endedWith.resolve(this.#ended);
    for (const pending of this.#pending.values()) {
      pending.reject(new Error(this.#ended));
    }
    this.#pending.clear();
  }
}

/**
 * What the harness keeps about a lease's browser: where everything sent into
 * it may go, and the guard holding its navigations to that while a browser
 * child drives it.
 */
interface LeaseRelease {
  covers: BrowserReleaseCovers;
  guard?: Promise<BrowserAccessNavigationGuard>;
}

const leases = new WeakMap<HarnessBrowserAccessLease, LeaseRelease>();

/** The release state of `lease`'s browser. */
export const browserAccessReleaseOf = (
  lease: HarnessBrowserAccessLease,
): LeaseRelease => {
  let release = leases.get(lease);
  if (release === undefined) {
    release = { covers: BROWSER_RELEASE_PUBLIC_WEB };
    leases.set(lease, release);
  }
  return release;
};

/**
 * The guard holding the navigations of `lease`'s browser, reached at
 * `cdpOrigin`, armed with where the browser may go: the one already attached,
 * or a new one when there is none or the last one lost its connection.
 */
export const browserAccessGuardOf = async (
  lease: HarnessBrowserAccessLease,
  cdpOrigin: string,
): Promise<BrowserAccessNavigationGuard> => {
  const release = browserAccessReleaseOf(lease);
  const current = release.guard;
  if (current !== undefined) {
    const guard = await current.catch(() => undefined);
    if (guard !== undefined && guard.ended === undefined) {
      return guard;
    }
  }
  const connecting = BrowserAccessNavigationGuard.connect(cdpOrigin);
  release.guard = connecting;
  const guard = await connecting;
  guard.arm(release.covers);
  return guard;
};

/**
 * Disconnects the guard of `lease`'s browser, if one is attached. Where the
 * browser may go is kept for the next guard.
 */
export const closeBrowserAccessGuard = (
  lease: HarnessBrowserAccessLease,
): void => {
  const release = leases.get(lease);
  const guard = release?.guard;
  if (release === undefined || guard === undefined) {
    return;
  }
  release.guard = undefined;
  guard.then((attached) => attached.close(), () => {});
};
