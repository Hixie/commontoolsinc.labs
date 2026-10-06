/**
 * The frames of the console socket: the one WebSocket a client holds to the
 * console, carrying its requests and their answers, the chat events it
 * subscribes to, and the operations of the turns it hosts a browser for.
 *
 * Every frame is one JSON object in one text message, and names its kind in
 * `type`. A reader ignores a field it does not know, so a frame can grow
 * without either end changing what it already reads. This module is pure and
 * runs in a page as well as on the server: the page's client
 * (`./src/socket.ts`) and the server (`./server.ts`) both read and write
 * through it.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";

import type { BrowserHostOperation } from "../src/contracts/browser-host.ts";
import type { ConsoleChatEventEnvelope } from "./turn-result.ts";

/** The path a client opens the socket at, under the console's mount. */
export const CONSOLE_SOCKET_PATH = "/api/socket";

/**
 * The route a browser host attaches to its turn on, `{turnId}`, once it is
 * ready for the turn's operations. Like {@link BROWSER_HOST_RESULT_PATH}, it
 * is served only over the socket the turn's task was started on, which is
 * what makes that socket the turn's host.
 */
export const BROWSER_HOST_ATTACH_PATH = "/api/browser-host/attach";

/**
 * The route a browser host gives up its turn on, `{turnId}`: every operation
 * it holds, and every later one, settles as `session-ended`, as when its
 * socket closes, and the socket stays open for everything else it carries.
 */
export const BROWSER_HOST_DETACH_PATH = "/api/browser-host/detach";

/** The route a browser host answers one operation on. */
export const BROWSER_HOST_RESULT_PATH = "/api/browser-host/result";

/** The methods a request frame may name. */
export type ConsoleSocketMethod = "GET" | "POST";

/**
 * One call of a console route. `path` is the route's path and query, as an
 * HTTP client would request it; `body` is the JSON a POST carries. The console
 * answers it with exactly one {@link ConsoleSocketResponseFrame} carrying the
 * same `id`. Answers to different requests may arrive in any order.
 */
export interface ConsoleSocketRequestFrame {
  type: "request";
  id: string;
  method: ConsoleSocketMethod;
  path: string;
  body?: unknown;
}

/**
 * A subscription to chat events: those of the session `sessionId` names, or
 * of every session when it is absent; of only the turn `turnId` names, when
 * it is present; and with a sequence above `afterSequence`, or all of them
 * when it is absent. The recorded events arrive first and the live ones after
 * them, in sequence order, each as one {@link ConsoleSocketEventFrame} whose
 * `subscription` is this frame's `id`.
 */
export interface ConsoleSocketSubscribeFrame {
  type: "subscribe";
  id: string;
  sessionId?: string;
  turnId?: string;
  afterSequence?: number;
}

/** Ends the subscription `id` names. */
export interface ConsoleSocketUnsubscribeFrame {
  type: "unsubscribe";
  id: string;
}

/** A frame a client sends. */
export type ConsoleSocketClientFrame =
  | ConsoleSocketRequestFrame
  | ConsoleSocketSubscribeFrame
  | ConsoleSocketUnsubscribeFrame;

/**
 * The answer to one request: the status and the body text the route answered
 * with, which is JSON for every route except a run file read raw.
 */
export interface ConsoleSocketResponseFrame {
  type: "response";
  id: string;
  status: number;
  body: string;
}

/** One chat event, delivered to the subscription that asked for it. */
export interface ConsoleSocketEventFrame {
  type: "event";
  subscription: string;
  envelope: ConsoleChatEventEnvelope;
}

/**
 * A subscription that delivers nothing more: the console could not read its
 * recorded events, and says why.
 */
export interface ConsoleSocketUnsubscribedFrame {
  type: "unsubscribed";
  subscription: string;
  error: string;
}

/**
 * One operation of a turn this client hosts a browser for. The host answers
 * it by posting `{turnId, id, result}` to {@link BROWSER_HOST_RESULT_PATH}
 * over this socket.
 */
export interface ConsoleSocketBrowserHostRequestFrame {
  type: "browser-host-request";
  turnId: string;
  id: string;
  operation: BrowserHostOperation;
}

/**
 * Withdraws an operation the host holds. The host stops it if it can, and
 * answers it as it ended; no later operation of the turn arrives before that
 * answer.
 */
