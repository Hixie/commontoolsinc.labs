/** Checks ordered orphan collection across archives during crash recovery. */
import { Database } from "@db/sqlite";
import { expect } from "@std/expect";
import { ArchiveStore } from "../v2/archive-store.ts";
import type { ArchiveCommand, ArchiveIdentity } from "../v2/archive.ts";

Deno.test("archive GC seeks past prior hashes and preserves interleaved live pages across archives", async () => {
  const root = await Deno.makeTempDir({ prefix: "archive-gc-cursor-review-" });
  const allow = () => Promise.resolve();
  const identity: ArchiveIdentity = {
    space: "did:key:gc-space",
    principal: "did:key:owner",
    actingPrincipal: "did:key:owner",
    sessionId: "session",
    connectionId: "connection",
  };
  let store: ArchiveStore | undefined;
  try {
    store = await ArchiveStore.open({ root });
    const pages = [];
    for (const value of [1, 2, 3]) {
      const bytes = new Uint8Array([value]);
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      pages.push({ bytes, hash });
    }
    pages.sort((left, right) => left.hash.localeCompare(right.hash));
    const archives = [];
    for (const handle of ["first", "second"]) {
      const archive = store.openBinding(identity, handle, {
        writerPolicy: "test",
        cfcPolicy: "{}",
      }).id;
      const generation = crypto.randomUUID();
      archives.push({ archive, generation });
      await store.execute(
        { op: "begin", archive, generation, base: null },
        identity,
        allow,
      );
      for (const [index, page] of pages.entries()) {
        const record = crypto.randomUUID();
        const key = index === 1 ? "obsolete" : `live-${index}`;
        await store.execute(
          { op: "record", archive, generation, record, key, source: "test" },
          identity,
          allow,
        );
        await store.execute(
          {
            op: "put",
            archive,
            generation,
            record,
            index: 0,
            hash: page.hash,
            bytes: 1,
            metadata: "{}",
          },
          identity,
          allow,
          new Response(page.bytes.slice()).body,
        );
        await store.execute(
          {
            op: "complete-record",
            archive,
            generation,
            record,
            metadata: "{}",
          },
          identity,
          allow,
        );
      }
      await store.execute(
        { op: "publish", archive, generation },
        identity,
        allow,
      );
    }
    store[Symbol.dispose]();
    {
      const database = new Database(`${root}/catalog.sqlite`);
      try {
        database.exec(
          "PRAGMA foreign_keys=ON; DELETE FROM members WHERE key='obsolete'; DELETE FROM records WHERE key='obsolete'",
        );
        using plan = database.prepare(
          "EXPLAIN QUERY PLAN SELECT archive,hash FROM blobs WHERE (archive,hash)>(?,?) AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.archive=blobs.archive AND p.hash=blobs.hash) ORDER BY archive,hash LIMIT 1",
        );
        const details = plan.all<{ detail: string }>("", "").map((row) =>
          row.detail
        );
        expect(
          details.some((detail) =>
            detail.includes(
              "SEARCH blobs USING COVERING INDEX sqlite_autoindex_blobs_1",
            )
          ),
        ).toBe(true);
        expect(
          details.some((detail) =>
            detail.includes("SEARCH p USING COVERING INDEX page_archive_hash")
          ),
        ).toBe(true);
        expect(details.some((detail) => detail.includes("TEMP B-TREE"))).toBe(
          false,
        );
      } finally {
        database.close();
      }
    }
    expect(Array.from(Deno.readDirSync(`${root}/pages`))).toHaveLength(6);
    store = await ArchiveStore.open({ root });
    expect(Array.from(Deno.readDirSync(`${root}/pages`))).toHaveLength(4);
    for (const { archive, generation } of archives) {
      const result = await store.execute(
        { op: "pin", archive, generation },
        identity,
        allow,
      );
      if (result instanceof Uint8Array || !result.pin) {
        throw new Error("Expected reader pin");
      }
      for (const index of [0, 2]) {
        const command: ArchiveCommand = {
          op: "read",
          archive,
          generation,
          pin: result.pin,
          key: `live-${index}`,
          index: 0,
          hash: pages[index].hash,
        };
        expect(await store.execute(command, identity, allow)).toEqual(
          pages[index].bytes,
        );
      }
    }
    {
      const database = new Database(`${root}/catalog.sqlite`);
      try {
        using usage = database.prepare(
          "SELECT usedBytes,usedPages,usedRecords FROM bindings ORDER BY id",
        );
        expect(usage.all()).toEqual([
          { usedBytes: 2, usedPages: 2, usedRecords: 2 },
          { usedBytes: 2, usedPages: 2, usedRecords: 2 },
        ]);
      } finally {
        database.close();
      }
    }
  } finally {
    store?.[Symbol.dispose]();
    await Deno.remove(root, { recursive: true });
  }
});
