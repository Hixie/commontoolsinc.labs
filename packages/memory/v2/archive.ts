/** Bounded archive protocol, independent of document replication and storage. */

import { encodeHex } from "@std/encoding/hex";

import { sha256 } from "@commonfabric/content-hash";

/** Hard bounds advertised by the archive backend. */
export type ArchiveLimits = {
  /** Transfer protocol version. */
  protocol: 2;
  /** Native session representation version. */
  schema: 2;
  /** Maximum bytes in one immutable page. */
  pageBytes: number;
  /** Maximum bytes pulled from a body at once. */
  chunkBytes: number;
  /** Maximum UTF-8 bytes in metadata for one record or page. */
  metadataBytes: number;
  /** Maximum encoded bytes in a control request or response. */
  controlBytes: number;
  /** Maximum rows returned by a catalog request. */
  rows: number;
  /** Maximum simultaneous HTTP transfers in the server. */
  transfers: number;
  /** Maximum simultaneous HTTP transfers for one principal. */
  principalTransfers: number;
  /** Maximum retained generations per archive. */
  generations: number;
  /** Maximum reader pins across this server. */
  pins: number;
  /** Maximum reader pins across one principal's sessions. */
  principalPins: number;
  /** Maximum pending or provisional pin requests per authenticated session. */
  sessionProvisionalPins: 1;
  /** Maximum authenticated sessions retaining pin request high-water marks. */
  pinSessions: number;
  /** Maximum pin request high-water marks for one principal. */
  principalPinSessions: number;
};

/** Archive limits shared by validation, allocation, and capability negotiation. */
export const ARCHIVE_LIMITS: Readonly<ArchiveLimits> = {
  protocol: 2,
  schema: 2,
  pageBytes: 64 * 1024,
  chunkBytes: 16 * 1024,
  metadataBytes: 16 * 1024,
  controlBytes: 64 * 1024,
  rows: 16,
  transfers: 8,
  principalTransfers: 2,
  generations: 16,
  pins: 128,
  principalPins: 8,
  sessionProvisionalPins: 1,
  pinSessions: 128,
  principalPinSessions: 16,
};

/** Refuses absent or incompatible archive capabilities before collection starts. */
export function requireArchiveLimits(
  value: ArchiveLimits | undefined,
): ArchiveLimits {
  if (
    !value ||
    Object.entries(ARCHIVE_LIMITS).some(([key, expected]) =>
      value[key as keyof ArchiveLimits] !== expected
    )
  ) {
    throw new Error(
      "Server does not support the required bounded archive protocol and limits",
    );
  }
  return { ...value };
}

/** Durable authority associated with an archive, independent of its handle cell. */
export type ArchiveBinding = {
  /** Server-derived opaque archive identifier. */
  id: string;
  /** Space containing the archive handle. */
  space: string;
  /** Stable Fabric handle identifier. */
  handle: string;
  /** Authenticated principal that created the archive. */
  owner: string;
  /** Authenticated principal authorized to write this archive. */
  writer: string;
  /** Connector builtin authorized by the server's archive policy. */
  writerPolicy: string;
  /** Immutable, versioned CFC metadata serialized by the policy provider. */
  cfcPolicy: string;
  /** Native session representation version. */
  schema: 2;
  /** Maximum stored native bytes, including staged records. */
  quotaBytes: number;
  /** Maximum stored pages, including staged records. */
  quotaPages: number;
  /** Published generation, or null before the first collection. */
  generation: string | null;
  /** Interrupted collection available for explicit resume or abort. */
  pendingGeneration: string | null;
  /** Whether this binding has been deleted. */
  deleted: boolean;
};

/** Authenticated session identity carried into an archive operation. */
export interface ArchiveIdentity {
  /** Authenticated space. */
  space: string;
  /** Authenticated envelope principal. */
  principal: string;
  /** Acting principal used for read authorization. */
  actingPrincipal: string;
  /** Attached Memory session identifier. */
  sessionId: string;
  /** Connection to which that session is attached. */
  connectionId: string;
}

/** Immutable policy minted by trusted server code when an archive is created. */
export interface ArchivePolicy {
  /** Connector builtin whose native archive the server accepts. */
  writerPolicy: string;
  /** Versioned CFC metadata, independent of caller-editable Fabric data. */
  cfcPolicy: string;
}

