/** Single-purpose HTTP transfers admitted through authenticated Memory sessions. */

import {
  ARCHIVE_LIMITS,
  type ArchiveCommand,
  type ArchiveIdentity,
  type ArchivePinReference,
  type ArchivePolicy,
  archiveResponseHash,
  type ArchiveResult,
  type ArchiveTicket,
  readArchiveBody,
  validateArchiveCommand,
} from "./archive.ts";
import type { ArchiveBackend } from "./archive.ts";

/** Trusted authentication and disclosure checks surrounding archive I/O. */
export type AuthorizeArchive = (
  command: ArchiveCommand,
  identity: ArchiveIdentity,
) => Promise<ArchivePolicy | undefined>;

interface ActiveTransfer {
  identity: ArchiveIdentity;
  abort: AbortController;
  done: PromiseWithResolvers<void>;
  finished: boolean;
  acknowledged: boolean;
  bodyDone: boolean;
  pulls: number;
  responseComplete: boolean;
  pin?: Extract<ArchiveCommand, { op: "pin" }> & {
    pin: string;
    sequence: number;
  };
  cancelResponse?: () => void;
  removeDisconnectListener?: () => void;
}

/** Bounded legacy result with a fresh policy check for each released chunk. */
export type LegacyDisclosure = { result: ArchiveResult; authorize: () => void };
type ReadLegacy = (
  command: Extract<ArchiveCommand, { op: "legacy-read" }>,
  identity: ArchiveIdentity,
) => Promise<LegacyDisclosure>;

/**
 * Keeps transfers admitted until the client acknowledges consuming the response.
 * Session detach and stream cancellation release abandoned transfers.
 */
export class ArchiveHttp {
  readonly #store: ArchiveBackend;
  readonly #authorize: AuthorizeArchive;
  readonly #origins: ReadonlySet<string>;
  readonly #legacy?: ReadLegacy;
  readonly #active = new Map<string, ActiveTransfer>();
  readonly #issuing = new Map<
    string,
    {
      identity: ArchiveIdentity;
      abort: AbortController;
      done: PromiseWithResolvers<void>;
    }
  >();
  #closed = false;

  get activeTransferCount(): number {
    return this.#active.size;
  }

