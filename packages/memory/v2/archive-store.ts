/** Server-owned immutable pages with a disk-backed catalog and collection journal. */

import { Database } from "@db/sqlite";
import { createHasher, sha256 } from "@commonfabric/content-hash";
import { encodeHex } from "@std/encoding/hex";
import { join, resolve } from "@std/path";

import {
  ARCHIVE_LIMITS,
  type ArchiveBackend,
  type ArchiveBinding,
  type ArchiveCommand,
  type ArchiveIdentity,
  type ArchivePage,
  type ArchivePinState,
  type ArchivePolicy,
  type ArchiveRecord,
  type ArchiveResult,
  type ArchiveTicket,
  readArchiveBody,
} from "./archive.ts";

type Parameter = string | number | null;
type Generation = {
  id: string;
  archive: string;
  base: string | null;
  state: string;
};
type RecordVersion = {
  id: string;
  archive: string;
  generation: string;
  key: string;
  source: string;
  complete: number;
};

/** A consumed HTTP capability with its immutable command and authenticated identity. */
export interface ConsumedArchiveTicket {
  pinSequence?: number;
  /** Command admitted through the Memory session. */
  command: ArchiveCommand;
  /** Identity bound at admission. */
  identity: ArchiveIdentity;
}

/** Archive filesystem, quota, and security clock configuration. */
export interface ArchiveStoreOptions {
  /** Explicit private directory owned by the serving process. */
  root: string;
  /** Per-archive native byte quota, including staged pages. */
  quotaBytes?: number;
  /** Per-archive page quota, including staged pages. */
  quotaPages?: number;
  /** Security clock for expiring unused capabilities. */
  now?: () => number;
}

const heldRoots = new Set<string>();
const digest = (bytes: Uint8Array | string): string =>
  encodeHex(sha256(
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
  ));

function catalogRow<T>(value: unknown): T {
  if (value === undefined) return value as T;
  const row = value as Record<string, unknown>;
  for (const [key, field] of Object.entries(row)) {
    if (typeof field === "bigint") {
      const number = Number(field);
      if (!Number.isSafeInteger(number)) {
        throw new Error("Archive catalog integer exceeds precision");
      }
      row[key] = number;
    }
  }
  return row as T;
}

function privateInfo(info: Deno.FileInfo, directory: boolean): void {
  if (info.isSymlink || (directory ? !info.isDirectory : !info.isFile)) {
    throw new Error("Archive storage must use plain files and directories");
  }
  if (
    Deno.build.os !== "windows" &&
    ((info.mode !== null && (info.mode & 0o077) !== 0) ||
      info.uid !== Deno.uid())
  ) {
    throw new Error("Archive storage must be private to its owner");
  }
}

function syncDirectory(path: string): void {
  using directory = Deno.openSync(path, { read: true });
  directory.syncSync();
}

function openPrivate(path: string, write = false): Deno.FsFile {
  const before = Deno.lstatSync(path);
  privateInfo(before, false);
  const file = Deno.openSync(path, { read: true, write });
  try {
    const after = file.statSync();
    privateInfo(after, false);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("Archive file was replaced");
    }
    return file;
  } catch (error) {
    file.close();
    throw error;
  }
}

/**
 * Stores metadata in SQLite and native bytes in immutable files. Queries use
 * fixed shapes and bounded results. Generation membership remains on disk.
 */
export class ArchiveStore implements ArchiveBackend {
  readonly #database: Database;
  readonly #root: string;
  readonly #lock: Deno.FsFile;
  readonly #options: ArchiveStoreOptions;
  readonly #now: () => number;
  readonly #writing = new Set<string>();
  #closed = false;

