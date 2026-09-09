/** Stores enumeration and duplicate resolution on disk for one source scan. */

import { Database } from "@db/sqlite";
import { join, resolve } from "@std/path";

import type { NativeSessionFile } from "./native-session-log.ts";

/** One canonical session selected by the native inventory. */
export interface NativeInventorySession {
  /** Provider session identifier. */
  id: string;

  /** Canonical rollout path, absent for a database-only session. */
  path: string | null;

  /** Archive state, if the source supplies it. */
  archived: number | null;
}

/** A native database row associated with one session. */
export interface NativeInventoryRow {
  /** The Codex database containing the row. */
  database: "state" | "history";

  /** Original native table name. */
  table: string;

  /** Original native row identifier. */
  row: number | bigint;
}

const heldDirectories = new Set<string>();
const FILES = [
  "inventory.sqlite",
  "inventory.sqlite-wal",
  "inventory.sqlite-shm",
];

/** Validates private state before opening or removing it. */
function privateInfo(info: Deno.FileInfo, directory: boolean): void {
  if (info.isSymlink || (directory ? !info.isDirectory : !info.isFile)) {
    throw new Error(
      "Native inventory state must use plain files and directories",
    );
  }
  if (Deno.build.os === "windows") return;
  if (
    (info.uid !== null && info.uid !== Deno.uid()) ||
    (info.mode !== null && (info.mode & 0o077) !== 0)
  ) {
    throw new Error("Native inventory state must be private to its owner");
  }
}

/** Removes a previous scan only while the caller holds the directory lock. */
async function removeFiles(directory: string): Promise<void> {
  for (const name of FILES) {
    const path = join(directory, name);
    try {
      privateInfo(await Deno.lstat(path), false);
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

/**
 * Holds the scratch directory lock through a scan. Opening under the same lock
 * removes an interrupted scan; disposal removes the completed scan.
 */
export class NativeInventory implements AsyncDisposable {
  readonly #database: Database;
  readonly #directory: string;
  readonly #lock: Deno.FsFile;
  #closed = false;

  private constructor(
    database: Database,
    directory: string,
    lock: Deno.FsFile,
  ) {
    this.#database = database;
    this.#directory = directory;
    this.#lock = lock;
  }

  /** Opens private scratch storage after acquiring exclusive ownership. */
  static async open(path: string): Promise<NativeInventory> {
    const directory = resolve(path);
    if (heldDirectories.has(directory)) {
      throw new Error("Native inventory is already open");
    }
    heldDirectories.add(directory);
    let lock: Deno.FsFile | undefined;
    let database: Database | undefined;
    try {
      await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
      privateInfo(await Deno.lstat(directory), true);
      const lockPath = join(directory, "inventory.lock");
      let prior: Deno.FileInfo;
      try {
        prior = await Deno.lstat(lockPath);
        privateInfo(prior, false);
        lock = await Deno.open(lockPath, { read: true, write: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        lock = await Deno.open(lockPath, {
          createNew: true,
          read: true,
          write: true,
          mode: 0o600,
        });
        prior = await lock.stat();
      }
      const actual = await lock.stat();
      privateInfo(actual, false);
      if (prior.dev !== actual.dev || prior.ino !== actual.ino) {
        throw new Error("Native inventory lock was replaced");
      }
      if (!await lock.tryLock(true)) {
        throw new Error("Native inventory is already locked");
      }
      await removeFiles(directory);
      const databasePath = join(directory, FILES[0]);
      (await Deno.open(databasePath, {
        createNew: true,
        write: true,
        mode: 0o600,
      })).close();
      database = new Database(databasePath, { int64: true, parseJson: false });
      database.exec("PRAGMA cache_size = -2048");
      database.exec("PRAGMA mmap_size = 0");
      database.exec("PRAGMA temp_store = FILE");
      database.exec(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, path TEXT, archived INTEGER, mtime REAL, priority INTEGER NOT NULL DEFAULT 0)",
      );
      database.exec(
        "CREATE TABLE native_rows (id TEXT, database_name TEXT, table_name TEXT, native_row INTEGER, PRIMARY KEY (id, database_name, table_name, native_row))",
      );
      database.exec(
        "CREATE TABLE subagents (id TEXT, path TEXT, subagent TEXT, PRIMARY KEY(id,path))",
      );
      return new NativeInventory(database, directory, lock);
    } catch (error) {
      database?.close();
      lock?.close();
      heldDirectories.delete(directory);
      throw error;
    }
  }

  /**
   * Selects the database's canonical path first, then the newest file, then
   * the lexicographically first path. Selection does not depend on scan order.
   */
  addFile(file: NativeSessionFile, mtime: number, canonical = false): void {
    if (file.subagentId) {
      using session = this.#database.prepare(
        "INSERT OR IGNORE INTO sessions (id) VALUES (?)",
      );
      session.run(file.id);
      using subagent = this.#database.prepare(
        "INSERT OR IGNORE INTO subagents VALUES (?,?,?)",
      );
      subagent.run(file.id, file.path, file.subagentId);
      return;
    }
    using statement = this.#database.prepare(
      "INSERT INTO sessions (id,path,archived,mtime,priority) VALUES (?,?,?,?,?) " +
        "ON CONFLICT(id) DO UPDATE SET path=excluded.path, archived=excluded.archived, mtime=excluded.mtime, priority=excluded.priority " +
        "WHERE sessions.path IS NULL OR excluded.priority > sessions.priority OR " +
        "(excluded.priority = sessions.priority AND (excluded.mtime > sessions.mtime OR (excluded.mtime = sessions.mtime AND excluded.path < sessions.path)))",
    );
    statement.run(
      file.id,
      file.path,
      file.archived === null ? null : Number(file.archived),
      mtime,
      Number(canonical),
    );
  }

  /** Associates a native database row without collecting earlier row IDs. */
  addRow(id: string, row: NativeInventoryRow): void {
    using session = this.#database.prepare(
      "INSERT OR IGNORE INTO sessions (id) VALUES (?)",
    );
    session.run(id);
    using statement = this.#database.prepare(
      "INSERT OR IGNORE INTO native_rows VALUES (?,?,?,?)",
    );
    statement.run(id, row.database, row.table, row.row);
  }

  /** Reads one canonical session at a time. */
  *sessions(): Generator<NativeInventorySession> {
    using statement = this.#database.prepare(
      "SELECT id,path,archived FROM sessions ORDER BY id",
    );
    yield* statement.iter() as Iterable<NativeInventorySession>;
  }

  /** Reads one associated native database row at a time. */
  *rows(id: string): Generator<NativeInventoryRow> {
    using statement = this.#database.prepare(
      'SELECT database_name AS "database",table_name AS "table",native_row AS "row" FROM native_rows WHERE id = ? ORDER BY database_name,table_name,native_row',
    );
    yield* statement.iter(id) as Iterable<NativeInventoryRow>;
  }

  /** Reads child transcript paths associated with their native parent session. */
  *subagents(id: string): Generator<NativeSessionFile> {
    using statement = this.#database.prepare(
      "SELECT id,path,subagent AS subagentId,NULL AS archived FROM subagents WHERE id=? ORDER BY path",
    );
    yield* statement.iter(id) as Iterable<NativeSessionFile>;
  }

  /** Releases native resources and removes the scratch database. */
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#database.close();
      await removeFiles(this.#directory);
    } finally {
      this.#lock.close();
      heldDirectories.delete(this.#directory);
    }
  }
}
