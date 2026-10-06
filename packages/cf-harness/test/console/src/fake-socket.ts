/**
 * A `WebSocket` the console page tests drive instead of a console: it opens
 * on the next microtask, answers each request frame with what `answer` says
 * once that has settled, records every frame the page sends, and delivers the
 * events a test hands it to every subscription the page has made on it.
 */

import type {
  ConsoleSocketClientFrame,
  ConsoleSocketRequestFrame,
  ConsoleSocketServerFrame,
  ConsoleSocketSubscribeFrame,
} from "../../../console/socket-protocol.ts";
import type { ConsoleChatEventEnvelope } from "../../../console/turn-result.ts";

/** What a fake console answers one request with. */
export type FakeAnswer = (
  frame: ConsoleSocketRequestFrame,
) =>
  | { status: number; body: string }
  | Promise<{ status: number; body: string }>;

export class FakeConsoleSocket extends EventTarget {
  /** Every socket opened since {@link install}, in the order it was. */
  static opened: FakeConsoleSocket[] = [];

  /** How every socket answers a request. */
  static answer: FakeAnswer = () => ({ status: 404, body: "not found" });

  static readonly #openWaiters: (() => void)[] = [];

  readyState = 0;
  readonly sent: ConsoleSocketClientFrame[] = [];
  readonly #subscriptions: ConsoleSocketSubscribeFrame[] = [];
  readonly #waiters: (() => void)[] = [];
  readonly #frameWaiters: (() => void)[] = [];

  constructor(readonly url: string) {
    super();
    FakeConsoleSocket.opened.push(this);
    for (const waiter of FakeConsoleSocket.#openWaiters.splice(0)) waiter();
    queueMicrotask(() => {
      if (this.readyState === 0) {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      }
    });
  }

  /**
   * Puts this class in place of `WebSocket`, and opens the page at
   * `pathname` and `search` on the console's own origin, until the returned
   * function puts the real ones back, closing every socket opened meanwhile.
   */
  static install(
    answer: FakeAnswer = () => ({ status: 404, body: "not found" }),
    pathname = "/",
    search = "",
  ): () => void {
    const real = globalThis.WebSocket;
    const realLocation = Object.getOwnPropertyDescriptor(
      globalThis,
      "location",
    );
    FakeConsoleSocket.opened = [];
    FakeConsoleSocket.answer = answer;
    Object.defineProperty(globalThis, "location", {
      value: { pathname, search, protocol: "http:", host: "127.0.0.1:8100" },
      configurable: true,
    });
    // deno-lint-ignore no-explicit-any
    globalThis.WebSocket = FakeConsoleSocket as any;
    return () => {
      for (const socket of FakeConsoleSocket.opened) {
        socket.close();
      }
      globalThis.WebSocket = real;
      if (realLocation === undefined) {
        Reflect.deleteProperty(globalThis, "location");
      } else {
        Object.defineProperty(globalThis, "location", realLocation);
      }
    };
  }

  /** The `index`th socket opened since {@link install}, once it has been. */
  static async socket(index: number): Promise<FakeConsoleSocket> {
    while (FakeConsoleSocket.opened.length <= index) {
      await new Promise<void>((resolve) =>
        FakeConsoleSocket.#openWaiters.push(resolve)
      );
    }
    return FakeConsoleSocket.opened[index];
  }

  /** Settles once the page sends its next frame. */
  nextFrame(): Promise<void> {
    return new Promise<void>((resolve) => this.#frameWaiters.push(resolve));
  }

  send(text: string): void {
    const frame: ConsoleSocketClientFrame = JSON.parse(text);
    this.sent.push(frame);
    for (const waiter of this.#frameWaiters.splice(0)) waiter();
    if (frame.type === "request") {
      void Promise.resolve(FakeConsoleSocket.answer(frame)).then((answer) =>
        this.#receive({ type: "response", id: frame.id, ...answer })
      );
    } else if (frame.type === "subscribe") {
      this.#subscriptions.push(frame);
      for (const waiter of this.#waiters.splice(0)) waiter();
    }
  }

  /** Closes the socket as a console that went away would. */
  close(): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close"));
  }

  /** The `index`th subscription the page made, once it has made it. */
  async subscription(index = 0): Promise<ConsoleSocketSubscribeFrame> {
    while (this.#subscriptions.length <= index) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    return this.#subscriptions[index];
  }

  /** Delivers `envelope` to every subscription the page has made. */
  deliver(envelope: ConsoleChatEventEnvelope): void {
    if (this.#subscriptions.length === 0) {
      throw new Error("the page has made no subscription to deliver to");
    }
    for (const subscription of this.#subscriptions) {
      this.#receive({ type: "event", subscription: subscription.id, envelope });
    }
  }

  #receive(frame: ConsoleSocketServerFrame): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  }
}
