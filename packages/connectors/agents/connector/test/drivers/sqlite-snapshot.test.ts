/** Verifies native database reads retain one revision and bound TEXT reads. */

import { Database } from "@db/sqlite";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { NativeSqliteSnapshot } from "../../src/drivers/sqlite-snapshot.ts";

describe("native SQLite snapshots", () => {
  it("enumerates integer primary keys and reads their native values", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "agents-snapshot-test-",
    });
    try {
      const path = `${directory}/native.sqlite`;
      using resources = new DisposableStack();
      const writer = new Database(path);
      resources.defer(() => writer.close());
      writer.exec(
        "CREATE TABLE messages (id INTEGER PRIMARY KEY, value TEXT)",
      );
      writer.exec("INSERT INTO messages VALUES (-7, 'first')");
      writer.exec("INSERT INTO messages VALUES (9007199254740993, 'second')");
      using snapshot = new NativeSqliteSnapshot(path);
      const rows = [...snapshot.rows("messages")];
      expect(rows.map(String)).toEqual(["-7", "9007199254740993"]);
      expect(
        rows.map((row) => snapshot.textPrefix("messages", row, "value", 64)),
      )
        .toEqual(["first", "second"]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("keeps row enumeration and BLOB contents in the same WAL revision", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "agents-snapshot-test-",
    });
    try {
      const path = `${directory}/native.sqlite`;
      using resources = new DisposableStack();
      const writer = new Database(path);
      resources.defer(() => writer.close());
      writer.exec("PRAGMA journal_mode = WAL");
      writer.exec(
        "CREATE TABLE messages (id TEXT, value TEXT, ordinal INTEGER)",
      );
      writer.exec("INSERT INTO messages VALUES ('first', 'before', 1)");
      using snapshot = new NativeSqliteSnapshot(path);
      writer.exec("UPDATE messages SET value = 'after'");
      writer.exec("INSERT INTO messages VALUES ('second', 'later', 2)");
      expect([...snapshot.rows("messages")]).toEqual([1]);
      expect(snapshot.textPrefix("messages", 1, "value", 64)).toBe("before");
      expect([...snapshot.columns("messages", 1)]).toEqual([
        { name: "id", type: "text" },
        { name: "value", type: "text" },
        { name: "ordinal", type: "integer" },
      ]);
      using next = new NativeSqliteSnapshot(path);
      expect([...next.rows("messages")]).toEqual([1, 2]);
      expect(next.textPrefix("messages", 1, "value", 64)).toBe("after");
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("reads every TEXT byte and closes a BLOB when iteration stops early", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "agents-snapshot-test-",
    });
    try {
      const path = `${directory}/native.sqlite`;
      using resources = new DisposableStack();
      const database = new Database(path);
      resources.defer(() => database.close());
      database.exec("CREATE TABLE messages (value TEXT)");
      const expected = "🐈\\n".repeat(1024);
      using insert = database.prepare("INSERT INTO messages VALUES (?)");
      insert.run(expected);
      using snapshot = new NativeSqliteSnapshot(path);
      const decoder = new TextDecoder();
      let actual = "";
      for (const part of snapshot.bytes("messages", 1, "value", 17)) {
        expect(part.byteLength).toBeLessThanOrEqual(17);
        actual += decoder.decode(part, { stream: true });
      }
      actual += decoder.decode();
      expect(actual).toBe(expected);
      expect(snapshot.textPrefix("messages", 1, "value", 4)).toBe("🐈");
      expect(snapshot.textPrefix("messages", 1, "value", 2)).toBe("");
      expect(() =>
        snapshot.scalar("messages", 1, { name: "value", type: "text" })
      ).toThrow("incremental");
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
});