  private constructor(
    database: Database,
    root: string,
    lock: Deno.FsFile,
    options: ArchiveStoreOptions,
  ) {
    this.#database = database;
    this.#root = root;
    this.#lock = lock;
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Acquires exclusive storage ownership and recovers interrupted filesystem work. */
  static async open(options: ArchiveStoreOptions): Promise<ArchiveStore> {
    const requested = resolve(options.root);
    await Deno.mkdir(requested, { recursive: true, mode: 0o700 });
    privateInfo(await Deno.lstat(requested), true);
    const root = await Deno.realPath(requested);
    if (heldRoots.has(root)) throw new Error("Archive root is already open");
    heldRoots.add(root);
    let lock: Deno.FsFile | undefined;
    let database: Database | undefined;
    try {
      for (const quota of [options.quotaBytes, options.quotaPages]) {
        if (
          quota !== undefined && (!Number.isSafeInteger(quota) || quota < 1)
        ) throw new Error("Archive quotas must be positive safe integers");
      }
      const lockPath = join(root, "archive.lock");
      try {
        lock = openPrivate(lockPath, true);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        lock = await Deno.open(lockPath, {
          createNew: true,
          read: true,
          write: true,
          mode: 0o600,
        });
      }
      if (!await lock.tryLock(true)) {
        throw new Error("Archive root is already locked");
      }
      for (const name of ["pages", "staging"]) {
        await Deno.mkdir(join(root, name), { recursive: true, mode: 0o700 });
        privateInfo(await Deno.lstat(join(root, name)), true);
      }
      const catalogPath = join(root, "catalog.sqlite");
      try {
        openPrivate(catalogPath).close();
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        (await Deno.open(catalogPath, {
          createNew: true,
          write: true,
          mode: 0o600,
        })).close();
      }
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        try {
          openPrivate(catalogPath + suffix).close();
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
      database = new Database(catalogPath, { parseJson: false, int64: true });
      database.exec(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA cache_size = -2048; PRAGMA mmap_size = 0; PRAGMA temp_store = FILE; PRAGMA foreign_keys = ON",
      );
      database.exec(`
        CREATE TABLE IF NOT EXISTS bindings (
          id TEXT PRIMARY KEY, space TEXT NOT NULL, handle TEXT NOT NULL,
          owner TEXT NOT NULL, writer TEXT NOT NULL, writerPolicy TEXT NOT NULL,
          cfcPolicy TEXT NOT NULL, schema INTEGER NOT NULL, quotaBytes INTEGER NOT NULL,
          quotaPages INTEGER NOT NULL, generation TEXT, deleted INTEGER NOT NULL DEFAULT 0,
          usedBytes INTEGER NOT NULL DEFAULT 0, usedPages INTEGER NOT NULL DEFAULT 0,
          usedRecords INTEGER NOT NULL DEFAULT 0,
          UNIQUE(space,handle)
        );
        CREATE TABLE IF NOT EXISTS generations (
          id TEXT PRIMARY KEY, archive TEXT NOT NULL REFERENCES bindings(id), base TEXT,
          state TEXT NOT NULL CHECK(state IN ('building','published'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS one_builder ON generations(archive) WHERE state = 'building';
        CREATE TABLE IF NOT EXISTS records (
          id TEXT PRIMARY KEY, archive TEXT NOT NULL REFERENCES bindings(id),
          generation TEXT NOT NULL,
          key TEXT NOT NULL, source TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS members (
          generation TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
          key TEXT NOT NULL, record TEXT NOT NULL REFERENCES records(id),
          seen INTEGER NOT NULL DEFAULT 0, partial INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(generation,key)
        );
        CREATE TABLE IF NOT EXISTS blobs (
          archive TEXT NOT NULL REFERENCES bindings(id), hash TEXT NOT NULL, bytes INTEGER NOT NULL,
          PRIMARY KEY(archive,hash)
        );
        CREATE TABLE IF NOT EXISTS pages (
          record TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, page INTEGER NOT NULL,
          hash TEXT NOT NULL, bytes INTEGER NOT NULL, metadata TEXT NOT NULL,
          archive TEXT NOT NULL REFERENCES bindings(id),
          PRIMARY KEY(record,page)
        );
        CREATE INDEX IF NOT EXISTS page_archive_hash ON pages(archive,hash);
        CREATE INDEX IF NOT EXISTS member_record ON members(record);
        DROP TABLE IF EXISTS pins;
        CREATE TABLE pins (
          id TEXT PRIMARY KEY, generation TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
          identity TEXT NOT NULL, sequence INTEGER, state TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tickets (
          token TEXT PRIMARY KEY, principal TEXT NOT NULL, expires INTEGER NOT NULL,
          command TEXT NOT NULL, identity TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ticket_principal ON tickets(principal);
        CREATE TABLE IF NOT EXISTS pin_requests (
          identity TEXT PRIMARY KEY, sequence INTEGER NOT NULL, request_sequence INTEGER NOT NULL, archive TEXT NOT NULL,
          pin TEXT NOT NULL, generation TEXT NOT NULL, state TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS count_blob_insert AFTER INSERT ON blobs BEGIN
          UPDATE bindings SET usedBytes=usedBytes+new.bytes WHERE id=new.archive;
        END;
        CREATE TRIGGER IF NOT EXISTS count_blob_delete AFTER DELETE ON blobs BEGIN
          UPDATE bindings SET usedBytes=usedBytes-old.bytes WHERE id=old.archive;
        END;
        CREATE TRIGGER IF NOT EXISTS count_page_insert AFTER INSERT ON pages BEGIN
          UPDATE bindings SET usedPages=usedPages+1 WHERE id=new.archive;
        END;
        CREATE TRIGGER IF NOT EXISTS count_page_delete AFTER DELETE ON pages BEGIN
          UPDATE bindings SET usedPages=usedPages-1 WHERE id=old.archive;
        END;
        CREATE TRIGGER IF NOT EXISTS count_record_insert AFTER INSERT ON records BEGIN
          UPDATE bindings SET usedRecords=usedRecords+1 WHERE id=new.archive;
        END;
        CREATE TRIGGER IF NOT EXISTS count_record_delete AFTER DELETE ON records BEGIN
          UPDATE bindings SET usedRecords=usedRecords-1 WHERE id=old.archive;
        END;
        DELETE FROM tickets;
        DELETE FROM pins;
        DELETE FROM pin_requests;
      `);
      const store = new ArchiveStore(database, root, lock, options);
      await store.#recoverFiles();
      return store;
    } catch (error) {
      database?.close();
      lock?.close();
      heldRoots.delete(root);
      throw error;
    }
  }

  #get<T>(sql: string, ...parameters: Parameter[]): T | undefined {
    using statement = this.#database.prepare(sql);
    return catalogRow<T | undefined>(statement.get(...parameters));
  }

  #run(sql: string, ...parameters: Parameter[]): void {
    using statement = this.#database.prepare(sql);
    statement.run(...parameters);
  }

