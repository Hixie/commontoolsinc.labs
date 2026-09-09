import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { toFileUrl } from "@std/path";
import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import { encodeMemoryBoundary, type EntityDocument } from "../v2.ts";
import {
  LEGACY_READ_LIMITS,
  LegacyReadRefused,
  readBoundedDocument,
} from "../v2/bounded-document.ts";

describe("bounded legacy document inspection", () => {
  let engine: Engine;
  let path: string;
  const id = "of:legacy";
  beforeEach(async () => {
    path = await Deno.makeTempFile();
    engine = await open({ url: toFileUrl(path), snapshotInterval: 0 });
    applyCommit(engine, {
      sessionId: "test",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id, value: { value: "initial" } }],
      },
    });
  });
  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  function revision(
    seq: number,
    op: string,
    wire: string | null,
    opIndex = 0,
  ): void {
    engine.database.prepare(
      "INSERT OR REPLACE INTO revision VALUES ('',?,'space',?,?,?,?,1)",
    ).run(id, seq, opIndex, op, wire);
    engine.database.prepare("UPDATE head SET seq=?,op_index=?,op=? WHERE id=?")
      .run(seq, opIndex, op, id);
  }
  function set(seq: number, document: EntityDocument) {
    revision(seq, "set", encodeMemoryBoundary(document));
  }
  function patch(seq: number) {
    revision(
      seq,
      "patch",
      encodeMemoryBoundary([{
        op: "replace",
        path: "/value/title",
        value: `title ${seq}`,
      }]),
    );
  }

  it("refuses oversized UTF-8 indexes and details before any payload query or document cache read", () => {
    for (
      const document of [{ value: "猫".repeat(LEGACY_READ_LIMITS.bytes) }, {
        value: {
          sessions: Array.from(
            { length: 1000 },
            (_, index) => ({ id: `of:session-${index}` }),
          ),
        },
      }]
    ) {
      set(2, document);
      const original = engine.database.prepare.bind(engine.database);
      using queries = stub(engine.database, "prepare", (sql) => {
        if (/SELECT (data|value) FROM/.test(sql)) {
          throw new Error("A payload was fetched before refusal");
        }
        return original(sql);
      });
      const misses = engine.documentCacheStats.misses;
      expect(() => readBoundedDocument(engine, id)).toThrow(LegacyReadRefused);
      expect(
        queries.calls.some(({ args }) =>
          args[0].includes("octet_length(r.data)")
        ),
      ).toBe(true);
      expect(engine.documentCacheStats.misses).toBe(misses);
    }
  });

  it("charges a small patch's materialization base and bounds the replay count and aggregate bytes", () => {
    set(2, { value: { title: "x".repeat(LEGACY_READ_LIMITS.bytes) } });
    patch(3);
    expect(() => readBoundedDocument(engine, id)).toThrow(LegacyReadRefused);
    set(4, { value: { title: "small" } });
    for (let seq = 5; seq < 70; seq++) patch(seq);
    expect(() => readBoundedDocument(engine, id)).toThrow(LegacyReadRefused);
    set(70, { value: { title: "small" } });
    for (let seq = 71; seq < 76; seq++) {
      revision(
        seq,
        "patch",
        encodeMemoryBoundary([{
          op: "replace",
          path: "/value/title",
          value: "x".repeat(4000),
        }]),
      );
    }
    expect(() => readBoundedDocument(engine, id)).toThrow(LegacyReadRefused);
  });

  it("uses a later small SET or snapshot without reading the old oversized history", () => {
    set(2, { value: "x".repeat(LEGACY_READ_LIMITS.bytes) });
    set(3, { value: { title: "new" } });
    patch(4);
    expect(readBoundedDocument(engine, id)).toEqual({
      value: { title: "title 4" },
    });
    set(5, { value: "x".repeat(LEGACY_READ_LIMITS.bytes) });
    patch(6);
    engine.database.prepare("INSERT INTO snapshot VALUES ('',?,'space',?,?)")
      .run(id, 6, encodeMemoryBoundary({ value: { title: "snapshot" } }));
    expect(readBoundedDocument(engine, id)).toEqual({
      value: { title: "snapshot" },
    });
    revision(7, "delete", null);
    revision(
      8,
      "patch",
      encodeMemoryBoundary([{
        op: "add",
        path: "/value",
        value: "after deletion",
      }]),
    );
    expect(readBoundedDocument(engine, id)).toEqual({
      value: "after deletion",
    });
  });

  it("rejects tiny encodings with excessive decoded depth, scalars, holes, or patch array indices", () => {
    for (
      const wire of [
        'fvj1:{"value":['.repeat(1) + '{"/hole":4294967295}]}',
        'fvj1:{"value":' + "[".repeat(40) + "0" + "]".repeat(40) + "}",
        encodeMemoryBoundary({
          value: "x".repeat(LEGACY_READ_LIMITS.scalar + 1),
        }),
        'fvj1:{"value":[{"/hole":3000},{"/hole":3000}]}',
      ]
    ) {
      revision(2, "set", wire);
      expect(() => readBoundedDocument(engine, id)).toThrow(LegacyReadRefused);
    }
    set(3, { value: [] });
    revision(
      4,
      "patch",
      encodeMemoryBoundary([{
        op: "add",
        path: "/value/4294967294",
        value: 1,
      }]),
    );
    expect(() => readBoundedDocument(engine, id)).toThrow(LegacyReadRefused);
  });
});