/** Mandatory server policy bridge to the runtime's CFC rules. */
export interface ArchiveAuthorization {
  /** Creates an immutable policy for a new owner-authorized binding. */
  create(identity: ArchiveIdentity, readers: readonly string[]): ArchivePolicy;
  /** Checks the durable policy against the authenticated operation principal. */
  authorize(
    binding: ArchiveBinding,
    identity: ArchiveIdentity,
    access: "read" | "write",
  ): boolean;
  /** Checks every stored CFC clause on one bounded legacy document. */
  authorizeLegacy?(metadata: unknown, identity: ArchiveIdentity): boolean;
}

/** One catalog entry in a pinned generation. */
export type ArchiveRecord = {
  /** Stable key within this archive. */
  key: string;
  /** Source that owns this record. */
  source: string;
  /** Immutable record version. */
  record: string;
  /** Bounded JSON metadata supplied when the record was completed. */
  metadata: string;
  /** Whether this collection retained a previous complete version. */
  partial: boolean;
};

/** One immutable page belonging to a record. */
export type ArchivePage = {
  /** Contiguous zero-based page number. */
  index: number;
  /** SHA-256 digest of the exact page bytes, in lowercase hexadecimal. */
  hash: string;
  /** Exact byte length. */
  bytes: number;
  /** Bounded JSON provenance and page description. */
  metadata: string;
};

/** Fixed archive commands. No command accepts SQL or a filesystem path. */
export type ArchiveCommand =
  | { op: "open"; handle: string; readers?: string[] }
  | { op: "begin"; archive: string; generation: string; base: string | null }
  | {
    op: "record";
    archive: string;
    generation: string;
    record: string;
    key: string;
    source: string;
  }
  | {
    op: "put";
    archive: string;
    generation: string;
    record: string;
    index: number;
    hash: string;
    bytes: number;
    metadata: string;
  }
  | {
    op: "complete-record";
    archive: string;
    generation: string;
    record: string;
    metadata: string;
  }
  | {
    op: "discard-record";
    archive: string;
    generation: string;
    record: string;
  }
  | { op: "retain"; archive: string; generation: string; key: string }
  | {
    op: "source";
    archive: string;
    generation: string;
    source: string;
    complete: boolean;
  }
  | { op: "publish" | "abort" | "prune"; archive: string; generation: string }
  | {
    op: "pin";
    archive: string;
    generation: string;
    pin?: string;
    sequence?: number;
  }
  | { op: "pin-status"; archive: string; pin: string; sequence?: number }
  | { op: "release"; archive: string; pin: string; sequence?: number }
  | {
    op: "list";
    archive: string;
    generation: string;
    pin: string;
    after?: string;
    source?: string;
    limit?: number;
  }
  | {
    op: "count";
    archive: string;
    generation: string;
    pin: string;
    source?: string;
  }
  | { op: "get"; archive: string; generation: string; pin: string; key: string }
  | {
    op: "pages";
    archive: string;
    generation: string;
    pin: string;
    key: string;
    after?: number;
    limit?: number;
  }
  | {
    op: "read";
    archive: string;
    generation: string;
    pin: string;
    key: string;
    index: number;
    hash: string;
  }
  | { op: "legacy-read"; archive: string; id: string }
  | { op: "delete"; archive: string };

/** Small control response; native bytes only appear in an HTTP response body. */
export type ArchivePinState =
  | "pending"
  | "provisional"
  | "adopted"
  | "released";

export type ArchiveResult = {
  /** Exact state of the named pin request for this authenticated identity. */
  pinState?: ArchivePinState;
  /** Binding returned by open. */
  binding?: ArchiveBinding;
  /** Generation selected or published. */
  generation?: string;
  /** Number of complete records in the generation. */
  count?: number;
  /** Reader pin tied to this authenticated Memory session. */
  pin?: string;
  /** One bounded catalog page. */
  records?: ArchiveRecord[];
  /** One bounded page directory. */
  pages?: ArchivePage[];
  /** The page durably accepted by a write. */
  page?: ArchivePage;
  /** One bounded legacy inspection result, never a replicated value. */
  legacy?: { status: "available" | "refused"; wire?: string; message?: string };
};

