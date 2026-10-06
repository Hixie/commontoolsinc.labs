/**
 * A client's end of the console socket (`../socket-protocol.ts`): requests
 * answered as `Response`s, so a caller reads them the way it would read a
 * fetch, and subscriptions to chat events. It uses nothing but the standard
 * `WebSocket`, so a page and a Deno script hold the same client.
 */

import type { ConsoleChatEventEnvelope } from "../turn-result.ts";
import {
  CONSOLE_SOCKET_PATH,
  type ConsoleSocketClientFrame,
  type ConsoleSocketMethod,
  type ConsoleSocketServerFrame,
} from "../socket-protocol.ts";
import { consolePath, pageMount } from "./mount.ts";

/** What a subscription delivers, and what it was asked for. */
export interface ConsoleSubscriptionRequest {
  sessionId?: string;
  turnId?: string;
  afterSequence?: number;
}

/**
 * How a subscription ended. `resumable` says whether it ended because a
 * socket that had opened closed: such a subscription may be taken again on a
 * fresh socket. One whose socket never opened is a console that cannot be
 * reached, and one the console ended is one it could not serve.
 */
export interface ConsoleSubscriptionEnd {
  reason: string;
  resumable: boolean;
}

/** One subscription: when it ends, and how to end it first. */
export interface ConsoleSubscription {
  readonly ended: Promise<ConsoleSubscriptionEnd>;
  close(): void;
}

interface PendingRequest {
  resolve(response: Response): void;
  reject(error: Error): void;
}

interface ActiveSubscription {
  onEvent(envelope: ConsoleChatEventEnvelope): void;
  end(end: ConsoleSubscriptionEnd): void;
}

/** One socket to the console. */
export class ConsoleSocket {
  readonly #socket: WebSocket;
  readonly #requests = new Map<string, PendingRequest>();
  readonly #subscriptions = new Map<string, ActiveSubscription>();
  readonly #opened: Promise<void>;
  readonly #closedPromise = Promise.withResolvers<string>();
  #connected = false;
  #closed: string | undefined;
  #nextId = 0;