  /** Configures the fixed backend and the exact browser origins it accepts. */
  constructor(
    store: ArchiveBackend,
    authorize: AuthorizeArchive,
    origins: readonly string[],
    legacy?: ReadLegacy,
  ) {
    this.#store = store;
    this.#authorize = authorize;
    this.#legacy = legacy;
    this.#origins = new Set(origins.map((origin) => {
      const url = new URL(origin);
      if (!/^https?:$/.test(url.protocol) || url.origin !== origin) {
        throw new Error("Archive origins must be exact HTTP origins");
      }
      return origin;
    }));
  }

  /** Mints a bounded, expiring capability after checking the current session. */
  async issue(
    command: ArchiveCommand,
    identity: ArchiveIdentity,
    pinSequence?: number,
  ): Promise<ArchiveTicket> {
    if (this.#closed) throw new Error("Archive transport is closed");
    validateArchiveCommand(command);
    if (
      (command.op === "release" || command.op === "pin-status") &&
      (!Number.isSafeInteger(command.sequence) || command.sequence! < 1)
    ) {
      throw new Error(
        "Archive pin operation requires an exact request sequence",
      );
    }
    const key = JSON.stringify(identity);
    const issuing = command.op === "pin"
      ? {
        identity,
        abort: new AbortController(),
        done: Promise.withResolvers<void>(),
      }
      : undefined;
    if (issuing) {
      if (
        this.#issuing.has(key) || this.#issuing.size >= ARCHIVE_LIMITS.pins ||
        [...this.#issuing.values()].filter((entry) =>
            entry.identity.principal === identity.principal
          ).length >= ARCHIVE_LIMITS.principalPins
      ) {
        throw new Error("Archive pin admission is already pending");
      }
      this.#issuing.set(key, issuing);
    }
    try {
      await this.#authorize(command, identity);
      issuing?.abort.signal.throwIfAborted();
      if (this.#closed) throw new Error("Archive transport is closed");
      return this.#store.issueTicket(command, identity, pinSequence);
    } finally {
      if (issuing) {
        this.#issuing.delete(key);
        issuing.done.resolve();
      }
    }
  }

  /** Adopts or releases requests owned by the issuing Memory session. */
  async acknowledge(
    token: string | undefined,
    identity: ArchiveIdentity,
    consumed = false,
    pin?: ArchivePinReference,
    release = false,
  ): Promise<void> {
    if (pin && (!Number.isSafeInteger(pin.sequence) || pin.sequence < 1)) {
      throw new Error(
        "Archive acknowledgement requires an exact request sequence",
      );
    }
    const active = token ? this.#active.get(token) : undefined;
    if (
      active && JSON.stringify(active.identity) !== JSON.stringify(identity)
    ) {
      throw new Error("Archive acknowledgement belongs to a different session");
    }
    if (
      active?.pin && pin &&
      (active.pin.archive !== pin.archive || active.pin.pin !== pin.pin ||
        active.pin.sequence !== pin.sequence)
    ) {
      throw new Error("Archive acknowledgement names a different pin request");
    }
    const owned = pin ??
      (active?.pin?.pin
        ? {
          archive: active.pin.archive,
          pin: active.pin.pin,
          sequence: active.pin.sequence,
        }
        : undefined);
    let accepted = false;
    try {
      if (owned) {
        if (release) {
          this.#store.releasePin(
            owned.archive,
            owned.pin,
            identity,
            true,
            owned.sequence,
            true,
          );
          for (const [pendingToken, transfer] of this.#active) {
            if (
              JSON.stringify(transfer.identity) === JSON.stringify(identity) &&
              transfer.pin?.archive === owned.archive &&
              transfer.pin.pin === owned.pin &&
              transfer.pin.sequence === owned.sequence
            ) {
              this.#release(pendingToken);
            }
          }
        } else if (consumed) {
          if (
            this.#store.pinState(
              owned.archive,
              owned.pin,
              identity,
              owned.sequence,
            ) !== "adopted"
          ) {
            if (!active?.pin || active.acknowledged) {
              throw new Error(
                "Archive pin transfer is unavailable for adoption",
              );
            }
            await this.#authorize(active.pin, identity);
            active.abort.signal.throwIfAborted();
            this.#store.adoptPin(
              owned.archive,
              owned.pin,
              identity,
              owned.sequence,
            );
          }
        } else {
          this.#store.releasePin(
            owned.archive,
            owned.pin,
            identity,
            false,
            owned.sequence,
            true,
          );
          for (const [pendingToken, transfer] of this.#active) {
            if (
              JSON.stringify(transfer.identity) === JSON.stringify(identity) &&
              transfer.pin?.archive === owned.archive &&
              transfer.pin.pin === owned.pin &&
              transfer.pin.sequence === owned.sequence
            ) this.#release(pendingToken);
          }
        }
      }
      if (token) this.#store.revokeTicket(token, identity);
      accepted = true;
    } finally {
      if (token) this.#release(token, accepted && consumed);
    }
  }

  #release(token: string, consumed = false): void {
    const transfer = this.#active.get(token);
    if (!transfer) return;
    transfer.acknowledged = true;
    if (transfer.pin?.pin) {
      this.#store.releasePin(
        transfer.pin.archive,
        transfer.pin.pin,
        transfer.identity,
        false,
        transfer.pin.sequence,
      );
    }
    if (!consumed) {
      transfer.abort.abort(new Error("Archive transfer closed"));
      transfer.cancelResponse?.();
    }
    this.#settle(token);
  }

  #settle(token: string): void {
    const transfer = this.#active.get(token);
    if (
      !transfer || !transfer.finished || !transfer.bodyDone ||
      transfer.pulls !== 0
    ) return;
    transfer.done.resolve();
    if (transfer.acknowledged) {
      transfer.removeDisconnectListener?.();
      this.#active.delete(token);
    }
  }

  #headers(origin: string | null): Headers {
    const headers = new Headers({
      "cache-control": "private, no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    });
    if (origin !== null) {
      headers.set("access-control-allow-origin", origin);
      headers.set("vary", "Origin");
      headers.set("access-control-expose-headers", "x-archive-content-sha256");
    }
    return headers;
  }

  /** Accepts a counted raw body after validating its capability and byte length. */
  async handle(request: Request): Promise<Response> {
    const origin = request.headers.get("origin");
    const originAllowed = origin === null
      ? !request.headers.has("sec-fetch-site")
      : this.#origins.has(origin);
    const headers = this.#headers(originAllowed ? origin : null);
    const reject = (status: number, message: string) => {
      if (request.body && !request.body.locked) {
        void request.body.cancel().catch(() => {});
      }
      headers.set("content-type", "text/plain");
      headers.set(
        "content-length",
        String(new TextEncoder().encode(message).length),
      );
      return new Response(message, { status, headers });
    };
    if (!originAllowed) return reject(403, "Archive origin is not allowed");
    if (new URL(request.url).search !== "") {
      return reject(
        400,
        "Archive credentials and commands are not accepted in URLs",
      );
    }
    if (request.method === "OPTIONS") {
      if (
        origin === null ||
        request.headers.get("access-control-request-method") !== "POST"
      ) return reject(403, "Archive preflight is not allowed");
      const requested =
        (request.headers.get("access-control-request-headers") ?? "")
          .toLowerCase().split(",").map((header) => header.trim()).filter(
            Boolean,
          );
      if (
        requested.some((header) =>
          !["authorization", "content-type"].includes(header)
        )
      ) return reject(403, "Archive preflight headers are not allowed");
      headers.set("access-control-allow-methods", "POST");
      headers.set(
        "access-control-allow-headers",
        "authorization, content-type",
      );
      return new Response(null, { status: 204, headers });
    }
    if (this.#closed) return reject(503, "Archive transport is closed");
    if (request.method !== "POST") {
      return reject(405, "Archive transfers require POST");
    }
    if (request.headers.has("range") || request.headers.has("content-range")) {
      return reject(400, "Archive byte ranges are not supported");
    }
    const authorization = request.headers.get("authorization") ?? "";
    if (!/^Bearer [a-f0-9-]{72}$/.test(authorization)) {
      return reject(403, "Archive capability is missing");
    }
    if (request.headers.get("content-type") !== "application/octet-stream") {
      return reject(400, "Archive transfers require application/octet-stream");
    }
    const length = request.headers.get("content-length");
    if (
      length === null || !/^(0|[1-9][0-9]*)$/.test(length) ||
      Number(length) > ARCHIVE_LIMITS.pageBytes
    ) return reject(411, "Archive transfer requires a bounded Content-Length");
    const token = authorization.slice(7);
    let active: ActiveTransfer | undefined;
    let consumedPin:
      | { identity: ArchiveIdentity; pin: ArchivePinReference }
      | undefined;
    const disconnected = () => {
      // Deno's legacy request signal also aborts after a successful response.
      // After natural EOF, Memory acknowledgement and attachment closure own cleanup.
      if (!active?.responseComplete) this.#release(token);
    };
    try {
      const { command, identity, pinSequence } = this.#store.consumeTicket(
        token,
      );
      if (command.op === "pin") {
        if (
          !command.pin || !Number.isSafeInteger(pinSequence) ||
          pinSequence! < 1 || command.sequence !== pinSequence
        ) throw new Error("Archive capability has no exact pin request");
        consumedPin = {
          identity,
          pin: {
            archive: command.archive,
            pin: command.pin,
            sequence: pinSequence!,
          },
        };
      }
      const expected = command.op === "put" ? command.bytes : 0;
      if (Number(length) !== expected) {
        return reject(400, "Archive body length does not match its capability");
      }
      let principalTransfers = 0;
      for (const transfer of this.#active.values()) {
        if (transfer.identity.principal === identity.principal) {
          principalTransfers++;
        }
      }
      if (
        this.#active.size >= ARCHIVE_LIMITS.transfers ||
        principalTransfers >= ARCHIVE_LIMITS.principalTransfers
      ) return reject(429, "Archive transfer limit exceeded");
      active = {
        identity,
        abort: new AbortController(),
        done: Promise.withResolvers<void>(),
        finished: false,
        acknowledged: false,
        bodyDone: false,
        pulls: 0,
        responseComplete: false,
        pin: command.op === "pin"
          ? { ...command, pin: command.pin!, sequence: pinSequence! }
          : undefined,
      };
      this.#active.set(token, active);
      request.signal.addEventListener("abort", disconnected, { once: true });
      active.removeDisconnectListener = () =>
        request.signal.removeEventListener("abort", disconnected);
      const transfer = active;
      let disclosure: LegacyDisclosure | undefined;
      const check = async () => {
        transfer.abort.signal.throwIfAborted();
        request.signal.throwIfAborted();
        await this.#authorize(command, identity);
        disclosure?.authorize();
        transfer.abort.signal.throwIfAborted();
        request.signal.throwIfAborted();
      };
      const policy = await this.#authorize(command, identity);
      await check();
      let body: ReadableStream<Uint8Array> | null = request.body;
      if (body !== null) {
        const original = body;
        const reader = original.getReader();
        const cancel = () => {
          void reader.cancel(transfer.abort.signal.reason).catch(() => {});
        };
        transfer.abort.signal.addEventListener("abort", cancel, { once: true });
        body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                transfer.abort.signal.removeEventListener("abort", cancel);
                reader.releaseLock();
                controller.close();
              } else controller.enqueue(next.value);
            } catch (error) {
              transfer.abort.signal.removeEventListener("abort", cancel);
              reader.releaseLock();
              controller.error(error);
            }
          },
          async cancel(reason) {
            transfer.abort.signal.removeEventListener("abort", cancel);
            try {
              await reader.cancel(reason);
            } finally {
              reader.releaseLock();
            }
          },
        }, { highWaterMark: 0 });
      }
      if (command.op !== "put") await readArchiveBody(body, 0, () => {});
      const result = command.op === "legacy-read"
        ? (disclosure = await this.#readLegacy(command, identity)).result
        : await this.#store.execute(command, identity, check, body, policy);
      await check();
      const bytes = result instanceof Uint8Array
        ? result
        : new TextEncoder().encode(JSON.stringify(result));
      if (
        bytes.length >
          (result instanceof Uint8Array
            ? ARCHIVE_LIMITS.pageBytes
            : ARCHIVE_LIMITS.controlBytes)
      ) throw new Error("Archive response exceeds its byte limit");
      headers.set(
        "content-type",
        result instanceof Uint8Array
          ? "application/octet-stream"
          : "application/json",
      );
      headers.set("content-length", String(bytes.length));
      headers.set("x-archive-content-sha256", archiveResponseHash(bytes));
      let offset = 0;
      const responseBody = new ReadableStream<Uint8Array>({
        start: (controller) => {
          transfer.cancelResponse = () => {
            if (!transfer.bodyDone) {
              transfer.bodyDone = true;
              controller.error(transfer.abort.signal.reason);
            }
          };
        },
        pull: async (controller) => {
          transfer.pulls++;
          try {
            await check();
            if (offset === bytes.length) {
              transfer.bodyDone = true;
              transfer.responseComplete = true;
              controller.close();
              return;
            }
            const end = Math.min(
              offset + ARCHIVE_LIMITS.chunkBytes,
              bytes.length,
            );
            controller.enqueue(bytes.slice(offset, end));
            offset = end;
          } catch (error) {
            if (!transfer.bodyDone) controller.error(error);
            transfer.bodyDone = true;
            this.#release(token);
          } finally {
            transfer.pulls--;
            this.#settle(token);
          }
        },
        cancel: () => {
          transfer.bodyDone = true;
          this.#release(token);
        },
      }, { highWaterMark: 0 });
      return new Response(responseBody, { headers });
    } catch (error) {
      this.#release(token);
      return reject(
        403,
        error instanceof Error ? error.message : "Archive request failed",
      );
    } finally {
      if (!active && consumedPin) {
        this.#store.releasePin(
          consumedPin.pin.archive,
          consumedPin.pin.pin,
          consumedPin.identity,
          false,
          consumedPin.pin.sequence,
        );
      }
      if (active) {
        active.finished = true;
        if (!active.cancelResponse) active.bodyDone = true;
        this.#settle(token);
      }
      if (!active || !this.#active.has(token)) {
        if (request.body && !request.body.locked) {
          await request.body.cancel().catch(() => {});
        }
      }
    }
  }

  async #readLegacy(
    command: Extract<ArchiveCommand, { op: "legacy-read" }>,
    identity: ArchiveIdentity,
  ): Promise<LegacyDisclosure> {
    if (!this.#legacy) {
      throw new Error("Bounded legacy inspection is unavailable");
    }
    return await this.#legacy(command, identity);
  }

  /** Cancels this connection's transfers and releases its durable reader pins. */
  detach(identity: ArchiveIdentity): void {
    if (this.#closed) return;
    for (const [token, active] of this.#active) {
      if (JSON.stringify(active.identity) === JSON.stringify(identity)) {
        this.#release(token);
      }
    }
    this.#issuing.get(JSON.stringify(identity))?.abort.abort(
      new Error("Archive attachment closed"),
    );
    this.#store.detach(identity);
  }

  /** Releases every archive resource bound to an ended Memory attachment. */
  detachSession(space: string, sessionId: string, connectionId: string): void {
    if (this.#closed) return;
    for (const [token, active] of this.#active) {
      if (
        active.identity.space === space &&
        active.identity.sessionId === sessionId &&
        active.identity.connectionId === connectionId
      ) this.#release(token);
    }
    for (const issuing of this.#issuing.values()) {
      if (
        issuing.identity.space === space &&
        issuing.identity.sessionId === sessionId &&
        issuing.identity.connectionId === connectionId
      ) {
        issuing.abort.abort(new Error("Archive attachment closed"));
      }
    }
    this.#store.detachSession(space, sessionId, connectionId);
  }

  /** Cancels I/O and waits for its file handles to close before closing storage. */
  async close(): Promise<void> {
    this.#closed = true;
    const pending = [...this.#active.values(), ...this.#issuing.values()].map((
      active,
    ) => active.done.promise);
    for (const issuing of this.#issuing.values()) {
      issuing.abort.abort(new Error("Archive transport closed"));
    }
    for (const token of this.#active.keys()) this.#release(token);
    await Promise.all(pending);
    this.#store.closeReaders();
  }
}