export interface ConsoleSocketBrowserHostWithdrawFrame {
  type: "browser-host-withdraw";
  turnId: string;
  id: string;
}

/** The turn is over, and the host has nothing more to do for it. */
export interface ConsoleSocketBrowserHostCloseFrame {
  type: "browser-host-close";
  turnId: string;
}

/** A frame the console could not read, and why. */
export interface ConsoleSocketErrorFrame {
  type: "error";
  message: string;
}

/** A frame the console sends. */
export type ConsoleSocketServerFrame =
  | ConsoleSocketResponseFrame
  | ConsoleSocketEventFrame
  | ConsoleSocketUnsubscribedFrame
  | ConsoleSocketBrowserHostRequestFrame
  | ConsoleSocketBrowserHostWithdrawFrame
  | ConsoleSocketBrowserHostCloseFrame
  | ConsoleSocketErrorFrame;

const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

/**
 * Reads one message a client sent, or the frame that refuses it. A request
 * names an `/api/` route, so it cannot reach the page's files.
 *
 * A refused request is answered as a 400 and a refused subscription as
 * ended, so a client waiting on either learns why under the id it gave; a
 * message with no usable id is answered with an error frame.
 */
export const readConsoleSocketClientFrame = (
  text: string,
):
  | { ok: true; frame: ConsoleSocketClientFrame }
  | { ok: false; answer: ConsoleSocketServerFrame } => {
  const refuse = (message: string) => ({
    ok: false as const,
    answer: { type: "error" as const, message },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("a socket message is not JSON");
  }
  if (!isObjectNotArray(parsed)) {
    return refuse("a socket message is not a JSON object");
  }
  const { type, id } = parsed;
  if (typeof id !== "string" || id === "") {
    return refuse("a socket frame names no id");
  }
  const refuseRequest = (error: string) => ({
    ok: false as const,
    answer: {
      type: "response" as const,
      id,
      status: 400,
      body: JSON.stringify({ error }),
    },
  });
  const refuseSubscription = (error: string) => ({
    ok: false as const,
    answer: { type: "unsubscribed" as const, subscription: id, error },
  });
  switch (type) {
    case "request": {
      const { method, path, body } = parsed;
      if (method !== "GET" && method !== "POST") {
        return refuseRequest(`request ${id} names no method of GET or POST`);
      }
      if (typeof path !== "string" || !path.startsWith("/api/")) {
        return refuseRequest(`request ${id} names no console route`);
      }
      if (method === "GET" && body !== undefined) {
        return refuseRequest(`request ${id} is a GET, which carries no body`);
      }
      return {
        ok: true,
        frame: {
          type,
          id,
          method,
          path,
          ...(body !== undefined ? { body } : {}),
        },
      };
    }
    case "subscribe": {
      const { sessionId, turnId, afterSequence } = parsed;
      if (!optionalString(sessionId) || !optionalString(turnId)) {
        return refuseSubscription(
          `subscription ${id} names a session or turn that is not a string`,
        );
      }
      if (
        afterSequence !== undefined &&
        !(typeof afterSequence === "number" &&
          Number.isSafeInteger(afterSequence) && afterSequence >= 0)
      ) {
        return refuseSubscription(
          `subscription ${id}: afterSequence must be a non-negative integer`,
        );
      }
      return {
        ok: true,
        frame: {
          type,
          id,
          ...(typeof sessionId === "string" ? { sessionId } : {}),
          ...(typeof turnId === "string" ? { turnId } : {}),
          ...(afterSequence !== undefined ? { afterSequence } : {}),
        },
      };
    }
    case "unsubscribe":
      return { ok: true, frame: { type, id } };
    default:
      return refuse(`a socket frame has the unknown type ${String(type)}`);
  }
};

/**
 * The recorded events a subscription resuming at `afterSequence` is owed, in
 * sequence order. The service returns its events already filtered, but a
 * subscription mixes that answer with envelopes that arrived live while it was
 * being read, so this sorts and drops what the subscriber has seen rather than
 * trusting the order the two sources happened to interleave in.
 */
export const envelopesAfter = <Envelope extends { sequence: number }>(
  envelopes: readonly Envelope[],
  afterSequence: number,
): readonly Envelope[] =>
  [...envelopes]
    .filter((envelope) => envelope.sequence > afterSequence)
    .sort((left, right) => left.sequence - right.sequence);
