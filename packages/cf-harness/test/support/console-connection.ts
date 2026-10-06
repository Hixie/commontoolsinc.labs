/**
 * A client of a console's socket protocol with no socket under it, for tests
 * that drive a `ConsoleServer` without serving it on a port.
 */

import type { ConsoleServer } from "../../console/server.ts";
import type {
  ConsoleSocketMethod,
  ConsoleSocketServerFrame,
  ConsoleSocketSubscribeFrame,
} from "../../console/socket-protocol.ts";
import type { ConsoleChatEventEnvelope } from "../../console/turn-result.ts";

/** One subscription's events, read in the order they arrive. */
export interface ConsoleEvents {
  /**
   * The next event of `kind`, skipping those before it. A turn that completes
   * first is an error, unless `kind` is its completion.
   */
  next(kind: string): Promise<ConsoleChatEventEnvelope>;
}

/** Connects to `server` as a socket client would. */
export const connectToConsole = (server: ConsoleServer) => {
  const frames: ConsoleSocketServerFrame[] = [];
  const waiters: (() => void)[] = [];
  const connection = server.connect((frame) => {
    frames.push(frame);
    for (const waiter of waiters.splice(0)) waiter();
    return true;
  });
  /** What `pick` makes of the first frame it makes something of. */
  const take = async <Picked>(
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
  };
  let nextId = 0;
  return {
    /** Calls one route, answering with what it answered. */
    request: async (
      method: ConsoleSocketMethod,
      path: string,
      body?: unknown,
    ): Promise<Response> => {
      const id = String(++nextId);
      connection.receive(JSON.stringify({
        type: "request",
        id,
        method,
        path,
        ...(body !== undefined ? { body } : {}),
      }));
      const answer = await take((frame) =>
        frame.type === "response" && frame.id === id ? frame : undefined
      );
      return new Response(answer.body, { status: answer.status });
    },
    /** Subscribes to the events `request` describes. */
    subscribe: (
      request: Omit<ConsoleSocketSubscribeFrame, "type" | "id">,
    ): ConsoleEvents => {
      const id = String(++nextId);
      connection.receive(JSON.stringify({ type: "subscribe", id, ...request }));
      return {
        next: async (kind) => {
          for (;;) {
            const envelope = await take((frame) =>
              frame.type === "event" && frame.subscription === id
                ? frame.envelope
                : undefined
            );
            if (envelope.event.kind === kind) {
              return envelope;
            }
            if (envelope.event.kind === "turn_completed") {
              throw new Error(`turn completed before ${kind}`);
            }
          }
        },
      };
    },
    /** Says the client has gone. */
    close: () => connection.close(),
  };
};
