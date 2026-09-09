/** Checks storage and recovery failures found in the isolated archive review. */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Database } from "@db/sqlite";
import { ArchiveStore } from "../v2/archive-store.ts";
import { ArchiveHttp } from "../v2/archive-http.ts";
import type { ArchiveIdentity, ArchivePolicy } from "../v2/archive.ts";

const identity: ArchiveIdentity = {
  space: "did:key:archive-test",
  principal: "did:key:owner",
  actingPrincipal: "did:key:owner",
  sessionId: "session:owner",
  connectionId: "connection:owner",
};
const policy: ArchivePolicy = { writerPolicy: "agents", cfcPolicy: "{}" };
const authorize = () => Promise.resolve();

describe("archive implementation review", () => {
  it("acknowledges a committed deletion after the final binding check", async () => {
    const root = await Deno.makeTempDir({ prefix: "archive-test-delete-" });
    using store = await ArchiveStore.open({ root, now: () => 100 });
    const binding = store.openBinding(identity, "handle", policy);
    const http = new ArchiveHttp(store, (command) => {
      if (command.op === "open") return Promise.resolve(policy);
      store.binding(command.archive, command.op === "delete");
      return Promise.resolve(undefined);
    }, []);
    const ticket = await http.issue(
      { op: "delete", archive: binding.id },
      identity,
    );
    const response = await http.handle(
      new Request("http://archive.local/transfer", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ticket.token}`,
          "content-type": "application/octet-stream",
          "content-length": "0",
        },
        body: new Uint8Array(0),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    http.acknowledge(ticket.token, identity);
    expect(() => store.binding(binding.id)).toThrow("Archive does not exist");
    await http.close();
  });
  it("preserves byte quotas and freshly issued capability expiration times", async () => {
    const root = await Deno.makeTempDir({ prefix: "archive-test-integer-" });
    using store = await ArchiveStore.open({ root });
    expect(store.openBinding(identity, "handle", policy).quotaBytes).toBe(
      128 * 1024 ** 3,
    );
    const ticket = store.issueTicket(
      { op: "open", handle: "handle" },
      identity,
    );
    expect(ticket.expiresAt).toBeGreaterThan(Date.now());
    expect(store.consumeTicket(ticket.token)).toEqual({
      command: { op: "open", handle: "handle" },
      identity,
    });
  });
  it("holds canceled operation slots until authorization unwinds", async () => {
    const root = await Deno.makeTempDir({ prefix: "archive-test-ack-" });
    using store = await ArchiveStore.open({ root, now: () => 100 });
    let gated = false;
    let entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = 0;
    const http = new ArchiveHttp(store, async () => {
      if (gated) {
        held++;
        entered.resolve();
        await release.promise;
        held--;
      }
      return policy;
    }, []);
    const tickets = [];
    for (let i = 0; i < 3; i++) {
      tickets.push(
        await http.issue({ op: "open", handle: `handle-${i}` }, identity),
      );
    }
    gated = true;
    const responses: Promise<Response>[] = [];
    try {
      for (const ticket of tickets.slice(0, 2)) {
        entered = Promise.withResolvers<void>();
        responses.push(
          http.handle(
            new Request("http://archive.local/transfer", {
              method: "POST",
              headers: {
                authorization: `Bearer ${ticket.token}`,
                "content-type": "application/octet-stream",
                "content-length": "0",
              },
              body: new Uint8Array(0),
            }),
          ),
        );
        await entered.promise;
        http.acknowledge(ticket.token, identity);
      }
      const rejected = await http.handle(
        new Request("http://archive.local/transfer", {
          method: "POST",
          headers: {
            authorization: `Bearer ${tickets[2].token}`,
            "content-type": "application/octet-stream",
            "content-length": "0",
          },
          body: new Uint8Array(0),
        }),
      );
      expect(rejected.status).toBe(429);
      await rejected.body?.cancel();
      expect(held).toBe(2);
      console.log("early acknowledgement admission", {
        pendingOperations: held,
        configuredPrincipalLimit: 2,
      });
    } finally {
      release.resolve();
      for (const response of await Promise.all(responses)) {
        await response.body?.cancel();
      }
      await http.close();
    }
  });

  it("bounds pins across one principal's sessions", async () => {
    const root = await Deno.makeTempDir({ prefix: "archive-test-quota-" });
    const store = await ArchiveStore.open({
      root,
      quotaBytes: 1,
      quotaPages: 1,
    });
    try {
      const binding = store.openBinding(identity, "handle", policy);
      let generation = "a0";
      await store.execute(
        { op: "begin", archive: binding.id, generation, base: null },
        identity,
        authorize,
      );
      await store.execute(
        {
          op: "record",
          archive: binding.id,
          generation,
          record: "b0",
          key: "record",
          source: "source",
        },
        identity,
        authorize,
      );
      await store.execute(
        {
          op: "put",
          archive: binding.id,
          generation,
          record: "b0",
          index: 0,
          hash:
            "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
          bytes: 1,
          metadata: "{}",
        },
        identity,
        authorize,
        new Response("a").body,
      );
      await store.execute(
        {
          op: "complete-record",
          archive: binding.id,
          generation,
          record: "b0",
          metadata: "{}",
        },
        identity,
        authorize,
      );
      await store.execute(
        { op: "publish", archive: binding.id, generation },
        identity,
        authorize,
      );
      await store.execute(
        { op: "pin", archive: binding.id, generation },
        identity,
        authorize,
      );
      for (let i = 1; i <= 7; i++) {
        const next = `a${i.toString(16)}`;
        await store.execute(
          {
            op: "begin",
            archive: binding.id,
            generation: next,
            base: generation,
          },
          identity,
          authorize,
        );
        await store.execute(
          { op: "publish", archive: binding.id, generation: next },
          identity,
          authorize,
        );
        await store.execute(
          { op: "pin", archive: binding.id, generation: next },
          { ...identity, sessionId: `session:${i}` },
          authorize,
        );
        await store.execute(
          { op: "prune", archive: binding.id, generation: next },
          identity,
          authorize,
        );
        generation = next;
      }
      const database = new Database(`${root}/catalog.sqlite`, {
        readonly: true,
      });
      const rows = database.prepare(
        "SELECT (SELECT count(*) FROM generations) AS generations,(SELECT count(*) FROM members) AS members,(SELECT count(*) FROM pins) AS pins,usedBytes,usedPages,usedRecords FROM bindings",
      ).get();
      expect(rows).toEqual({
        generations: 8,
        members: 8,
        pins: 8,
        usedBytes: 1,
        usedPages: 1,
        usedRecords: 1,
      });
      await expect(
        store.execute({ op: "pin", archive: binding.id, generation }, {
          ...identity,
          sessionId: "session:extra",
        }, authorize),
      ).rejects.toThrow("pin limit exceeded");
      database.close();
    } finally {
      store[Symbol.dispose]();
    }
  });

  it("discovers an unfinished builder across restart and allows explicit abort", async () => {
    const root = await Deno.makeTempDir({ prefix: "archive-test-restart-" });
    const first = await ArchiveStore.open({ root });
    const binding = first.openBinding(identity, "handle", policy);
    await first.execute(
      { op: "begin", archive: binding.id, generation: "a0", base: null },
      identity,
      authorize,
    );
    first[Symbol.dispose]();
    using restarted = await ArchiveStore.open({ root });
    expect(restarted.binding(binding.id).generation).toBeNull();
    expect(restarted.binding(binding.id).pendingGeneration).toBe("a0");
    await restarted.execute(
      { op: "abort", archive: binding.id, generation: "a0" },
      identity,
      authorize,
    );
    expect(
      await restarted.execute(
        { op: "begin", archive: binding.id, generation: "a1", base: null },
        identity,
        authorize,
      ),
    ).toEqual({ generation: "a1" });
  });
});