/** Single-purpose HTTP capability minted through an authenticated Memory session. */
export type ArchiveTicket = {
  /** Unpredictable bearer capability, sent only in the Authorization header. */
  token: string;
  /** Absolute Unix expiration time in milliseconds. */
  expiresAt: number;
  /** Exact required request body length. */
  bytes: number;
};

/** Archive operations exposed to an imperative reader. */
export type ArchiveReadCommand = Extract<
  ArchiveCommand,
  {
    op:
      | "pin"
      | "pin-status"
      | "release"
      | "list"
      | "count"
      | "get"
      | "pages"
      | "read"
      | "legacy-read";
  }
>;

/** A single-purpose read capability and its authenticated server endpoint. */
export type ArchiveReadTransfer = { ticket: ArchiveTicket; url: string };

/** Backend authority used by Memory without filesystem or database assumptions. */
export interface ArchiveBackend extends Disposable {
  /** Reads the immutable binding and its current generation. */
  binding(id: string, includeDeleted?: boolean): ArchiveBinding;
  /** Persists a bounded single-purpose capability. */
  issueTicket(
    command: ArchiveCommand,
    identity: ArchiveIdentity,
    pinSequence?: number,
  ): ArchiveTicket;
  /** Consumes a capability atomically before accepting its native body. */
  consumeTicket(
    token: string,
  ): {
    command: ArchiveCommand;
    identity: ArchiveIdentity;
    pinSequence?: number;
  };
  /** Revokes an unused capability for its issuing session. */
  revokeTicket(token: string, identity: ArchiveIdentity): void;
  /** Executes a fixed operation with authorization at its I/O boundaries. */
  execute(
    command: ArchiveCommand,
    identity: ArchiveIdentity,
    authorize: () => Promise<void>,
    body?: ReadableStream<Uint8Array> | null,
    policy?: ArchivePolicy,
  ): Promise<ArchiveResult | Uint8Array>;
  /** Reads only the named request owned by this exact authenticated identity. */
  pinState(
    archive: string,
    pin: string,
    identity: ArchiveIdentity,
    sequence?: number,
  ): ArchivePinState;
  /** Adopts a provisional pin after authenticated, verified response consumption. */
  adoptPin(
    archive: string,
    pin: string,
    identity: ArchiveIdentity,
    sequence?: number,
  ): void;
  /** Releases the named provisional request, or its adopted pin on explicit close. */
  releasePin(
    archive: string,
    pin: string,
    identity: ArchiveIdentity,
    adopted?: boolean,
    sequence?: number,
    remember?: boolean,
  ): void;
  /** Clears reader ownership when the archive transport closes. */
  closeReaders(): void;
  /** Releases resources held by an exact authenticated identity. */
  detach(identity: ArchiveIdentity): void;
  /** Releases resources held by a detached connection session. */
  detachSession(space: string, sessionId: string, connectionId: string): void;
}

/** A client-owned pin identifier known before its transfer begins. */
export type ArchivePinReference = {
  archive: string;
  pin: string;
  sequence: number;
};

/** Hashes one bounded archive response. */
export function archiveResponseHash(bytes: Uint8Array): string {
  return encodeHex(sha256(bytes));
}