  /** Opens a socket to the console socket at `url` (`ws:` or `wss:`). */
  constructor(url: string | URL) {
    this.#socket = new WebSocket(url);
    this.#opened = new Promise<void>((resolve, reject) => {
      this.#socket.addEventListener("open", () => {
        this.#connected = true;
        resolve();
      });
      this.#socket.addEventListener("close", () => {
        reject(new Error("the console socket did not open"));
      });
    });
    // A request made before the socket opens rejects through its own promise;
    // the shared one is only how each waits.
    this.#opened.catch(() => {});
    this.#socket.addEventListener("message", (message) => {
      if (typeof message.data === "string") {
        this.#receive(JSON.parse(message.data));
      }
    });
    this.#socket.addEventListener("close", (event) => {
      this.#closed = event.reason === ""
        ? "the console socket closed"
        : `the console socket closed: ${event.reason}`;
      for (const request of this.#requests.values()) {
        request.reject(new Error(this.#closed));
      }
      this.#requests.clear();
      for (const subscription of this.#subscriptions.values()) {
        subscription.end({ reason: this.#closed, resumable: this.#connected });
      }
      this.#subscriptions.clear();
      this.#closedPromise.resolve(this.#closed);
    });
  }

  /** Whether the socket has closed, after which it carries nothing. */
  get isClosed(): boolean {
    return this.#closed !== undefined;
  }

  /** Settles with why the socket closed, once it has. */
  get closed(): Promise<string> {
    return this.#closedPromise.promise;
  }

  /**
   * Calls one console route, and answers with what it answered. `body` is the
   * JSON a POST carries.
   */
  async request(
    method: ConsoleSocketMethod,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    await this.#opened;
    const id = String(++this.#nextId);
    const answer = new Promise<Response>((resolve, reject) => {
      this.#requests.set(id, { resolve, reject });
    });
    this.#send({
      type: "request",
      id,
      method,
      path,
      ...(body !== undefined ? { body } : {}),
    });
    return await answer;
  }

  /**
   * Subscribes to chat events, calling `onEvent` with each in sequence
   * order, the recorded ones first.
   */
  subscribe(
    request: ConsoleSubscriptionRequest,
    onEvent: (envelope: ConsoleChatEventEnvelope) => void,
  ): ConsoleSubscription {
    const id = String(++this.#nextId);
    let end!: (end: ConsoleSubscriptionEnd) => void;
    const ended = new Promise<ConsoleSubscriptionEnd>((resolve) => {
      end = resolve;
    });
    if (this.#closed !== undefined) {
      end({ reason: this.#closed, resumable: false });
      return { ended, close: () => {} };
    }
    this.#subscriptions.set(id, { onEvent, end });
    this.#opened.then(
      () => this.#send({ type: "subscribe", id, ...request }),
      () => {},
    );
    return {
      ended,
      close: () => {
        if (this.#subscriptions.delete(id)) {
          end({ reason: "the subscription was closed", resumable: false });
          if (this.#closed === undefined && this.#connected) {
            this.#send({ type: "unsubscribe", id });
          }
        }
      },
    };
  }

  /** Closes the socket, ending every request and subscription it carries. */
  close(): void {
    this.#socket.close();
  }

  #send(frame: ConsoleSocketClientFrame): void {
    this.#socket.send(JSON.stringify(frame));
  }

  #receive(frame: ConsoleSocketServerFrame): void {
    switch (frame.type) {
      case "response": {
        const request = this.#requests.get(frame.id);
        this.#requests.delete(frame.id);
        request?.resolve(new Response(frame.body, { status: frame.status }));
        return;
      }
      case "event":
        this.#subscriptions.get(frame.subscription)?.onEvent(frame.envelope);
        return;
      case "unsubscribed": {
        const subscription = this.#subscriptions.get(frame.subscription);
        this.#subscriptions.delete(frame.subscription);
        subscription?.end({ reason: frame.error, resumable: false });
        return;
      }
      case "error":
        console.error(`the console refused a socket frame: ${frame.message}`);
        return;
      default:
        // A page hosts no browser, and a frame kind this client does not
        // know is one a newer console sends for a client that does.
        return;
    }
  }
}

/**
 * The console socket's address for a page: under the mount the page was
 * opened at, over `wss:` when the page came over `https:`.
 */
export const pageSocketUrl = (): string =>
  `${
    globalThis.location.protocol === "https:" ? "wss:" : "ws:"
  }//${globalThis.location.host}${
    consolePath(pageMount(), CONSOLE_SOCKET_PATH)
  }`;

let pageSocket: ConsoleSocket | undefined;

/**
 * The page's one socket, opened when first asked for and opened again when
 * asked for after it closed.
 */
export const consoleSocket = (): ConsoleSocket => {
  if (pageSocket === undefined || pageSocket.isClosed) {
    pageSocket = new ConsoleSocket(pageSocketUrl());
  }
  return pageSocket;
};

/**
 * Keeps one subscription for as long as its owner wants it: when the socket
 * it rides on closes after opening, it is taken again on a fresh socket, as
 * `request()` then describes it — from the last sequence its owner has seen.
 * It stops when its owner closes it, and otherwise `onLost` hears why it
 * stopped: a socket that did not open, or a subscription the console ended.
 */
export const followConsoleEvents = (
  request: () => ConsoleSubscriptionRequest,
  onEvent: (envelope: ConsoleChatEventEnvelope) => void,
  onLost: (reason: string) => void,
): { close(): void } => {
  let current: ConsoleSubscription | undefined;
  let closed = false;
  const follow = () => {
    const subscription = consoleSocket().subscribe(request(), onEvent);
    current = subscription;
    void subscription.ended.then((end) => {
      if (closed || current !== subscription) {
        return;
      }
      if (end.resumable) {
        follow();
      } else {
        onLost(end.reason);
      }
    });
  };
  follow();
  return {
    close: () => {
      closed = true;
      current?.close();
    },
  };
};
