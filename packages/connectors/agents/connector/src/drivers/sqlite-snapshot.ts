/** Reads native SQLite values within one read transaction using bounded I/O. */

import { Database } from "@db/sqlite";

/** One column in a native SQLite row. */
export interface NativeSqliteColumn {
  /** Original column name. */
  name: string;

  /** SQLite storage class of this value. */
  type: "null" | "integer" | "real" | "text" | "blob";
}

/** Quotes an identifier separately from bound SQL values. */
function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Pins one database revision until disposal. Concurrent WAL writes remain
 * outside this snapshot, including writes between opening two column BLOBs.
 */
export class NativeSqliteSnapshot implements Disposable {
  readonly #database: Database;

  /** Opens an existing database without writing its contents. */
  constructor(path: string) {
    this.#database = new Database(path, {
      readonly: true,
      create: false,
      int64: true,
      parseJson: false,
    });
    try {
      this.#database.exec("PRAGMA cache_size = -2048");
      this.#database.exec("PRAGMA mmap_size = 0");
      this.#database.exec("PRAGMA temp_store = FILE");
      this.#database.exec("BEGIN");
      using statement = this.#database.prepare(
        "SELECT count(*) FROM sqlite_schema",
      );
      statement.get();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  /** Checks for a native table without reading any row contents. */
  hasTable(table: string): boolean {
    using statement = this.#database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
    );
    return statement.get(table) !== undefined;
  }

  /** Checks the source schema without reading a native row. */
  hasColumn(table: string, column: string): boolean {
    using statement = this.#database.prepare(
      "SELECT 1 FROM pragma_table_info(?) WHERE name = ?",
    );
    return statement.get(table, column) !== undefined;
  }

  /** Returns one column's storage class without materializing its contents. */
  column(
    table: string,
    row: number | bigint,
    name: string,
  ): NativeSqliteColumn {
    using statement = this.#database.prepare(
      `SELECT typeof(${identifier(name)}) AS type FROM ${
        identifier(table)
      } WHERE rowid = ?`,
    );
    const result = statement.get<{ type: NativeSqliteColumn["type"] }>(row);
    if (!result) throw new Error("Native SQLite row disappeared from snapshot");
    return { name, type: result.type };
  }

  /** Enumerates row identifiers without materializing the selected rows. */
  *rows(table: string): Generator<number | bigint> {
    using statement = this.#database.prepare(
      `SELECT rowid AS rowid FROM ${identifier(table)} ORDER BY rowid`,
    );
    for (
      const row of statement.iter() as Iterable<{ rowid: number | bigint }>
    ) {
      yield row.rowid;
    }
  }

  /** Enumerates column names and storage classes without reading TEXT values. */
  *columns(table: string, row: number | bigint): Generator<NativeSqliteColumn> {
    using names = this.#database.prepare(
      "SELECT name FROM pragma_table_info(?) ORDER BY cid",
    );
    for (const { name } of names.iter(table) as Iterable<{ name: string }>) {
      yield this.column(table, row, name);
    }
  }

  /** Reads a numeric or null value without coercing text through SQLite. */
  scalar(
    table: string,
    row: number | bigint,
    column: NativeSqliteColumn,
  ): number | bigint | null {
    if (column.type === "text" || column.type === "blob") {
      throw new Error("Native SQLite text and blobs require incremental reads");
    }
    using statement = this.#database.prepare(
      `SELECT ${identifier(column.name)} AS value FROM ${
        identifier(table)
      } WHERE rowid = ?`,
    );
    const result = statement.get<{ value: number | bigint | null }>(row);
    if (!result) throw new Error("Native SQLite row disappeared from snapshot");
    return result.value;
  }

  /**
   * Reads a TEXT or BLOB column directly through sqlite3_blob_read. Each yielded
   * buffer remains owned by the caller until its next pull.
   */
  *bytes(
    table: string,
    row: number | bigint,
    column: string,
    readBytes: number,
  ): Generator<Uint8Array> {
    if (!Number.isSafeInteger(readBytes) || readBytes < 1) {
      throw new Error(
        "Native SQLite read size must be a positive safe integer",
      );
    }
    // The driver converts the row with BigInt before calling sqlite3_blob_open.
    const openBlob = this.#database.openBlob as (
      options: Omit<Parameters<Database["openBlob"]>[0], "row"> & {
        row: number | bigint;
      },
    ) => ReturnType<Database["openBlob"]>;
    const blob = openBlob.call(this.#database, {
      table,
      row,
      column,
      readonly: true,
    });
    try {
      const buffer = new Uint8Array(Math.min(readBytes, blob.byteLength));
      for (let offset = 0; offset < blob.byteLength; offset += buffer.length) {
        const part = buffer.subarray(
          0,
          Math.min(buffer.length, blob.byteLength - offset),
        );
        blob.readSync(offset, part);
        yield part;
      }
    } finally {
      blob.close();
    }
  }

  /** Reads at most the requested UTF-8 bytes for a bounded metadata field. */
  textPrefix(
    table: string,
    row: number | bigint,
    column: string,
    maxBytes: number,
  ): string {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const part of this.bytes(table, row, column, maxBytes)) {
      return decoder.decode(part, { stream: true });
    }
    return "";
  }

  /** Releases the database snapshot and all its native resources. */
  [Symbol.dispose](): void {
    if (!this.#database.open) return;
    try {
      this.#database.exec("ROLLBACK");
    } finally {
      this.#database.close();
    }
  }
}
