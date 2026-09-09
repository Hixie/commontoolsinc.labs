/** Exercises archive capability admission and raw transfers through Memory sessions. */

// deno-lint-ignore no-external-import
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { ArchiveStore } from "../v2/archive-store.ts";
import {
  ARCHIVE_LIMITS,
  type ArchiveAuthorization,
  type ArchiveCommand,
  ArchivePinOwner,
  type ArchiveResult,
  type ArchiveTicket,
  readArchiveBody,
} from "../v2/archive.ts";
import { Client, connect, loopback, type SpaceSession } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenAuth,
} from "./v2-auth-test-helpers.ts";

const owner = TEST_SESSION_OPEN_PRINCIPAL;
const reader = "did:key:z6Mk-archive-reader";
const stranger = "did:key:z6Mk-archive-stranger";
const policy: ArchiveAuthorization = {
  create(identity, readers) {
    return {
      writerPolicy: "test",
      cfcPolicy: JSON.stringify([identity.principal, ...readers]),
    };
  },
  authorize(binding, identity, access) {
    return access === "write"
      ? binding.writer === identity.principal
      : JSON.parse(binding.cfcPolicy).includes(identity.actingPrincipal);
  },
};

describe("authenticated archive protocol", () => {
  let root: string;
  let server: Server;
  let now: number;
  const clients: Client[] = [];

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "archive-protocol-test-" });
    now = Date.now();
    server = new Server({
      store: new URL("memory://archive-protocol-test"),
      authorizeSessionOpen: (message) => String(message.invocation?.principal),
      sessionOpenAuth: testSessionOpenAuth,
      acl: { mode: "off" },
      archive: {
        store: await ArchiveStore.open({ root, now: () => now }),
        authorization: policy,
        allowedOrigins: ["https://allowed.example"],
      },
    });
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    await server.close();
    await Deno.remove(root, { recursive: true });
  });
  async function mount(principal = owner) {
    const client = await connect({ transport: loopback(server) });
    clients.push(client);
    const session = await client.mount(
      owner,
      {},
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
          principal,
        },
        authorization: {},
      }),
    );
    return { client, session };
  }
  async function control(
    session: SpaceSession,
    command: ArchiveCommand,
  ): Promise<ArchiveResult> {
    if (command.op === "pin" && !command.pin) {
      const owner = new ArchivePinOwner(
        command,
        (next) => control(session, next),
      );
      await owner.acquire();
      return { pin: owner.pin, generation: command.generation };
    }
    const result = await session.archive(command);
    if (result instanceof Uint8Array) {
      throw new Error("Expected control response");
    }
    return result;
  }
  async function fixture(session: SpaceSession) {
    const binding = (await control(session, {
      op: "open",
      handle: "of:archive",
      readers: [reader],
    })).binding!;
    const generation = crypto.randomUUID();
    const record = crypto.randomUUID();
    await control(session, {
      op: "begin",
      archive: binding.id,
      generation,
      base: null,
    });
    await control(session, {
      op: "record",
      archive: binding.id,
      generation,
      record,
      key: "session",
      source: "test",
    });
    const bytes = new TextEncoder().encode(
      "native bytes without document revisions",
    );
    const hash = createHash("sha256").update(bytes).digest("hex");
    const put = {
      op: "put",
      archive: binding.id,
      generation,
      record,
      index: 0,
      hash,
      bytes: bytes.length,
      metadata: "{}",
    } as const;
    return { binding, generation, record, bytes, hash, put };
  }
  function ticket(
    client: Client,
    session: SpaceSession,
    command: ArchiveCommand,
  ): Promise<ArchiveTicket> {
    return client.request({
      type: "archive.ticket",
      requestId: crypto.randomUUID(),
      space: owner,
      sessionId: session.sessionId,
      command,
    });
  }
  function request(
    token: string,
    body: Uint8Array,
    headers: Record<string, string> = {},
  ) {
    return new Request("https://archive.example/api/storage/memory/archive", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "content-length": String(body.length),
        ...headers,
      },
      body: body.slice(),
    });
  }
  async function consume(response: Response): Promise<void> {
    await readArchiveBody(
      response.body,
      Number(response.headers.get("content-length")),
      () => {},
    );
  }

  it("negotiates fixed limits and transfers native bytes without document history", async () => {
    const { session } = await mount();
    expect(session.archiveLimits()).toEqual(ARCHIVE_LIMITS);
    const f = await fixture(session);
    await session.archive(f.put, f.bytes);
    await control(session, {
      op: "complete-record",
      archive: f.binding.id,
      generation: f.generation,
      record: f.record,
      metadata: "{}",
    });
    await control(session, {
      op: "publish",
      archive: f.binding.id,
      generation: f.generation,
    });
    const pin = (await control(session, {
      op: "pin",
      archive: f.binding.id,
      generation: f.generation,
    })).pin!;
    expect(
      await session.archive({
        op: "read",
        archive: f.binding.id,
        generation: f.generation,
        pin,
        key: "session",
        index: 0,
        hash: f.hash,
      }),
    ).toEqual(f.bytes);
    expect((await session.listEntityIds())?.ids).toEqual([]);
  });

  it("authorizes allowed readers and rejects unrelated principals even with ordinary ACL enforcement off", async () => {
    const writer = await mount();
    const f = await fixture(writer.session);
    await writer.session.archive(f.put, f.bytes);
    await control(writer.session, {
      op: "complete-record",
      archive: f.binding.id,
      generation: f.generation,
      record: f.record,
      metadata: "{}",
    });
    await control(writer.session, {
      op: "publish",
      archive: f.binding.id,
      generation: f.generation,
    });
    const allowed = await mount(reader);
    const pin = (await control(allowed.session, {
      op: "pin",
      archive: f.binding.id,
      generation: f.generation,
    })).pin!;
    expect(
      await allowed.session.archive({
        op: "read",
        archive: f.binding.id,
        generation: f.generation,
        pin,
        key: "session",
        index: 0,
        hash: f.hash,
      }),
    ).toEqual(f.bytes);
    const unrelated = await mount(stranger);
    await expect(
      control(unrelated.session, {
        op: "pin",
        archive: f.binding.id,
        generation: f.generation,
      }),
    ).rejects.toThrow("immutable policy");
    await expect(allowed.session.archive(f.put, f.bytes)).rejects.toThrow(
      "space ACL",
    );
  });

  it("rejects expired, replayed, cross-origin, and mismatched-length capabilities", async () => {
    const { client, session } = await mount();
    const f = await fixture(session);
    const expired = await ticket(client, session, f.put);
    now = expired.expiresAt;
    const expiredResponse = await server.handleArchiveRequest(
      request(expired.token, f.bytes),
    );
    expect(expiredResponse.status).toBe(403);
    await consume(expiredResponse);
    const origin = await ticket(client, session, f.put);
    const crossOrigin = await server.handleArchiveRequest(
      request(origin.token, f.bytes, { origin: "https://unrelated.example" }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.get("access-control-allow-origin")).toBeNull();
    await consume(crossOrigin);
    const valid = await server.handleArchiveRequest(
      request(origin.token, f.bytes, { origin: "https://allowed.example" }),
    );
    expect(valid.status).toBe(200);
    expect(valid.headers.get("cache-control")).toContain("no-store");
    expect(valid.headers.get("access-control-allow-origin")).toBe(
      "https://allowed.example",
    );
    await consume(valid);
    await client.request({
      type: "archive.ack",
      requestId: crypto.randomUUID(),
      space: owner,
      sessionId: session.sessionId,
      token: origin.token,
      consumed: true,
    });
    const replay = await server.handleArchiveRequest(
      request(origin.token, f.bytes),
    );
    expect(replay.status).toBe(403);
    await consume(replay);
    const wrongLength = await ticket(client, session, f.put);
    const mismatch = await server.handleArchiveRequest(
      request(wrongLength.token, f.bytes.subarray(1)),
    );
    expect(mismatch.status).toBe(400);
    await consume(mismatch);
  });

  it("rejects an attached capability after its Memory connection closes", async () => {
    const { client, session } = await mount();
    const f = await fixture(session);
    const capability = await ticket(client, session, f.put);
    await client.close();
    const response = await server.handleArchiveRequest(
      request(capability.token, f.bytes),
    );
    expect(response.status).toBe(403);
    await consume(response);
    expect(Array.from(Deno.readDirSync(`${root}/pages`))).toHaveLength(0);
  });
});