  #count(sql: string, ...parameters: Parameter[]): number {
    return this.#get<{ count: number }>(sql, ...parameters)?.count ?? 0;
  }

  /** Retrieves only the authoritative binding named by the request. */
  binding(id: string, includeDeleted = false): ArchiveBinding {
    const binding = this.#get<ArchiveBinding>(
      "SELECT *, (SELECT id FROM generations WHERE archive=bindings.id AND state='building') AS pendingGeneration FROM bindings WHERE id = ?",
      id,
    );
    if (!binding || (binding.deleted && !includeDeleted)) {
      throw new Error("Archive does not exist");
    }
    return { ...binding, deleted: Boolean(binding.deleted) };
  }

  /** Opens a stable handle without permitting an existing binding to be relabeled. */
  openBinding(
    identity: ArchiveIdentity,
    handle: string,
    policy: ArchivePolicy,
  ): ArchiveBinding {
    const previous = this.#get<ArchiveBinding>(
      "SELECT * FROM bindings WHERE space = ? AND handle = ?",
      identity.space,
      handle,
    );
    if (previous) {
      if (
        previous.owner !== identity.principal ||
        previous.writerPolicy !== policy.writerPolicy ||
        previous.cfcPolicy !== policy.cfcPolicy || previous.deleted
      ) {
        throw new Error(
          "Archive handle is already bound to a different immutable policy",
        );
      }
      return this.binding(previous.id);
    }
    if (
      this.#count(
        "SELECT count(*) AS count FROM bindings WHERE owner = ?",
        identity.principal,
      ) >= 128
    ) throw new Error("Archive binding quota exceeded");
    if (
      new TextEncoder().encode(policy.cfcPolicy).length >
        ARCHIVE_LIMITS.metadataBytes
    ) throw new Error("Archive policy exceeds its byte limit");
    const id = digest(`${identity.space}\0${handle}`);
    this.#run(
      "INSERT INTO bindings (id,space,handle,owner,writer,writerPolicy,cfcPolicy,schema,quotaBytes,quotaPages) VALUES (?,?,?,?,?,?,?,2,?,?)",
      id,
      identity.space,
      handle,
      identity.principal,
      identity.principal,
      policy.writerPolicy,
      policy.cfcPolicy,
      this.#options.quotaBytes ?? 128 * 1024 ** 3,
      this.#options.quotaPages ?? 4_000_000,
    );
    return this.binding(id);
  }

  /** Issues a short-lived single-purpose capability without retaining it in memory. */
  issueTicket(
    command: ArchiveCommand,
    identity: ArchiveIdentity,
    pinSequence?: number,
  ): ArchiveTicket {
    this.#run("DELETE FROM tickets WHERE expires <= ?", this.#now());
    if (
      this.#count("SELECT count(*) AS count FROM tickets") >= 128 ||
      this.#count(
          "SELECT count(*) AS count FROM tickets WHERE principal = ?",
          identity.principal,
        ) >= 8
    ) {
      throw new Error("Archive capability limit exceeded");
    }
    if (command.op === "pin") {
      if (
        !command.pin || !Number.isSafeInteger(pinSequence) || pinSequence! < 1
      ) {
        throw new Error("Archive pin requires a client request and sequence");
      }
      const owner = JSON.stringify(identity);
      this.#claimPinSession(identity);
      const previous = this.#get<{ sequence: number; state: ArchivePinState }>(
        "SELECT sequence,state FROM pin_requests WHERE identity=?",
        owner,
      );
      if (previous && pinSequence! <= previous.sequence) {
        throw new Error("Archive pin request sequence was already used");
      }
      if (previous?.state === "pending" || previous?.state === "provisional") {
        throw new Error(
          "Archive session already owns a provisional pin request",
        );
      }
      if (this.#get("SELECT 1 FROM pins WHERE id=?", command.pin)) {
        throw new Error("Archive pin request identifier is already in use");
      }
      if (
        this.#generation(command.archive, command.generation).state !==
          "published"
      ) {
        throw new Error("Archive generation is not published");
      }
      this.#database.transaction(() => {
        this.#createPin(
          command.archive,
          command.generation,
          command.pin!,
          identity,
          pinSequence!,
          "pending",
        );
        this.#run(
          "INSERT INTO pin_requests VALUES (?,?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET sequence=excluded.sequence,request_sequence=excluded.request_sequence,archive=excluded.archive,pin=excluded.pin,generation=excluded.generation,state=excluded.state",
          owner,
          pinSequence!,
          pinSequence!,
          command.archive,
          command.pin!,
          command.generation,
          "pending",
        );
      }).immediate();
    }
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const expiresAt = this.#now() + 60_000;
    this.#run(
      "INSERT INTO tickets VALUES (?,?,?,?,?)",
      digest(token),
      identity.principal,
      expiresAt,
      JSON.stringify({
        command: command.op === "pin"
          ? { ...command, sequence: pinSequence }
          : command,
        pinSequence,
      }),
      JSON.stringify(identity),
    );
    return {
      token,
      expiresAt,
      bytes: command.op === "put" ? command.bytes : 0,
    };
  }

  /** Consumes a nonce durably before its HTTP body is accepted. */
  consumeTicket(token: string): ConsumedArchiveTicket {
    const row = this.#database.transaction(() => {
      const row = this.#get<
        { command: string; identity: string; expires: number }
      >(
        "SELECT command,identity,expires FROM tickets WHERE token = ?",
        digest(token),
      );
      this.#run("DELETE FROM tickets WHERE token = ?", digest(token));
      return row;
    }).immediate();
    if (!row || row.expires <= this.#now()) {
      throw new Error("Archive capability is expired or consumed");
    }
    const { command, pinSequence } = JSON.parse(row.command) as {
      command: ArchiveCommand;
      pinSequence?: number;
    };
    return { command, identity: JSON.parse(row.identity), pinSequence };
  }

  /** Revokes an unused capability only for its issuing session. */
  revokeTicket(token: string, identity: ArchiveIdentity): void {
    const row = this.#get<{ identity: string }>(
      "SELECT identity FROM tickets WHERE token=?",
      digest(token),
    );
    if (row && row.identity !== JSON.stringify(identity)) {
      throw new Error("Archive capability belongs to a different session");
    }
    this.#run("DELETE FROM tickets WHERE token=?", digest(token));
  }

  #generation(archive: string, id: string, building = false): Generation {
    const generation = this.#get<Generation>(
      "SELECT * FROM generations WHERE archive = ? AND id = ?",
      archive,
      id,
    );
    if (!generation || (building && generation.state !== "building")) {
      throw new Error("Archive generation is unavailable");
    }
    return generation;
  }

  #record(archive: string, generation: string, id: string): RecordVersion {
    this.#generation(archive, generation, true);
    const record = this.#get<RecordVersion>(
      "SELECT * FROM records WHERE archive = ? AND generation = ? AND id = ?",
      archive,
      generation,
      id,
    );
    if (!record || record.complete) {
      throw new Error("Archive record is not being collected");
    }
    return record;
  }

  #pin(
    command: { archive: string; generation: string; pin: string },
    identity: ArchiveIdentity,
  ): void {
    this.#generation(command.archive, command.generation);
    if (this.pinState(command.archive, command.pin, identity) !== "adopted") {
      throw new Error("Archive generation pin is unavailable");
    }
    if (
      !this.#get(
        "SELECT 1 FROM pins WHERE id = ? AND generation = ? AND identity = ?",
        command.pin,
        command.generation,
        JSON.stringify(identity),
      )
    ) {
      throw new Error("Archive generation pin is unavailable");
    }
  }

  #findMember(generation: string, key: string): ArchiveRecord | undefined {
    const record = this.#get<ArchiveRecord>(
      "SELECT m.key,r.source,m.record,r.metadata,m.partial FROM members m JOIN records r ON r.id = m.record WHERE m.generation = ? AND m.key = ?",
      generation,
      key,
    );
    return record ? { ...record, partial: Boolean(record.partial) } : undefined;
  }

  #member(generation: string, key: string): ArchiveRecord {
    const record = this.#findMember(generation, key);
    if (!record) throw new Error("Archive record does not exist");
    return record;
  }

  #page(record: string, index: number): ArchivePage {
    const page = this.#get<ArchivePage>(
      'SELECT page AS "index",hash,bytes,metadata FROM pages WHERE record = ? AND page = ?',
      record,
      index,
    );
    if (!page) throw new Error("Archive page does not exist");
    return page;
  }

  #pagePath(archive: string, hash: string): string {
    return join(this.#root, "pages", `${archive}-${hash}`);
  }

  /** Executes a fixed command after authentication, with a final publication check. */
  async execute(
    command: ArchiveCommand,
    identity: ArchiveIdentity,
    authorize: () => Promise<void>,
    body: ReadableStream<Uint8Array> | null = null,
    policy?: ArchivePolicy,
  ): Promise<ArchiveResult | Uint8Array> {
    if (this.#closed) throw new Error("Archive store is closed");
    if (command.op === "open") {
      if (!policy) throw new Error("Archive policy is unavailable");
      await authorize();
      return { binding: this.openBinding(identity, command.handle, policy) };
    }
    let binding = this.binding(command.archive, command.op === "delete");
    if (binding.space !== identity.space) {
      throw new Error("Archive belongs to a different space");
    }
    if (command.op === "put") {
      return await this.#put(command, binding, authorize, body);
    }
    if (command.op === "read") {
      this.#pin(command, identity);
      const member = this.#member(command.generation, command.key);
      const page = this.#page(member.record, command.index);
      if (page.hash !== command.hash) {
        throw new Error("Archive page hash does not match the pinned page");
      }
      using file = openPrivate(this.#pagePath(binding.id, page.hash));
      if (file.statSync().size !== page.bytes) {
        throw new Error("Archive page length is corrupt");
      }
      const bytes = new Uint8Array(page.bytes);
      let offset = 0;
      const hash = createHasher();
      while (offset < bytes.length) {
        const count = await file.read(
          bytes.subarray(
            offset,
            Math.min(offset + ARCHIVE_LIMITS.chunkBytes, bytes.length),
          ),
        );
        if (!count) throw new Error("Archive page is truncated");
        hash.update(bytes.subarray(offset, offset + count));
        offset += count;
      }
      if (encodeHex(hash.digest()) !== page.hash) {
        throw new Error("Archive page hash is corrupt");
      }
      await authorize();
      this.#pin(command, identity);
      return bytes;
    }
    await authorize();
    binding = this.binding(command.archive, command.op === "delete");
    switch (command.op) {
      case "legacy-read":
        throw new Error(
          "Legacy documents belong to the Memory document backend",
        );
      case "begin": {
        const previous = this.#get<Generation>(
          "SELECT * FROM generations WHERE id = ?",
          command.generation,
        );
        if (previous) {
          if (
            previous.archive !== binding.id || previous.base !== command.base
          ) throw new Error("Archive generation is already bound");
          return { generation: previous.id };
        }
        if (binding.generation !== command.base) {
          throw new Error("Archive generation changed before collection");
        }
        if (
          this.#get(
            "SELECT 1 FROM generations WHERE archive=? AND state='building'",
            binding.id,
          )
        ) throw new Error("Archive already has an active collection");
        if (
          this.#count(
            "SELECT count(*) AS count FROM generations WHERE archive=?",
            binding.id,
          ) >= ARCHIVE_LIMITS.generations
        ) throw new Error("Archive generation quota exceeded");
        this.#database.transaction(() => {
          this.#run(
            "INSERT INTO generations VALUES (?,?,?,'building')",
            command.generation,
            binding.id,
            command.base,
          );
          if (command.base !== null) {
            this.#run(
              "INSERT INTO members (generation,key,record) SELECT ?,key,record FROM members WHERE generation = ?",
              command.generation,
              command.base,
            );
          }
        }).immediate();
        return { generation: command.generation };
      }
      case "record": {
        this.#generation(binding.id, command.generation, true);
        const previous = this.#get<RecordVersion>(
          "SELECT * FROM records WHERE id = ?",
          command.record,
        );
        if (!previous && this.#writing.has(command.record)) {
          throw new Error("Archive record still has an active upload");
        }
        if (
          previous &&
          (previous.archive !== binding.id ||
            previous.generation !== command.generation ||
            previous.key !== command.key || previous.source !== command.source)
        ) throw new Error("Archive record is already bound");
        if (
          !previous &&
          this.#count(
              "SELECT usedRecords AS count FROM bindings WHERE id=?",
              binding.id,
            ) >= binding.quotaPages
        ) throw new Error("Archive record quota exceeded");
        this.#run(
          "INSERT OR IGNORE INTO records (id,archive,generation,key,source) VALUES (?,?,?,?,?)",
          command.record,
          binding.id,
          command.generation,
          command.key,
          command.source,
        );
        return {};
      }
      case "complete-record": {
        const record = this.#record(
          binding.id,
          command.generation,
          command.record,
        );
        const shape = this.#get<{ count: number; last: number | null }>(
          "SELECT count(*) AS count,max(page) AS last FROM pages WHERE record = ?",
          record.id,
        )!;
        if (shape.count !== (shape.last ?? -1) + 1) {
          throw new Error("Archive record has missing pages");
        }
        this.#database.transaction(() => {
          this.#run(
            "UPDATE records SET complete = 1,metadata = ? WHERE id = ?",
            command.metadata,
            record.id,
          );
          this.#run(
            "INSERT INTO members VALUES (?,?,?,1,0) ON CONFLICT(generation,key) DO UPDATE SET record=excluded.record,seen=1,partial=0",
            command.generation,
            record.key,
            record.id,
          );
        }).immediate();
        return {};
      }
      case "discard-record":
        this.#record(binding.id, command.generation, command.record);
        this.#run("DELETE FROM records WHERE id = ?", command.record);
        this.#collectGarbage();
        return {};
      case "retain":
        this.#generation(binding.id, command.generation, true);
        this.#run(
          "UPDATE members SET seen=1,partial=1 WHERE generation=? AND key=?",
          command.generation,
          command.key,
        );
        return {};
      case "source":
        this.#generation(binding.id, command.generation, true);
        if (command.complete) {
          this.#run(
            "DELETE FROM members WHERE generation=? AND seen=0 AND record IN (SELECT id FROM records WHERE source=?)",
            command.generation,
            command.source,
          );
        }
        return {};
      case "publish": {
        const generation = this.#generation(binding.id, command.generation);
        if (binding.generation !== generation.id) {
          if (
            binding.generation !== generation.base ||
            generation.state !== "building"
          ) throw new Error("Archive generation publication conflicts");
          if (
            this.#count(
              "SELECT count(*) AS count FROM records WHERE generation = ? AND complete = 0",
              generation.id,
            )
          ) throw new Error("Archive generation has unfinished records");
          this.#database.transaction(() => {
            this.#run(
              "UPDATE generations SET state='published' WHERE id=?",
              generation.id,
            );
            this.#run(
              "UPDATE bindings SET generation=? WHERE id=?",
              generation.id,
              binding.id,
            );
          }).immediate();
        }
        return {
          generation: generation.id,
          count: this.#count(
            "SELECT count(*) AS count FROM members WHERE generation=?",
            generation.id,
          ),
        };
      }
      case "abort":
        this.#generation(binding.id, command.generation, true);
        this.#database.transaction(() => {
          this.#run(
            "DELETE FROM members WHERE generation=?",
            command.generation,
          );
          this.#run(
            "DELETE FROM records WHERE generation=?",
            command.generation,
          );
          this.#run("DELETE FROM generations WHERE id=?", command.generation);
        }).immediate();
        this.#collectGarbage();
        return {};
      case "pin-status":
        return {
          pinState: this.pinState(
            command.archive,
            command.pin,
            identity,
            command.sequence,
          ),
        };
      case "pin": {
        const request = command.pin
          ? this.#get<
            {
              state: ArchivePinState;
              request_sequence: number;
              generation: string;
            }
          >(
            "SELECT state,request_sequence,generation FROM pin_requests WHERE identity=? AND archive=? AND pin=?",
            JSON.stringify(identity),
            command.archive,
            command.pin,
          )
          : undefined;
        if (
          (request &&
            (request.state !== "pending" ||
              request.request_sequence !== command.sequence ||
              request.generation !== command.generation)) ||
          (command.sequence !== undefined && !request)
        ) throw new Error("Archive pin request is unavailable");
        if (
          this.#generation(binding.id, command.generation).state !== "published"
        ) {
          throw new Error("Archive generation is not published");
        }
        const pin = command.pin ?? crypto.randomUUID();
        if (request) {
          this.#database.transaction(() => {
            this.#run(
              "UPDATE pins SET state='provisional' WHERE id=? AND identity=? AND sequence=? AND state='pending'",
              pin,
              JSON.stringify(identity),
              command.sequence!,
            );
            this.#run(
              "UPDATE pin_requests SET state='provisional' WHERE identity=? AND archive=? AND pin=? AND request_sequence=? AND state='pending'",
              JSON.stringify(identity),
              command.archive,
              pin,
              command.sequence!,
            );
          }).immediate();
        } else {this.#createPin(
            command.archive,
            command.generation,
            pin,
            identity,
          );}
        return { pin, generation: command.generation };
      }
      case "release":
        this.releasePin(
          command.archive,
          command.pin,
          identity,
          true,
          command.sequence,
        );
        return {};
      case "get": {
        this.#pin(command, identity);
        const record = this.#findMember(command.generation, command.key);
        return { records: record ? [record] : [] };
      }
      case "count":
        this.#pin(command, identity);
        return {
          count: this.#count(
            "SELECT count(*) AS count FROM members m JOIN records r ON r.id=m.record WHERE m.generation=? AND (? IS NULL OR r.source=?)",
            command.generation,
            command.source ?? null,
            command.source ?? null,
          ),
        };
      case "list": {
        this.#pin(command, identity);
        using statement = this.#database.prepare(
          "SELECT m.key,r.source,m.record,r.metadata,m.partial FROM members m JOIN records r ON r.id=m.record WHERE m.generation=? AND m.key>? AND (? IS NULL OR r.source=?) ORDER BY m.key LIMIT ?",
        );
        const records: ArchiveRecord[] = [];
        let bytes = 32;
        for (
          const row of statement.iter(
            command.generation,
            command.after ?? "",
            command.source ?? null,
            command.source ?? null,
            command.limit ?? ARCHIVE_LIMITS.rows,
          ) as Iterable<ArchiveRecord>
        ) {
          const next = {
            ...catalogRow<ArchiveRecord>(row),
            partial: Boolean(row.partial),
          };
          bytes += new TextEncoder().encode(JSON.stringify(next)).length + 1;
          if (bytes > ARCHIVE_LIMITS.controlBytes) break;
          records.push(next);
        }
        return { records };
      }
      case "pages": {
        this.#pin(command, identity);
        const member = this.#member(command.generation, command.key);
        using statement = this.#database.prepare(
          'SELECT page AS "index",hash,bytes,metadata FROM pages WHERE record=? AND page>? ORDER BY page LIMIT ?',
        );
        const pages: ArchivePage[] = [];
        let bytes = 32;
        for (
          const row of statement.iter(
            member.record,
            command.after ?? -1,
            command.limit ?? ARCHIVE_LIMITS.rows,
          )
        ) {
          const page = catalogRow<ArchivePage>(row);
          bytes += new TextEncoder().encode(JSON.stringify(page)).length + 1;
          if (bytes > ARCHIVE_LIMITS.controlBytes) break;
          pages.push(page);
        }
        return { pages };
      }
      case "prune":
        if (binding.generation !== command.generation) {
          throw new Error("Archive pruning requires the published generation");
        }
        this.#database.transaction(() => {
          this.#run(
            "DELETE FROM members WHERE generation IN (SELECT id FROM generations WHERE archive=? AND state='published' AND id!=? AND id NOT IN (SELECT generation FROM pins))",
            binding.id,
            command.generation,
          );
          this.#run(
            "DELETE FROM generations WHERE archive=? AND state='published' AND id!=? AND id NOT IN (SELECT generation FROM pins)",
            binding.id,
            command.generation,
          );
        }).immediate();
        this.#collectGarbage();
        return {};
      case "delete":
        this.#database.transaction(() => {
          this.#run(
            "DELETE FROM members WHERE generation IN (SELECT id FROM generations WHERE archive=?)",
            binding.id,
          );
          this.#run("DELETE FROM records WHERE archive=?", binding.id);
          this.#run("DELETE FROM generations WHERE archive=?", binding.id);
          this.#run(
            "UPDATE bindings SET deleted=1,generation=NULL WHERE id=?",
            binding.id,
          );
        }).immediate();
        this.#collectGarbage();
        return {};
    }
  }

  async #put(
    command: Extract<ArchiveCommand, { op: "put" }>,
    binding: ArchiveBinding,
    authorize: () => Promise<void>,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<ArchiveResult> {
    const record = this.#record(binding.id, command.generation, command.record);
    if (this.#writing.has(record.id)) {
      throw new Error("Archive record already has an active upload");
    }
    this.#writing.add(record.id);
    const staging = join(this.#root, "staging", crypto.randomUUID());
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      this.#writing.delete(record.id);
      try {
        await Deno.remove(staging);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    });
    {
      const existing = this.#get<ArchivePage>(
        'SELECT page AS "index",hash,bytes,metadata FROM pages WHERE record=? AND page=?',
        record.id,
        command.index,
      );
      if (
        existing &&
        (existing.hash !== command.hash || existing.bytes !== command.bytes ||
          existing.metadata !== command.metadata)
      ) throw new Error("Archive page is immutable");
      const usage = this.#get<{ bytes: number; pages: number }>(
        "SELECT usedBytes AS bytes,usedPages AS pages FROM bindings WHERE id=?",
        binding.id,
      )!;
      const known = this.#get(
        "SELECT 1 FROM blobs WHERE archive=? AND hash=?",
        binding.id,
        command.hash,
      );
      if (
        (!known && usage.bytes + command.bytes > binding.quotaBytes) ||
        (!existing && usage.pages + 1 > binding.quotaPages)
      ) throw new Error("Archive storage quota exceeded");
      using file = await Deno.open(staging, {
        createNew: true,
        write: true,
        mode: 0o600,
      });
      const hash = createHasher();
      await readArchiveBody(body, command.bytes, async (chunk) => {
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          offset += await file.write(chunk.subarray(offset));
        }
      });
      if (encodeHex(hash.digest()) !== command.hash) {
        throw new Error("Archive upload hash does not match");
      }
      await file.sync();
      await authorize();
      this.#record(binding.id, command.generation, record.id);
      const current = this.binding(binding.id);
      const latestUsage = this.#get<{ bytes: number; pages: number }>(
        "SELECT usedBytes AS bytes,usedPages AS pages FROM bindings WHERE id=?",
        binding.id,
      )!;
      const currentKnown = this.#get(
        "SELECT 1 FROM blobs WHERE archive=? AND hash=?",
        binding.id,
        command.hash,
      );
      if (
        (!currentKnown &&
          latestUsage.bytes + command.bytes > current.quotaBytes) ||
        (!existing && latestUsage.pages + 1 > current.quotaPages)
      ) throw new Error("Archive storage quota exceeded");
      const path = this.#pagePath(binding.id, command.hash);
      Deno.renameSync(staging, path);
      syncDirectory(join(this.#root, "pages"));
      this.#database.transaction(() => {
        this.#run(
          "INSERT OR IGNORE INTO blobs VALUES (?,?,?)",
          binding.id,
          command.hash,
          command.bytes,
        );
        this.#run(
          "INSERT OR IGNORE INTO pages VALUES (?,?,?,?,?,?)",
          record.id,
          command.index,
          command.hash,
          command.bytes,
          command.metadata,
          binding.id,
        );
      }).immediate();
      return {
        page: {
          index: command.index,
          hash: command.hash,
          bytes: command.bytes,
          metadata: command.metadata,
        },
      };
    }
  }

  #collectGarbage(): void {
    this.#run(
      "DELETE FROM records WHERE NOT EXISTS (SELECT 1 FROM members WHERE record=records.id) AND NOT EXISTS (SELECT 1 FROM generations WHERE id=records.generation AND state='building')",
    );
    let archive = "";
    let hash = "";
    while (true) {
      const blob = this.#get<{ archive: string; hash: string }>(
        "SELECT archive,hash FROM blobs WHERE (archive,hash)>(?,?) AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.archive=blobs.archive AND p.hash=blobs.hash) ORDER BY archive,hash LIMIT 1",
        archive,
        hash,
      );
      if (!blob) break;
      try {
        Deno.removeSync(this.#pagePath(blob.archive, blob.hash));
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      this.#run(
        "DELETE FROM blobs WHERE archive=? AND hash=?",
        blob.archive,
        blob.hash,
      );
      archive = blob.archive;
      hash = blob.hash;
    }
  }

  async #recoverFiles(): Promise<void> {
    for await (const entry of Deno.readDir(join(this.#root, "staging"))) {
      const path = join(this.#root, "staging", entry.name);
      privateInfo(await Deno.lstat(path), false);
      await Deno.remove(path);
    }
    for await (const entry of Deno.readDir(join(this.#root, "pages"))) {
      const path = join(this.#root, "pages", entry.name);
      privateInfo(await Deno.lstat(path), false);
      const parts = /^([a-f0-9]{64})-([a-f0-9]{64})$/.exec(entry.name);
      if (!parts) throw new Error("Unexpected archive page filename");
      if (
        !this.#get(
          "SELECT 1 FROM blobs WHERE archive=? AND hash=?",
          parts[1],
          parts[2],
        )
      ) await Deno.remove(path);
    }
    this.#collectGarbage();
  }

  #claimPinSession(identity: ArchiveIdentity): void {
    if (
      this.#get(
        "SELECT 1 FROM pin_requests WHERE identity=?",
        JSON.stringify(identity),
      )
    ) return;
    if (
      this.#count("SELECT count(*) AS count FROM pin_requests") >=
        ARCHIVE_LIMITS.pinSessions ||
      this.#count(
          "SELECT count(*) AS count FROM pin_requests WHERE json_extract(identity,'$.principal')=?",
          identity.principal,
        ) >= ARCHIVE_LIMITS.principalPinSessions
    ) {
      throw new Error("Archive pin session state limit exceeded");
    }
  }

  #createPin(
    archive: string,
    generation: string,
    pin: string,
    identity: ArchiveIdentity,
    sequence: number | null = null,
    state: ArchivePinState = "adopted",
  ): void {
    if (
      this.#count("SELECT count(*) AS count FROM pins") >=
        ARCHIVE_LIMITS.pins ||
      this.#count(
          "SELECT count(*) AS count FROM pins WHERE json_extract(identity,'$.principal')=?",
          identity.principal,
        ) >= ARCHIVE_LIMITS.principalPins
    ) {
      throw new Error("Archive pin limit exceeded");
    }
    if (this.binding(archive).space !== identity.space) {
      throw new Error("Archive belongs to a different space");
    }
    this.#run(
      "INSERT INTO pins VALUES (?,?,?,?,?)",
      pin,
      generation,
      JSON.stringify(identity),
      sequence,
      state,
    );
  }

  /** Returns only the exact request named by this authenticated identity. */
  pinState(
    archive: string,
    pin: string,
    identity: ArchiveIdentity,
    sequence?: number,
  ): ArchivePinState {
    const owner = JSON.stringify(identity);
    const live = this.#get<{ state: ArchivePinState }>(
      "SELECT state FROM pins WHERE id=? AND identity=? AND (? IS NULL OR sequence=?) AND generation IN (SELECT id FROM generations WHERE archive=?)",
      pin,
      owner,
      sequence ?? null,
      sequence ?? null,
      archive,
    );
    if (live) return live.state;
    const request = this.#get<{ state: ArchivePinState }>(
      "SELECT state FROM pin_requests WHERE identity=? AND archive=? AND pin=? AND (? IS NULL OR request_sequence=?)",
      owner,
      archive,
      pin,
      sequence ?? null,
      sequence ?? null,
    );
    return request?.state ?? "released";
  }

  /** Commits the exact provisional request after response verification and authorization. */
  adoptPin(
    archive: string,
    pin: string,
    identity: ArchiveIdentity,
    sequence?: number,
  ): void {
    const state = this.pinState(archive, pin, identity, sequence);
    if (state === "adopted") return;
    if (state !== "provisional") {
      throw new Error("Archive pin request cannot be adopted");
    }
    this.#database.transaction(() => {
      this.#run(
        "UPDATE pins SET state='adopted' WHERE id=? AND identity=? AND (? IS NULL OR sequence=?) AND state='provisional'",
        pin,
        JSON.stringify(identity),
        sequence ?? null,
        sequence ?? null,
      );
      this.#run(
        "UPDATE pin_requests SET state='adopted' WHERE identity=? AND archive=? AND pin=? AND (? IS NULL OR request_sequence=?) AND state='provisional'",
        JSON.stringify(identity),
        archive,
        pin,
        sequence ?? null,
        sequence ?? null,
      );
    }).immediate();
  }

  /** Releases this request's resources; explicit owner closure also releases adopted pins. */
  releasePin(
    archive: string,
    pin: string,
    identity: ArchiveIdentity,
    adopted = false,
    sequence?: number,
    remember = false,
  ): void {
    const owner = JSON.stringify(identity);
    if (sequence !== undefined && remember) {
      this.#claimPinSession(identity);
      this.#run(
        "INSERT INTO pin_requests VALUES (?,?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET sequence=max(sequence,excluded.sequence)",
        owner,
        sequence,
        sequence,
        archive,
        pin,
        "",
        "released",
      );
    }
    if (
      !adopted && this.pinState(archive, pin, identity, sequence) === "adopted"
    ) return;
    this.#database.transaction(() => {
      this.#run(
        "DELETE FROM pins WHERE id=? AND identity=? AND (? IS NULL OR sequence=?) AND generation IN (SELECT id FROM generations WHERE archive=?)",
        pin,
        owner,
        sequence ?? null,
        sequence ?? null,
        archive,
      );
      this.#run(
        "UPDATE pin_requests SET state='released' WHERE identity=? AND archive=? AND pin=? AND (? IS NULL OR request_sequence=?)",
        owner,
        archive,
        pin,
        sequence ?? null,
        sequence ?? null,
      );
      this.#run(
        "DELETE FROM tickets WHERE identity=? AND json_extract(command,'$.command.archive')=? AND json_extract(command,'$.command.pin')=? AND (? IS NULL OR json_extract(command,'$.pinSequence')=?)",
        owner,
        archive,
        pin,
        sequence ?? null,
        sequence ?? null,
      );
    }).immediate();
  }

  /** Clears bounded reader state when the transport closes. */
  closeReaders(): void {
    this.#database.exec(
      "DELETE FROM pins; DELETE FROM tickets; DELETE FROM pin_requests;",
    );
  }

  /** Withdraws this session's pins and unused capabilities at connection detach. */
  detach(identity: ArchiveIdentity): void {
    this.#run("DELETE FROM pins WHERE identity=?", JSON.stringify(identity));
    this.#run("DELETE FROM tickets WHERE identity=?", JSON.stringify(identity));
    this.#run(
      "DELETE FROM pin_requests WHERE identity=?",
      JSON.stringify(identity),
    );
  }

  /** Removes pins and capabilities when their authenticated attachment ends. */
  detachSession(space: string, sessionId: string, connectionId: string): void {
    for (const table of ["pins", "tickets", "pin_requests"]) {
      this.#run(
        `DELETE FROM ${table} WHERE json_extract(identity,'$.space')=? AND json_extract(identity,'$.sessionId')=? AND json_extract(identity,'$.connectionId')=?`,
        space,
        sessionId,
        connectionId,
      );
    }
  }

  /** Closes the catalog and releases exclusive filesystem ownership. */
  [Symbol.dispose](): void {
    if (this.#closed) return;
    this.#closed = true;
    this.closeReaders();
    this.#database.close();
    this.#lock.close();
    heldRoots.delete(this.#root);
  }
}
