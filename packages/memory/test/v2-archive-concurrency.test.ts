/** Checks whether abort prevents a pending upload from publishing into reused IDs. */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { ArchiveStore } from "../v2/archive-store.ts";
import type { ArchiveIdentity } from "../v2/archive.ts";

describe("archive collection cancellation", () => {
  it("rejects an old upload after its collection is aborted and its IDs reused", async () => {
    const root = await Deno.makeTempDir({ prefix: "archive-test-abort-" });
    const identity: ArchiveIdentity = {
      space: "did:key:archive-test",
      principal: "did:key:owner",
      actingPrincipal: "did:key:owner",
      sessionId: "session:owner",
      connectionId: "connection:owner",
    };
    const authorize = () => Promise.resolve();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      using store = await ArchiveStore.open({ root });
      const { id: archive } = store.openBinding(identity, "handle", {
        writerPolicy: "agents",
        cfcPolicy: "{}",
      });
      await store.execute(
        { op: "begin", archive, generation: "a0", base: null },
        identity,
        authorize,
      );
      await store.execute(
        {
          op: "record",
          archive,
          generation: "a0",
          record: "b0",
          key: "old-record",
          source: "source",
        },
        identity,
        authorize,
      );
      const upload = store.execute(
        {
          op: "put",
          archive,
          generation: "a0",
          record: "b0",
          index: 0,
          hash:
            "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
          bytes: 1,
          metadata: "{}",
        },
        identity,
        authorize,
        new ReadableStream({
          async pull(controller) {
            entered.resolve();
            await release.promise;
            controller.enqueue(new Uint8Array([97]));
            controller.close();
          },
        }, { highWaterMark: 0 }),
      ).then(() => "published", () => "rejected");
      try {
        await entered.promise;
        await store.execute(
          { op: "abort", archive, generation: "a0" },
          identity,
          authorize,
        );
        await store.execute(
          { op: "begin", archive, generation: "a0", base: null },
          identity,
          authorize,
        );
        await expect(store.execute(
          {
            op: "record",
            archive,
            generation: "a0",
            record: "b0",
            key: "different-record",
            source: "source",
          },
          identity,
          authorize,
        )).rejects.toThrow("record still has an active upload");
      } finally {
        release.resolve();
      }
      expect(await upload).toBe("rejected");
      for (const name of ["pages", "staging"]) {
        let files = 0;
        for await (const _entry of Deno.readDir(`${root}/${name}`)) files++;
        expect(files).toBe(0);
      }
      await store.execute(
        {
          op: "record",
          archive,
          generation: "a0",
          record: "b0",
          key: "different-record",
          source: "source",
        },
        identity,
        authorize,
      );
    } finally {
      release.resolve();
      await Deno.remove(root, { recursive: true });
    }
  });
});