/** Owns a named request before acquisition, including uncertain transport outcomes. */
export class ArchivePinOwner {
  readonly pin = crypto.randomUUID();
  readonly scope: Readonly<{ archive: string; generation: string }>;
  #state: ArchivePinState | "new" | "uncertain" = "new";
  constructor(
    scope: { archive: string; generation: string },
    readonly control: (
      command: Extract<
        ArchiveCommand,
        { op: "pin" | "pin-status" | "release" }
      >,
      signal?: AbortSignal,
    ) => Promise<ArchiveResult>,
  ) {
    this.scope = { archive: scope.archive, generation: scope.generation };
  }
  get state(): ArchivePinState | "new" | "uncertain" {
    return this.#state;
  }
  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.#state !== "new") {
      throw new Error("Archive pin owner has already requested acquisition");
    }
    this.#state = "uncertain";
    const result = await this.control({
      op: "pin",
      ...this.scope,
      pin: this.pin,
    }, signal);
    if (
      result.pin !== this.pin || result.generation !== this.scope.generation
    ) {
      throw new Error("Archive pin response does not match its owner");
    }
    if (this.state === "released") {
      throw new Error("Archive pin owner closed during acquisition");
    }
    this.#state = "adopted";
  }
  async status(): Promise<ArchivePinState> {
    if (this.#state === "released") return "released";
    const { pinState } = await this.control({
      op: "pin-status",
      archive: this.scope.archive,
      pin: this.pin,
    });
    if (!pinState) throw new Error("Archive pin state is unavailable");
    if (this.state === "released") return "released";
    this.#state = pinState;
    return pinState;
  }
  async close(): Promise<void> {
    if (this.#state === "released") return;
    if (this.#state === "new") {
      this.#state = "released";
      return;
    }
    await this.control({
      op: "release",
      archive: this.scope.archive,
      pin: this.pin,
    });
    this.#state = "released";
  }
}

/** Acknowledges an operation and preserves both operation and cleanup errors. */
export async function withArchiveAcknowledgement<T>(
  operation: () => Promise<T>,
  acknowledge: (consumed: boolean) => Promise<unknown>,
): Promise<T> {
  let outcome: PromiseSettledResult<T>;
  try {
    outcome = { status: "fulfilled", value: await operation() };
  } catch (reason) {
    outcome = { status: "rejected", reason };
  }
  try {
    await acknowledge(outcome.status === "fulfilled");
  } catch (error) {
    if (outcome.status === "rejected" && error !== outcome.reason) {
      throw new AggregateError(
        [outcome.reason, error],
        "Archive transfer failed and acknowledgement also failed",
        { cause: outcome.reason },
      );
    }
    throw error;
  }
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
}

/** Reads and verifies one page directly, without a worker or document codec. */
export async function fetchArchivePage(
  transfer: ArchiveReadTransfer,
  hash: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(transfer.url, {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    headers: {
      authorization: `Bearer ${transfer.ticket.token}`,
      "content-type": "application/octet-stream",
    },
    body: new Uint8Array(0),
    signal,
  });
  const length = response.headers.get("content-length");
  if (
    length === null || !/^(0|[1-9][0-9]*)$/.test(length) ||
    Number(length) > ARCHIVE_LIMITS.pageBytes
  ) {
    await response.body?.cancel();
    throw new Error("Archive response has no bounded Content-Length");
  }
  const bytes = new Uint8Array(Number(length));
  let offset = 0;
  await readArchiveBody(response.body, bytes.length, (chunk) => {
    signal?.throwIfAborted();
    bytes.set(chunk, offset);
    offset += chunk.length;
  });
  if (!response.ok) throw new Error(new TextDecoder().decode(bytes));
  if (response.headers.get("content-type") !== "application/octet-stream") {
    throw new Error("Archive page response has an incompatible format");
  }
  if (archiveResponseHash(bytes) !== hash) {
    throw new Error("Archive response hash does not match the pinned page");
  }
  return bytes;
}

/** Determines the capability required by a fixed command. */
export function archiveAccess(command: ArchiveCommand): "read" | "write" {
  return [
      "pin",
      "pin-status",
      "release",
      "list",
      "count",
      "get",
      "pages",
      "read",
      "legacy-read",
    ].includes(command.op)
    ? "read"
    : "write";
}

/** Rejects malformed commands before issuing a capability or allocating a body. */
export function validateArchiveCommand(
  value: unknown,
): asserts value is ArchiveCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Archive command must be an object");
  }
  const command = value as Record<string, unknown>;
  const fields = new Set(["op"]);
  const text = (key: string, maximum: number, optional = false) => {
    fields.add(key);
    const field = command[key];
    if (optional && field === undefined) return;
    if (
      typeof field !== "string" || field.length === 0 || field.includes("\0") ||
      new TextEncoder().encode(field).length > maximum
    ) {
      throw new Error(`Invalid archive ${key}`);
    }
  };
  const integer = (
    key: string,
    maximum = Number.MAX_SAFE_INTEGER,
    optional = false,
  ) => {
    fields.add(key);
    const field = command[key];
    if (optional && field === undefined) return;
    if (
      !Number.isSafeInteger(field) || (field as number) < 0 ||
      (field as number) > maximum
    ) {
      throw new Error(`Invalid archive ${key}`);
    }
  };
  const identifier = (key: string) => {
    text(key, 64);
    if (!/^[a-f0-9-]+$/.test(command[key] as string)) {
      throw new Error(`Invalid archive ${key}`);
    }
  };
  const metadata = () => {
    text("metadata", ARCHIVE_LIMITS.metadataBytes);
    JSON.parse(command.metadata as string);
  };
  const hash = () => {
    text("hash", 64);
    if (!/^[a-f0-9]{64}$/.test(command.hash as string)) {
      throw new Error("Invalid archive hash");
    }
  };
  if (command.op === "open") {
    text("handle", 256);
    fields.add("readers");
    if (
      command.readers !== undefined &&
      (!Array.isArray(command.readers) || command.readers.length > 16 ||
        command.readers.some((reader) =>
          typeof reader !== "string" || reader.length > 256 ||
          !reader.startsWith("did:")
        ))
    ) {
      throw new Error("Invalid archive readers");
    }
  } else {
    identifier("archive");
    if (
      !["delete", "release", "pin-status", "legacy-read"].includes(
        String(command.op),
      )
    ) {
      identifier("generation");
    }
    switch (command.op) {
      case "begin":
        fields.add("base");
        if (command.base !== null) identifier("base");
        break;
      case "record":
        identifier("record");
        text("key", 256);
        text("source", 128);
        break;
      case "put":
        identifier("record");
        integer("index");
        integer("bytes", ARCHIVE_LIMITS.pageBytes);
        hash();
        metadata();
        break;
      case "complete-record":
        identifier("record");
        metadata();
        break;
      case "discard-record":
        identifier("record");
        break;
      case "retain":
        text("key", 256);
        break;
      case "source":
        text("source", 128);
        fields.add("complete");
        if (typeof command.complete !== "boolean") {
          throw new Error("Invalid archive source completeness");
        }
        break;
      case "publish":
      case "abort":
      case "prune":
      case "delete":
        break;
      case "pin":
        if (command.pin !== undefined) identifier("pin");
        integer("sequence", Number.MAX_SAFE_INTEGER, true);
        break;
      case "pin-status":
      case "release":
        identifier("pin");
        integer("sequence", Number.MAX_SAFE_INTEGER, true);
        break;
      case "legacy-read":
        text("id", 256);
        break;
      case "list":
        identifier("pin");
        text("after", 256, true);
        text("source", 128, true);
        integer("limit", ARCHIVE_LIMITS.rows, true);
        break;
      case "count":
        identifier("pin");
        text("source", 128, true);
        break;
      case "get":
        identifier("pin");
        text("key", 256);
        break;
      case "pages":
        identifier("pin");
        text("key", 256);
        integer("after", Number.MAX_SAFE_INTEGER, true);
        integer("limit", ARCHIVE_LIMITS.rows, true);
        break;
      case "read":
        identifier("pin");
        text("key", 256);
        integer("index");
        hash();
        break;
      default:
        throw new Error("Unknown archive command");
    }
  }
  for (const key of Object.keys(command)) {
    if (!fields.has(key)) throw new Error(`Unknown archive field: ${key}`);
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).length >
      ARCHIVE_LIMITS.controlBytes
  ) {
    throw new Error("Archive control message exceeds its byte limit");
  }
}

/** Reads at most a fixed byte count without using a whole-body helper. */
export async function readArchiveBody(
  body: ReadableStream<Uint8Array> | null,
  expected: number,
  consume: (chunk: Uint8Array) => void | Promise<void>,
): Promise<void> {
  if (body === null) {
    if (expected !== 0) throw new Error("Archive body is missing");
    return;
  }
  const reader = body.getReader();
  const failures: unknown[] = [];
  let count = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > expected) {
        throw new Error("Archive body exceeds its declared length");
      }
      for (
        let offset = 0;
        offset < value.length;
        offset += ARCHIVE_LIMITS.chunkBytes
      ) {
        await consume(
          value.subarray(offset, offset + ARCHIVE_LIMITS.chunkBytes),
        );
      }
    }
    if (count !== expected) {
      throw new Error("Archive body does not match its declared length");
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    await reader.cancel();
  } catch (error) {
    if (!failures.includes(error)) failures.push(error);
  } finally {
    reader.releaseLock();
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "Archive body failed and cancellation also failed",
      { cause: failures[0] },
    );
  }
}
