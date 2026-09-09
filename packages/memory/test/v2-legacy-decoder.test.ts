/** Verifies allocation guards before legacy codec and patch expansion. */

import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { encodeMemoryBoundary } from "../v2.ts";
import {
  LEGACY_READ_LIMITS,
  LegacyReadRefused,
  readBoundedDocument,
} from "../v2/bounded-document.ts";
import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import { patchOpDescriptors } from "../v2/patch.ts";

describe("legacy decoder allocation guards", () => {
  let engine: Engine;
  let file: string;
  const id = "of:bounded-legacy";

  beforeEach(async () => {
    file = await Deno.makeTempFile();
    engine = await open({ url: toFileUrl(file), snapshotInterval: 0 });
    applyCommit(engine, {
      sessionId: "decoder-fixture",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id, value: { value: {} } }],
      },
    });
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(file);
  });

  function revision(op: "set" | "patch", wire: string): void {
    const insert = engine.database.prepare(
      "INSERT INTO revision VALUES ('',?,'space',2,0,?,?,1)",
    );
    const head = engine.database.prepare(
      "UPDATE head SET seq=2,op=? WHERE id=?",
    );
    try {
      insert.run(id, op, wire);
      head.run(op, id);
    } finally {
      insert.finalize();
      head.finalize();
    }
  }

  it("refuses symbol values before invoking process-global interning", () => {
    const key = `legacy-inspection-${crypto.randomUUID()}`;
    revision("set", 'fvj1:{"value":{"/Symbol@1":' + JSON.stringify(key) + "}}");
    using intern = stub(Symbol, "for", Symbol.for);
    let refused = false;
    try {
      readBoundedDocument(engine, id);
    } catch (error) {
      refused = error instanceof LegacyReadRefused;
    }
    expect(intern.calls.filter(({ args }) => args[0] === key)).toHaveLength(0);
    expect(refused).toBe(true);
  });

  it("refuses paths above the nesting budget before constructing their objects", () => {
    const path = "/value/" +
      Array(LEGACY_READ_LIMITS.depth + 1).fill("child").join("/");
    revision("patch", encodeMemoryBoundary([{ op: "add", path, value: 1 }]));
    using apply = stub(
      patchOpDescriptors.add,
      "apply",
      patchOpDescriptors.add.apply,
    );
    expect(() => readBoundedDocument(engine, id)).toThrow(LegacyReadRefused);
    expect(apply.calls).toHaveLength(0);
  });
});
