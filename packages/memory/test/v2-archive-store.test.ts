/** Exercises immutable native pages and disk-backed generation recovery. */

// deno-lint-ignore no-external-import
import { createHash } from "node:crypto";
import { Database } from "@db/sqlite";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { ArchiveStore } from "../v2/archive-store.ts";
import {
  ARCHIVE_LIMITS,
  type ArchiveBinding,
  type ArchiveCommand,
  type ArchiveIdentity,
  type ArchiveResult,
} from "../v2/archive.ts";

const identity: ArchiveIdentity = {
  space: "did:key:owner",
  principal: "did:key:owner",
  actingPrincipal: "did:key:owner",
  sessionId: "session",
  connectionId: "connection",
};
const policy = { writerPolicy: "test", cfcPolicy: '{"version":1}' };
const allow = () => Promise.resolve();
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

describe("server-owned archive storage", () => {
  let root: string;
  let store: ArchiveStore;
  let binding: ArchiveBinding;

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "archive-store-test-" });
    store = await ArchiveStore.open({
      root,
      quotaBytes: 2 * ARCHIVE_LIMITS.pageBytes,
      quotaPages: 10,
    });
    binding = store.openBinding(identity, "of:test-archive", policy);
  });
  afterEach(async () => {
    store[Symbol.dispose]();
    await Deno.remove(root, { recursive: true });
  });

  async function control(command: ArchiveCommand): Promise<ArchiveResult> {
    const result = await store.execute(command, identity, allow);
    if (result instanceof Uint8Array) {
      throw new Error("Expected a control response");
    }
    return result;
  }
  async function begin(base: string | null = null): Promise<string> {
    const generation = crypto.randomUUID();
    await control({ op: "begin", archive: binding.id, generation, base });
    return generation;
  }
  async function record(generation: string, key = "session"): Promise<string> {
    const record = crypto.randomUUID();
    await control({
      op: "record",
      archive: binding.id,
      generation,
      record,
      key,
      source: "source",
    });
    return record;
  }
  function put(
    generation: string,
    record: string,
    bytes: Uint8Array,
    index = 0,
    authorize = allow,
  ) {
    return store.execute(
      {
        op: "put",
        archive: binding.id,
        generation,
        record,
        index,
        hash: hash(bytes),
        bytes: bytes.length,
        metadata: '{"kind":"native"}',
      },
      identity,
      authorize,
      new Response(bytes.slice()).body,
    );
  }
  async function complete(generation: string, record: string): Promise<void> {
    await control({
      op: "complete-record",
      archive: binding.id,
      generation,
      record,
      metadata: '{"title":"complete"}',
    });
  }
  async function publish(generation: string): Promise<string> {
    await control({ op: "publish", archive: binding.id, generation });
    return (await control({ op: "pin", archive: binding.id, generation })).pin!;
  }

  it("publishes exact immutable bytes and accepts a duplicate page", async () => {
    const generation = await begin();
    const version = await record(generation);
    const bytes = crypto.getRandomValues(
      new Uint8Array(ARCHIVE_LIMITS.pageBytes),
    );
    await put(generation, version, bytes);
    await put(generation, version, bytes);
    await expect(put(generation, version, new Uint8Array([1]))).rejects.toThrow(
      "immutable",
    );
    await complete(generation, version);
    const pin = await publish(generation);
    expect(
      (await control({ op: "list", archive: binding.id, generation, pin }))
        .records,
    ).toEqual([{
      key: "session",
      source: "source",
      record: version,
      metadata: '{"title":"complete"}',
      partial: false,
    }]);
    expect(
      await store.execute(
        {
          op: "read",
          archive: binding.id,
          generation,
          pin,
          key: "session",
          index: 0,
          hash: hash(bytes),
        },
        identity,
        allow,
      ),
    ).toEqual(bytes);
  });

  it("returns an absent lookup only after authorizing the generation pin", async () => {
    const generation = await begin();
    const pin = await publish(generation);
    const scope = { archive: binding.id, generation, pin, key: "absent" };
    expect(await control({ op: "get", ...scope })).toEqual({ records: [] });
    for (
      const command of [
        { op: "pages", ...scope },
        { op: "read", ...scope, index: 0, hash: hash(new Uint8Array(0)) },
      ] as const
    ) {
      await expect(control(command)).rejects.toThrow(
        "Archive record does not exist",
      );
    }
    await expect(control({ op: "get", ...scope, pin: crypto.randomUUID() }))
      .rejects.toThrow("Archive generation pin is unavailable");
    await expect(
      control({ op: "get", ...scope, generation: crypto.randomUUID() }),
    )
      .rejects.toThrow("Archive generation is unavailable");
    await expect(store.execute(
      { op: "get", ...scope },
      { ...identity, connectionId: "another-connection" },
      allow,
    )).rejects.toThrow("Archive generation pin is unavailable");
    const rejected = new Error("Injected authorization rejection");
    await expect(store.execute(
      { op: "get", ...scope },
      identity,
      () => Promise.reject(rejected),
    )).rejects.toBe(rejected);
    await control({ op: "release", archive: binding.id, pin });
    await expect(control({ op: "get", ...scope })).rejects.toThrow(
      "Archive generation pin is unavailable",
    );
  });

  it("retains the last complete record on partial collection and deletes missing records only after complete enumeration", async () => {
    const first = await begin();
    const version = await record(first);
    await put(first, version, new Uint8Array([1, 2, 3]));
    await complete(first, version);
    const oldPin = await publish(first);
    const partial = await begin(first);
    await control({
      op: "retain",
      archive: binding.id,
      generation: partial,
      key: "session",
    });
    await control({
      op: "source",
      archive: binding.id,
      generation: partial,
      source: "source",
      complete: false,
    });
    const partialPin = await publish(partial);
    expect(
      (await control({
        op: "list",
        archive: binding.id,
        generation: partial,
        pin: partialPin,
      })).records?.[0].partial,
    ).toBe(true);
    const missing = await begin(partial);
    await control({
      op: "source",
      archive: binding.id,
      generation: missing,
      source: "source",
      complete: true,
    });
    const newPin = await publish(missing);
    expect(
      (await control({
        op: "list",
        archive: binding.id,
        generation: missing,
        pin: newPin,
      })).records,
    ).toEqual([]);
    await control({ op: "prune", archive: binding.id, generation: missing });
    expect(
      await store.execute(
        {
          op: "read",
          archive: binding.id,
          generation: first,
          pin: oldPin,
          key: "session",
          index: 0,
          hash: hash(new Uint8Array([1, 2, 3])),
        },
        identity,
        allow,
      ),
    ).toEqual(new Uint8Array([1, 2, 3]));
    await control({ op: "release", archive: binding.id, pin: oldPin });
    await control({ op: "release", archive: binding.id, pin: partialPin });
    await control({ op: "prune", archive: binding.id, generation: missing });
    expect(Array.from(Deno.readDirSync(`${root}/pages`))).toHaveLength(0);
  });

  it("keeps rejected and interrupted uploads unreachable", async () => {
    const generation = await begin();
    const version = await record(generation);
    await expect(
      put(
        generation,
        version,
        new Uint8Array([1]),
        0,
        () => Promise.reject(new Error("revoked")),
      ),
    ).rejects.toThrow("revoked");
    const command = {
      op: "put",
      archive: binding.id,
      generation,
      record: version,
      index: 0,
      bytes: 3,
      hash: hash(new Uint8Array([1, 2, 3])),
      metadata: "{}",
    } as const;
    await expect(
      store.execute(
        command,
        identity,
        allow,
        new Response(new Uint8Array([1])).body,
      ),
    ).rejects.toThrow("declared length");
    await expect(
      store.execute(
        command,
        identity,
        allow,
        new Response(new Uint8Array([3, 2, 1])).body,
      ),
    ).rejects.toThrow("hash");
    expect(Array.from(Deno.readDirSync(`${root}/staging`))).toHaveLength(0);
    expect(Array.from(Deno.readDirSync(`${root}/pages`))).toHaveLength(0);
    await control({ op: "abort", archive: binding.id, generation });
    expect(store.binding(binding.id).generation).toBeNull();
  });

  it("rejects quota overflow and reclaims aborted native pages", async () => {
    const generation = await begin();
    const version = await record(generation);
    const bytes = new Uint8Array(ARCHIVE_LIMITS.pageBytes);
    await put(generation, version, bytes, 0);
    bytes.fill(1);
    await put(generation, version, bytes, 1);
    bytes.fill(2);
    await expect(put(generation, version, bytes, 2)).rejects.toThrow("quota");
    await control({ op: "abort", archive: binding.id, generation });
    const next = await begin();
    await put(next, await record(next), bytes);
  });

  it("recovers orphan files and persisted bindings while invalidating old capabilities", async () => {
    const generation = await begin();
    const version = await record(generation);
    const bytes = new Uint8Array([9]);
    await put(generation, version, bytes);
    await complete(generation, version);
    await publish(generation);
    const ticket = store.issueTicket(
      {
        op: "pin",
        archive: binding.id,
        generation,
        pin: crypto.randomUUID(),
      },
      identity,
      1,
    );
    store[Symbol.dispose]();
    await Deno.writeFile(
      `${root}/staging/${crypto.randomUUID()}`,
      new Uint8Array([1]),
      { mode: 0o600 },
    );
    await Deno.writeFile(
      `${root}/pages/${binding.id}-${"a".repeat(64)}`,
      new Uint8Array([1]),
      { mode: 0o600 },
    );
    store = await ArchiveStore.open({ root });
    expect(() => store.consumeTicket(ticket.token)).toThrow(
      "expired or consumed",
    );
    expect(store.binding(binding.id).generation).toBe(generation);
    const pin = (await control({ op: "pin", archive: binding.id, generation }))
      .pin!;
    expect(
      await store.execute(
        {
          op: "read",
          archive: binding.id,
          generation,
          pin,
          key: "session",
          index: 0,
          hash: hash(bytes),
        },
        identity,
        allow,
      ),
    ).toEqual(bytes);
    expect(Array.from(Deno.readDirSync(`${root}/staging`))).toHaveLength(0);
    expect(Array.from(Deno.readDirSync(`${root}/pages`))).toHaveLength(1);
  });

  it("opens the previous transient pin schema while preserving published source bytes", async () => {
    const generation = await begin();
    const version = await record(generation);
    const bytes = new Uint8Array([0, 255, 1, 128]);
    await put(generation, version, bytes);
    await complete(generation, version);
    const oldPin = await publish(generation);
    const oldToken = crypto.randomUUID();
    store[Symbol.dispose]();

    const legacy = new Database(`${root}/catalog.sqlite`);
    try {
      legacy.exec(`
        DROP TABLE pins;
        DROP TABLE pin_requests;
        CREATE TABLE pins (
          id TEXT PRIMARY KEY, generation TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
          identity TEXT NOT NULL
        );
      `);
      using pin = legacy.prepare("INSERT INTO pins VALUES (?,?,?)");
      pin.run(oldPin, generation, JSON.stringify(identity));
      using ticket = legacy.prepare("INSERT INTO tickets VALUES (?,?,?,?,?)");
      ticket.run(
        oldToken,
        identity.principal,
        Number.MAX_SAFE_INTEGER,
        JSON.stringify({ op: "pin", archive: binding.id, generation }),
        JSON.stringify(identity),
      );
    } finally {
      legacy.close();
    }

    store = await ArchiveStore.open({ root });
    expect(store.binding(binding.id).generation).toBe(generation);
    expect(store.pinState(binding.id, oldPin, identity)).toBe("released");
    expect(() => store.consumeTicket(oldToken)).toThrow("expired or consumed");
    const catalog = new Database(`${root}/catalog.sqlite`, { readonly: true });
    try {
      for (const table of ["pins", "tickets", "pin_requests"]) {
        using count = catalog.prepare(`SELECT count(*) AS count FROM ${table}`);
        expect(count.get<{ count: number }>()?.count).toBe(0);
      }
    } finally {
      catalog.close();
    }
    const pin = crypto.randomUUID();
    const ticket = store.issueTicket(
      { op: "pin", archive: binding.id, generation, pin },
      identity,
      1,
    );
    const admitted = store.consumeTicket(ticket.token);
    await store.execute(admitted.command, admitted.identity, allow);
    expect(store.pinState(binding.id, pin, identity, 1)).toBe("provisional");
    store.adoptPin(binding.id, pin, identity, 1);
    expect(
      await store.execute(
        {
          op: "read",
          archive: binding.id,
          generation,
          pin,
          key: "session",
          index: 0,
          hash: hash(bytes),
        },
        identity,
        allow,
      ),
    ).toEqual(bytes);
  });

  it("rejects rebinding, overlapping collections, missing pages, and corrupt stored bytes", async () => {
    expect(() =>
      store.openBinding(identity, binding.handle, {
        ...policy,
        cfcPolicy: "{}",
      })
    ).toThrow("immutable policy");
    const generation = await begin();
    await expect(begin()).rejects.toThrow("active collection");
    const version = await record(generation);
    const bytes = new Uint8Array([1]);
    await put(generation, version, bytes, 1);
    await expect(complete(generation, version)).rejects.toThrow(
      "missing pages",
    );
    await put(generation, version, bytes, 0);
    await complete(generation, version);
    const pin = await publish(generation);
    await Deno.writeFile(
      `${root}/pages/${binding.id}-${hash(bytes)}`,
      new Uint8Array([2]),
    );
    await expect(
      store.execute(
        {
          op: "read",
          archive: binding.id,
          generation,
          pin,
          key: "session",
          index: 0,
          hash: hash(bytes),
        },
        identity,
        allow,
      ),
    ).rejects.toThrow("corrupt");
  });
});
