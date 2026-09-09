/** Measures incremental native SQLite TEXT reads in a separate reader process. */

import { Database } from "@db/sqlite";
import { parseArgs } from "@std/cli/parse-args";

import { createHasher } from "@commonfabric/content-hash";
import { NativeSqliteSnapshot } from "../src/drivers/sqlite-snapshot.ts";

const args = parseArgs(Deno.args, {
  string: ["bytes", "database"],
  boolean: ["generate"],
});
const bytes = Number(args.bytes ?? 8 * 1024 * 1024);
if (!Number.isSafeInteger(bytes) || bytes < 1) {
  throw new Error("Invalid byte count");
}

if (args.generate) {
  if (!args.database) throw new Error("Missing database path");
  const database = new Database(args.database);
  try {
    database.exec("PRAGMA cache_size = -2048");
    database.exec("CREATE TABLE native (value TEXT)");
    using insert = database.prepare(
      "INSERT INTO native VALUES (CAST(zeroblob(?) AS TEXT))",
    );
    insert.run(bytes);
    const blob = database.openBlob({
      table: "native",
      column: "value",
      row: 1,
      readonly: false,
    });
    try {
      const block = new Uint8Array(65536);
      for (let index = 0; index < block.length; index++) {
        block[index] = 32 + index % 95;
      }
      const hasher = createHasher();
      for (let offset = 0; offset < bytes; offset += block.length) {
        const part = block.subarray(0, Math.min(block.length, bytes - offset));
        blob.writeSync(offset, part);
        hasher.update(part);
      }
      console.log(hasher.digest("base64url"));
    } finally {
      blob.close();
    }
  } finally {
    database.close();
  }
} else {
  const directory = await Deno.makeTempDir({ prefix: "agents-sqlite-memory-" });
  try {
    const database = `${directory}/native.sqlite`;
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-ffi",
        import.meta.filename!,
        "--generate",
        "--bytes",
        String(bytes),
        "--database",
        database,
      ],
      stdout: "piped",
      stderr: "inherit",
    });
    const result = await child.output();
    if (!result.success) throw new Error("SQLite fixture generation failed");
    const expected = new TextDecoder().decode(result.stdout).trim();
    using snapshot = new NativeSqliteSnapshot(database);
    const hasher = createHasher();
    let read = 0;
    let rss = 0;
    let heapUsed = 0;
    for (const part of snapshot.bytes("native", 1, "value", 65536)) {
      hasher.update(part);
      read += part.byteLength;
      const usage = Deno.memoryUsage();
      rss = Math.max(rss, usage.rss);
      heapUsed = Math.max(heapUsed, usage.heapUsed);
    }
    const hash = hasher.digest("base64url");
    if (read !== bytes || hash !== expected) {
      throw new Error("SQLite byte verification failed");
    }
    console.log(JSON.stringify({ read, hash, rss, heapUsed }));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}
