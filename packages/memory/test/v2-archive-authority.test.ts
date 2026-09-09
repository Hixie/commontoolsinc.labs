/** Exercises archive authority through real Memory session admission. */
import { Database } from "@db/sqlite";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ArchiveStore } from "../v2/archive-store.ts";
import {
  ARCHIVE_LIMITS,
  type ArchiveAuthorization,
  type ArchiveCommand,
  type ArchiveIdentity,
  ArchivePinOwner,
  type ArchivePinReference,
  type ArchiveResult,
  type ArchiveTicket,
} from "../v2/archive.ts";
import { Client, connect, loopback, type SpaceSession } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import { testSessionOpenAuth } from "./v2-auth-test-helpers.ts";
import { decodeMemoryBoundary } from "../v2.ts";

const space = "did:key:archive-authority-space";
const owner = "did:key:archive-authority-owner";
const readerPrincipal = "did:key:archive-authority-reader";
const service = "did:key:archive-authority-delegating";

describe("archive authority review", () => {
  let root: string;
  let server: Server;
  let authority: SpaceSession;
  let localSeq: number;
  let readersDenied: boolean;
  const clients: Client[] = [];
  const policy: ArchiveAuthorization = {
    create(identity, readers) {
      return {
        writerPolicy: "test",
        cfcPolicy: JSON.stringify([identity.principal, ...readers]),
      };
    },
    authorize(binding, identity, access) {
      if (access === "write") return binding.writer === identity.principal;
      return !readersDenied &&
        JSON.parse(binding.cfcPolicy).includes(identity.actingPrincipal);
    },
  };

  async function mount(principal = owner, actingAs?: "space-owner") {
    const client = await connect({ transport: loopback(server) });
    clients.push(client);
    const session = await client.mount(
      space,
      actingAs ? { actingAs } : {},
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

  async function acl(value: Record<string, "OWNER" | "READ" | "WRITE">) {
    await authority.transact({
      localSeq: ++localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: `of:${space}`, value: { value } }],
    });
  }

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "archive-authority-review-" });
    localSeq = 0;
    readersDenied = false;
    server = new Server({
      store: new URL("memory://archive-authority-review"),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: (message) => String(message.invocation?.principal),
      sessionOpenAuth: testSessionOpenAuth,
      acl: { mode: "enforce", delegatingDids: [service] },
      archive: {
        store: await ArchiveStore.open({ root }),
        authorization: policy,
        allowedOrigins: ["https://allowed.example"],
      },
    });
    authority = (await mount(space)).session;
    await acl({ [owner]: "OWNER", [readerPrincipal]: "READ" });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    await server.close();
    await Deno.remove(root, { recursive: true });
  });

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
      throw new Error("Expected archive metadata");
    }
    return result;
  }

  async function fixture(session: SpaceSession, bytes = new Uint8Array([97])) {
    const { id: archive } = (await control(session, {
      op: "open",
      handle: "catalog",
      readers: [readerPrincipal],
    })).binding!;
    const generation = crypto.randomUUID();
    const record = crypto.randomUUID();
    await control(session, { op: "begin", archive, generation, base: null });
    await control(session, {
      op: "record",
      archive,
      generation,
      record,
      key: "record",
      source: "source",
    });
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const put = {
      op: "put",
      archive,
      generation,
      record,
      index: 0,
      hash,
      bytes: bytes.length,
      metadata: "{}",
    } as const;
    return { archive, generation, record, bytes, hash, put };
  }

  async function published(session: SpaceSession) {
    const f = await fixture(
      session,
      new Uint8Array(ARCHIVE_LIMITS.chunkBytes + 1).fill(97),
    );
    await session.archive(f.put, f.bytes);
    await control(session, {
      op: "complete-record",
      archive: f.archive,
      generation: f.generation,
      record: f.record,
      metadata: "{}",
    });
    await control(session, {
      op: "publish",
      archive: f.archive,
      generation: f.generation,
    });
    return f;
  }

  function ticket(
    client: Client,
    session: SpaceSession,
    command: ArchiveCommand,
  ): Promise<ArchiveTicket> {
    return client.request({
      type: "archive.ticket",
      requestId: crypto.randomUUID(),
      space,
      sessionId: session.sessionId,
      command,
    });
  }

  function request(
    capability: ArchiveTicket,
    body: BodyInit = new Uint8Array(0),
    headers: Record<string, string> = {},
  ) {
    return new Request("https://archive.example/transfer", {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability.token}`,
        "content-type": "application/octet-stream",
        "content-length": String(capability.bytes),
        ...headers,
      },
      body,
    });
  }

  it("keeps a delegated reader's archive writes bound to its envelope principal", async () => {
    const writer = await mount();
    const f = await published(writer.session);
    const delegated = await mount(service, "space-owner");
    const pin = (await control(delegated.session, {
      op: "pin",
      archive: f.archive,
      generation: f.generation,
    })).pin!;
    expect(
      await delegated.session.archive({
        op: "read",
        archive: f.archive,
        generation: f.generation,
        pin,
        key: "record",
        index: 0,
        hash: f.hash,
      }),
    ).toEqual(f.bytes);
    for (
      const command of [
        { op: "open", handle: "delegated" },
        { op: "delete", archive: f.archive },
        {
          op: "begin",
          archive: f.archive,
          generation: crypto.randomUUID(),
          base: f.generation,
        },
        f.put,
      ] as ArchiveCommand[]
    ) {
      await expect(ticket(delegated.client, delegated.session, command)).rejects
        .toThrow("space ACL");
    }
  });

  it("rechecks a writer's current ACL after a slow upload and before page publication", async () => {
    const { client, session } = await mount();
    const f = await fixture(session);
    const capability = await ticket(client, session, f.put);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        entered.resolve();
        await release.promise;
        controller.enqueue(f.bytes);
        controller.close();
      },
    }, { highWaterMark: 0 });
    const pending = server.handleArchiveRequest(request(capability, body));
    try {
      await entered.promise;
      await acl({
        [owner]: "READ",
        [space]: "OWNER",
        [readerPrincipal]: "READ",
      });
    } finally {
      release.resolve();
    }
    const response = await pending;
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("space ACL");
    for (const directory of ["pages", "staging"]) {
      expect(Array.from(Deno.readDirSync(`${root}/${directory}`))).toHaveLength(
        0,
      );
    }
  });

  it("rechecks disclosure policy before releasing each response frame", async () => {
    const writer = await mount();
    const f = await published(writer.session);
    const { client, session } = await mount(readerPrincipal);
    const pin = (await control(session, {
      op: "pin",
      archive: f.archive,
      generation: f.generation,
    })).pin!;
    const capability = await ticket(client, session, {
      op: "read",
      archive: f.archive,
      generation: f.generation,
      pin,
      key: "record",
      index: 0,
      hash: f.hash,
    });
    const response = await server.handleArchiveRequest(request(capability));
    expect(response.status).toBe(200);
    const body = response.body!.getReader();
    try {
      expect((await body.read()).value!.byteLength).toBe(
        ARCHIVE_LIMITS.chunkBytes,
      );
      readersDenied = true;
      await expect(body.read()).rejects.toThrow("immutable policy");
    } finally {
      body.releaseLock();
    }
    readersDenied = false;
    await session.acknowledgeArchive(capability.token);
    expect(
      (await control(session, {
        op: "count",
        archive: f.archive,
        generation: f.generation,
        pin,
      })).count,
    ).toBe(1);
  });

  it("revokes a response and its pin when the Memory attachment closes", async () => {
    const writer = await mount();
    const f = await published(writer.session);
    const { client, session } = await mount(readerPrincipal);
    const pin = (await control(session, {
      op: "pin",
      archive: f.archive,
      generation: f.generation,
    })).pin!;
    const capability = await ticket(client, session, {
      op: "read",
      archive: f.archive,
      generation: f.generation,
      pin,
      key: "record",
      index: 0,
      hash: f.hash,
    });
    const response = await server.handleArchiveRequest(request(capability));
    const body = response.body!.getReader();
    try {
      expect((await body.read()).value!.byteLength).toBe(
        ARCHIVE_LIMITS.chunkBytes,
      );
      await client.close();
      await expect(body.read()).rejects.toThrow("Archive transfer closed");
    } finally {
      body.releaseLock();
    }
    const replacement = await mount(readerPrincipal);
    await expect(
      control(replacement.session, {
        op: "count",
        archive: f.archive,
        generation: f.generation,
        pin,
      }),
    ).rejects.toThrow("pin is unavailable");
  });

  it("stops an already admitted response after its current ACL is revoked", async () => {
    const writer = await mount();
    const f = await published(writer.session);
    const { client, session } = await mount(readerPrincipal);
    const pin = (await control(session, {
      op: "pin",
      archive: f.archive,
      generation: f.generation,
    })).pin!;
    const capability = await ticket(client, session, {
      op: "read",
      archive: f.archive,
      generation: f.generation,
      pin,
      key: "record",
      index: 0,
      hash: f.hash,
    });
    const response = await server.handleArchiveRequest(request(capability));
    const body = response.body!.getReader();
    try {
      expect((await body.read()).value!.byteLength).toBe(
        ARCHIVE_LIMITS.chunkBytes,
      );
      await acl({ [owner]: "OWNER" });
      await expect(body.read()).rejects.toThrow("Archive transfer closed");
    } finally {
      body.releaseLock();
    }
  });

  it("refuses to relabel an existing binding or read a different pinned page", async () => {
    const { session } = await mount();
    const f = await published(session);
    await expect(
      control(session, { op: "open", handle: "catalog", readers: [service] }),
    ).rejects.toThrow("immutable policy");
    const pin = (await control(session, {
      op: "pin",
      archive: f.archive,
      generation: f.generation,
    })).pin!;
    const command = {
      op: "read",
      archive: f.archive,
      generation: f.generation,
      pin,
      key: "record",
      index: 0,
      hash: f.hash,
    } as const;
    for (
      const [change, error] of [
        [{ hash: "0".repeat(64) }, "hash does not match"],
        [{ index: 1 }, "page does not exist"],
        [{ key: "different-record" }, "record does not exist"],
        [{ generation: crypto.randomUUID() }, "generation is unavailable"],
      ] as const
    ) {
      await expect(session.archive({ ...command, ...change })).rejects.toThrow(
        error,
      );
    }
    expect(await session.archive(command)).toEqual(f.bytes);
  });

  it("preserves a transfer error when its acknowledgement also fails", async () => {
    const { client, session } = await mount();
    const original = new Error("transport failed");
    const cleanup = new Error("acknowledgement failed");
    const transfer = client.transferArchive;
    const acknowledge = session.acknowledgeArchive;
    client.transferArchive = () => Promise.reject(original);
    session.acknowledgeArchive = async (...args) => {
      await acknowledge.call(session, ...args);
      throw cleanup;
    };
    let failure: unknown;
    try {
      await session.archive({ op: "open", handle: "failed-transfer" });
    } catch (error) {
      failure = error;
    } finally {
      client.transferArchive = transfer;
      session.acknowledgeArchive = acknowledge;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([original, cleanup]);
    expect((failure as AggregateError).cause).toBe(original);
  });

  it("rejects a failed acknowledgement after a successful transfer", async () => {
    const { session } = await mount();
    const cleanup = new Error("acknowledgement failed");
    const acknowledge = session.acknowledgeArchive;
    session.acknowledgeArchive = async (...args) => {
      await acknowledge.call(session, ...args);
      throw cleanup;
    };
    try {
      await expect(
        session.archive({ op: "open", handle: "successful-transfer" }),
      ).rejects.toBe(cleanup);
    } finally {
      session.acknowledgeArchive = acknowledge;
    }
  });
  function pinCounts() {
    const database = new Database(`${root}/catalog.sqlite`, { readonly: true });
    try {
      return database.prepare(
        "SELECT (SELECT count(*) FROM pins) AS pins, (SELECT count(*) FROM tickets) AS tickets, (SELECT count(*) FROM pin_requests) AS requests",
      ).get();
    } finally {
      database.close();
    }
  }

  for (const fault of ["unread", "first-pull", "mid-body", "hash"] as const) {
    it(`rejects a ${fault} pin response and recovers through the same live session`, async () => {
      const { client, session } = await mount();
      const f = await published(session);
      const pin = new ArchivePinOwner({
        archive: f.archive,
        generation: f.generation,
      }, (command) => control(session, command));
      const transfer = client.transferArchive;
      const error = new Error("injected pin response failure");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      client.transferArchive = async (...args) => {
        const response = await transfer.apply(client, args);
        expect(response.status).toBe(200);
        if (fault === "unread") {
          await response.body!.cancel();
          throw error;
        }
        const headers = new Headers(response.headers);
        if (fault === "hash") {
          headers.set("x-archive-content-sha256", "0".repeat(64));
          return new Response(response.body, { headers });
        }
        const reader = response.body!.getReader();
        let first = true;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (first && fault === "mid-body") {
                first = false;
                const chunk = await reader.read();
                expect(chunk.value!.length).toBeGreaterThan(1);
                controller.enqueue(chunk.value!.slice(0, 1));
                return;
              }
              if (fault === "mid-body") {
                entered.resolve();
                await release.promise;
              }
              await reader.cancel(error);
              reader.releaseLock();
              controller.error(error);
            },
            async cancel(reason) {
              await reader.cancel(reason);
              reader.releaseLock();
            },
          }, { highWaterMark: 0 }),
          { headers },
        );
      };
      try {
        const failed = expect(pin.acquire()).rejects.toThrow(
          fault === "hash" ? "control response hash" : error.message,
        );
        if (fault === "mid-body") {
          await entered.promise;
          expect(pin.state).toBe("uncertain");
          expect(pinCounts()).toEqual({ pins: 1, tickets: 0, requests: 1 });
          expect(server.accessForTestingOnly.activeArchiveTransfers).toBe(1);
          release.resolve();
        }
        await failed;
      } finally {
        release.resolve();
        client.transferArchive = transfer;
      }
      expect(await pin.status()).toBe("released");
      expect(pinCounts()).toEqual({ pins: 0, tickets: 0, requests: 1 });
      expect(server.accessForTestingOnly.activeArchiveTransfers).toBe(0);
      const next = new ArchivePinOwner(
        pin.scope,
        (command) => control(session, command),
      );
      await next.acquire();
      expect(await next.status()).toBe("adopted");
      await next.close();
      expect(pinCounts()).toEqual({ pins: 0, tickets: 0, requests: 1 });
    });
  }

  for (const effect of [false, true]) {
    it(`resolves an adoption acknowledgement lost ${effect ? "after" : "before"} its effect by exact status and release`, async () => {
      const { session } = await mount();
      const f = await published(session);
      const pin = new ArchivePinOwner({
        archive: f.archive,
        generation: f.generation,
      }, (command) => control(session, command));
      const acknowledge = session.acknowledgeArchive;
      const lost = new Error("adoption acknowledgement lost");
      session.acknowledgeArchive = async (...args) => {
        if (args[1] && args[2]?.pin === pin.pin) {
          if (effect) await acknowledge.apply(session, args);
          throw lost;
        }
        return acknowledge.apply(session, args);
      };
      try {
        await expect(pin.acquire()).rejects.toBe(lost);
      } finally {
        session.acknowledgeArchive = acknowledge;
      }
      expect(pin.state).toBe("uncertain");
      expect(pinCounts()).toEqual({ pins: 1, tickets: 0, requests: 1 });
      expect(server.accessForTestingOnly.activeArchiveTransfers).toBe(
        effect ? 0 : 1,
      );
      expect(await pin.status()).toBe(effect ? "adopted" : "provisional");
      await pin.close();
      await pin.close();
      expect(pinCounts()).toEqual({ pins: 0, tickets: 0, requests: 1 });
      expect(server.accessForTestingOnly.activeArchiveTransfers).toBe(0);
    });
  }

  it("keeps owner closure terminal when the pin ticket has not reached admission", async () => {
    const { client, session } = await mount();
    const f = await published(session);
    const pin = new ArchivePinOwner({
      archive: f.archive,
      generation: f.generation,
    }, (command) => control(session, command));
    const request = client.request;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    client.request = async <Result>(
      message: Parameters<typeof request>[0],
    ): Promise<Result> => {
      const command = message.command as ArchiveCommand | undefined;
      if (
        message.type === "archive.ticket" && command?.op === "pin" &&
        command.pin === pin.pin
      ) {
        entered.resolve();
        await release.promise;
      }
      return await request.call(client, message) as Result;
    };
    const rejected = expect(pin.acquire()).rejects.toThrow(
      "sequence was already used",
    );
    try {
      await entered.promise;
      expect(pin.state).toBe("uncertain");
      await pin.close();
      expect(pin.state).toBe("released");
      expect(pinCounts()).toEqual({ pins: 0, tickets: 0, requests: 1 });
      release.resolve();
      await rejected;
      expect(pin.state).toBe("released");
      expect(pinCounts()).toEqual({ pins: 0, tickets: 0, requests: 1 });
    } finally {
      release.resolve();
      client.request = request;
    }
  });

  for (const operation of ["pin", "pin-status"] as const) {
    it(`keeps the later owner when an old ${operation} response arrives for a reused ID`, async () => {
      const { client, session } = await mount();
      const f = await published(session);
      const pin = crypto.randomUUID();
      const scope = { archive: f.archive, generation: f.generation, pin };
      if (operation === "pin-status") {
        await control(session, { op: "pin", ...scope });
      }
      const transfer = client.transferArchive;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let delayed = true;
      client.transferArchive = async (...args) => {
        if (delayed) {
          delayed = false;
          entered.resolve();
          await release.promise;
        }
        return await transfer.call(client, ...args);
      };
      const previous = control(
        session,
        operation === "pin"
          ? { op: "pin", ...scope }
          : { op: "pin-status", archive: f.archive, pin },
      );
      const completed = operation === "pin"
        ? expect(previous).rejects.toThrow("expired or consumed")
        : previous.then((result) => expect(result.pinState).toBe("released"));
      try {
        await entered.promise;
        await control(session, { op: "release", archive: f.archive, pin });
        await control(session, { op: "pin", ...scope });
        expect(pinCounts()?.pins).toBe(1);
        release.resolve();
        await completed;
        expect(
          (await control(session, {
            op: "pin-status",
            archive: f.archive,
            pin,
          }))
            .pinState,
        ).toBe("adopted");
        expect((await control(session, { op: "count", ...scope })).count).toBe(
          1,
        );
        await control(session, { op: "release", archive: f.archive, pin });
        expect(pinCounts()).toEqual({ pins: 0, tickets: 0, requests: 1 });
        expect(server.accessForTestingOnly.activeArchiveTransfers).toBe(0);
      } finally {
        release.resolve();
        await completed;
        client.transferArchive = transfer;
      }
    });
  }

  it("keeps the later owner when an old close acknowledgement arrives for a reused ID", async () => {
    const { client, session } = await mount();
    const f = await published(session);
    const pin = crypto.randomUUID();
    const scope = { archive: f.archive, generation: f.generation, pin };
    await control(session, { op: "pin", ...scope });
    const request = client.request;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let delayed = true;
    client.request = async <Result>(
      message: Parameters<typeof request>[0],
    ): Promise<Result> => {
      const result = await request.call(client, message) as Result;
      if (message.type === "archive.ack" && message.release && delayed) {
        delayed = false;
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    const closed = control(session, { op: "release", archive: f.archive, pin });
    try {
      await entered.promise;
      await control(session, { op: "release", archive: f.archive, pin });
      await control(session, { op: "pin", ...scope });
      release.resolve();
      await closed;
      expect(
        (await control(session, { op: "pin-status", archive: f.archive, pin }))
          .pinState,
      ).toBe("adopted");
      await control(session, { op: "release", archive: f.archive, pin });
      expect(pinCounts()).toEqual({ pins: 0, tickets: 0, requests: 1 });
      expect(server.accessForTestingOnly.activeArchiveTransfers).toBe(0);
    } finally {
      release.resolve();
      await closed;
      client.request = request;
    }
  });

  it("keeps owner closure terminal while an earlier status response is pending", async () => {
    const { session } = await mount();
    const f = await published(session);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pin = new ArchivePinOwner(f, async (command) => {
      const result = await control(session, command);
      if (command.op === "pin-status") {
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    await pin.acquire();
    const status = pin.status();
    try {
      await entered.promise;
      await pin.close();
      expect(pin.state).toBe("released");
      release.resolve();
      expect(await status).toBe("released");
      expect(pin.state).toBe("released");
      expect(pinCounts()).toEqual({ pins: 0, tickets: 0, requests: 1 });
    } finally {
      release.resolve();
      await status;
    }
  });

  it("detaches one live Memory session's reader state while another same-principal session remains usable", async () => {
    const first = (await mount()).session;
    const second = (await mount()).session;
    const f = await published(first);
    const one = new ArchivePinOwner({
      archive: f.archive,
      generation: f.generation,
    }, (command) => control(first, command));
    const two = new ArchivePinOwner(
      one.scope,
      (command) => control(second, command),
    );
    await one.acquire();
    await two.acquire();
    expect(pinCounts()).toEqual({ pins: 2, tickets: 0, requests: 2 });
    await first.close();
    expect(pinCounts()).toEqual({ pins: 1, tickets: 0, requests: 1 });
    expect(await two.status()).toBe("adopted");
    expect(
      (await control(second, { op: "count", ...two.scope, pin: two.pin }))
        .count,
    ).toBe(1);
    await second.close();
    expect(pinCounts()).toEqual({ pins: 0, tickets: 0, requests: 0 });
  });

  for (const effect of [false, true]) {
    it(`finishes session cleanup after its close acknowledgement is lost ${effect ? "after" : "before"} the effect`, async () => {
      const { client, session } = await mount();
      const other = (await mount()).session;
      const f = await published(session);
      const pin = new ArchivePinOwner(
        f,
        (command) => control(session, command),
      );
      const otherPin = new ArchivePinOwner(
        f,
        (command) => control(other, command),
      );
      await pin.acquire();
      await otherPin.acquire();
      const request = client.request;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const failure = new Error("Injected session close acknowledgement loss");
      client.request = async <Result>(
        message: Parameters<typeof request>[0],
      ): Promise<Result> => {
        if (message.type === "archive.ack" && message.close) {
          if (effect) await request.call(client, message);
          entered.resolve();
          await release.promise;
          throw failure;
        }
        return await request.call(client, message) as Result;
      };
      const failed = expect(session.close()).rejects.toBe(failure);
      try {
        await entered.promise;
        expect(client.connectionState).toBe("connected");
        expect(pinCounts()).toEqual({
          pins: effect ? 1 : 2,
          tickets: 0,
          requests: effect ? 1 : 2,
        });
        expect(await otherPin.status()).toBe("adopted");
        release.resolve();
        await failed;
        client.request = request;
        await session.close();
        await session.close();
        expect(pinCounts()).toEqual({ pins: 1, tickets: 0, requests: 1 });
        expect(await otherPin.status()).toBe("adopted");
        expect(
          (await control(other, {
            op: "count",
            ...otherPin.scope,
            pin: otherPin.pin,
          })).count,
        ).toBe(1);
        await other.close();
        expect(pinCounts()).toEqual({ pins: 0, tickets: 0, requests: 0 });
        expect(server.accessForTestingOnly.activeArchiveTransfers).toBe(0);
      } finally {
        release.resolve();
        await failed;
        client.request = request;
      }
    });
  }

  it("joins an in-flight session close during client shutdown and releases its ownership on disconnect", async () => {
    const { client, session } = await mount();
    const f = await published(session);
    const pin = new ArchivePinOwner(f, (command) => control(session, command));
    await pin.acquire();
    const request = client.request;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    client.request = async <Result>(
      message: Parameters<typeof request>[0],
    ): Promise<Result> => {
      if (message.type === "archive.ack" && message.close) {
        entered.resolve();
        await release.promise;
      }
      return await request.call(client, message) as Result;
    };
    const sessionClosed = session.close();
    let clientClosed: Promise<void> | undefined;
    try {
      await entered.promise;
      clientClosed = client.close();
      expect(client.connectionState).toBe("closed");
      expect(pinCounts()).toEqual({ pins: 1, tickets: 0, requests: 1 });
      release.resolve();
      await sessionClosed;
      await clientClosed;
      expect(pinCounts()).toEqual({ pins: 0, tickets: 0, requests: 0 });
      expect(server.accessForTestingOnly.activeArchiveTransfers).toBe(0);
    } finally {
      release.resolve();
      await sessionClosed;
      await clientClosed;
      client.request = request;
    }
  });
});

describe("archive adoption across HTTP and serialized Memory", () => {
  const principal = "did:key:authoritative-pin-owner";
  const setupIdentity = {
    space: principal,
    principal,
    actingPrincipal: principal,
    sessionId: "setup",
    connectionId: "setup",
  };
  const policy = { writerPolicy: "test", cfcPolicy: "{}" };
  const allow = () => Promise.resolve();

  type Case =
    | "completed-before-ack"
    | "ack-before-eof"
    | "cancel-before-ack"
    | "abort-before-ack"
    | "release-before-ack"
    | "session-close-before-ack"
    | "disconnect-before-ack"
    | "abort-after-ack"
    | "release-after-ack"
    | "session-close-after-ack"
    | "disconnect-after-ack";
  const cases: Case[] = [
    "completed-before-ack",
    "ack-before-eof",
    "cancel-before-ack",
    "abort-before-ack",
    "release-before-ack",
    "session-close-before-ack",
    "disconnect-before-ack",
    "abort-after-ack",
    "release-after-ack",
    "session-close-after-ack",
    "disconnect-after-ack",
  ];

  for (const action of cases) {
    it(`authoritative pin ACK over serialized Memory and HTTP: ${action}`, async () => {
      const root = await Deno.makeTempDir({
        prefix: "archive-authoritative-ack-",
      });
      try {
        using store = await ArchiveStore.open({ root });
        const archive = store.openBinding(setupIdentity, "catalog", policy).id;
        await store.execute(
          { op: "begin", archive, generation: "b0", base: null },
          setupIdentity,
          allow,
        );
        await store.execute(
          { op: "publish", archive, generation: "b0" },
          setupIdentity,
          allow,
        );
        const database = new Database(`${root}/catalog.sqlite`, {
          readonly: true,
        });
        using databaseCleanup = new DisposableStack();
        databaseCleanup.defer(() => database.close());
        const counts = () => {
          using query = database.prepare(
            "SELECT (SELECT count(*) FROM pins) AS pins, (SELECT count(*) FROM tickets) AS tickets, (SELECT count(*) FROM pin_requests) AS requests",
          );
          return query.get();
        };
        const memory = new Server({
          store: new URL("memory://archive-authoritative-ack"),
          authorizeSessionOpen: (message) =>
            String(message.invocation?.principal),
          sessionOpenAuth: testSessionOpenAuth,
          acl: { mode: "off" },
          archive: {
            store,
            authorization: { create: () => policy, authorize: () => true },
            allowedOrigins: [],
          },
        });
        const beforeAck = action.endsWith("before-ack");
        const holdEOF = action !== "completed-before-ack";
        const eofEntered = Promise.withResolvers<void>();
        const eofResume = Promise.withResolvers<void>();
        const ackIssued = Promise.withResolvers<void>();
        const ackResume = Promise.withResolvers<void>();
        const httpFinished = Promise.withResolvers<void>();
        let pinToken: string | undefined;
        let reference: ArchivePinReference | undefined;
        let nativeIdentity: ArchiveIdentity | undefined;
        let nativeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let eofObserved = false;
        let pendingPulls = 0;
        let memoryFrames = 0;
        let adoptions = 0;
        let adoptionHandlers = 0;
        let localOwnerAtAck = false;
        const originalAdopt = store.adoptPin.bind(store);
        store.adoptPin = (...args) => {
          adoptions++;
          originalAdopt(...args);
        };
        const archiveControl = memory.archiveControl.bind(memory);
        memory.archiveControl = async (...args) => {
          const message = args[0];
          nativeIdentity = {
            space: principal,
            sessionId: message.sessionId,
            connectionId: args[1],
            principal,
            actingPrincipal: principal,
          };
          const adopting = message.type === "archive.ack" && message.consumed &&
            message.pin;
          if (adopting) adoptionHandlers++;
          try {
            return await archiveControl(...args);
          } finally {
            if (adopting) adoptionHandlers--;
          }
        };
        const serving = new AbortController();
        const server = Deno.serve({
          hostname: "127.0.0.1",
          port: 0,
          signal: serving.signal,
          onListen() {},
        }, async (request, info) => {
          const response = await memory.handleArchiveRequest(request);
          if (request.headers.get("authorization") !== `Bearer ${pinToken}`) {
            return response;
          }
          void info.completed.then(
            () => httpFinished.resolve(),
            () => httpFinished.resolve(),
          );
          const reader = nativeReader = response.body!.getReader();
          let forwarded = 0;
          const length = Number(response.headers.get("content-length"));
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              pendingPulls++;
              try {
                if (forwarded === length && holdEOF) {
                  eofEntered.resolve();
                  await eofResume.promise;
                }
                const next = await reader.read();
                if (next.done) {
                  eofObserved = true;
                  controller.close();
                } else {
                  forwarded += next.value.length;
                  controller.enqueue(next.value);
                }
              } catch (error) {
                controller.error(error);
              } finally {
                pendingPulls--;
              }
            },
            async cancel(reason) {
              await reader.cancel(reason);
            },
          }, { highWaterMark: 0 });
          return new Response(
            body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>()),
            { status: response.status, headers: response.headers },
          );
        });
        const transport = loopback(memory);
        const originalSend = transport.send.bind(transport);
        transport.send = async (payload) => {
          const message = decodeMemoryBoundary(payload) as Record<
            string,
            unknown
          >;
          if (
            message.type === "archive.ack" && message.consumed && message.pin
          ) {
            localOwnerAtAck = owner?.state === "uncertain" &&
              owner.pin === (message.pin as ArchivePinReference).pin;
            ackIssued.resolve();
            if (beforeAck) await ackResume.promise;
          }
          memoryFrames++;
          try {
            await originalSend(payload);
          } finally {
            memoryFrames--;
          }
        };
        const httpClient = Deno.createHttpClient({});
        transport.archiveTransfer = (token, body, signal) => {
          const options = {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/octet-stream",
            },
            body,
            signal,
            client: httpClient,
          };
          return fetch(`http://127.0.0.1:${server.addr.port}/pin`, options);
        };
        const client = await connect({ transport });
        const session = await client.mount(
          principal,
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
        const request = client.request.bind(client);
        client.request = async <Result>(
          message: Parameters<typeof request>[0],
        ): Promise<Result> => {
          const result = await request<Result>(message);
          if (
            message.type === "archive.ticket" &&
            (message.command as { op: string }).op === "pin"
          ) {
            pinToken = (result as ArchiveTicket).token;
            reference = {
              archive,
              pin: (message.command as { pin: string }).pin,
              sequence: message.pinSequence as number,
            };
          }
          return result;
        };
        const owner = new ArchivePinOwner(
          { archive, generation: "b0" },
          async (command, signal) =>
            await session.archive(command, undefined, signal) as ArchiveResult,
        );
        const acquisition = owner.acquire().then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error }),
        );
        try {
          await ackIssued.promise;
          expect(localOwnerAtAck).toBe(true);
          if (holdEOF) await eofEntered.promise;
          else {
            await httpFinished.promise;
            expect(eofObserved).toBe(true);
          }
          const shouldAdopt = !beforeAck || action === "completed-before-ack";
          if (beforeAck) {
            expect(adoptions).toBe(0);
            expect(
              store.pinState(
                archive,
                owner.pin,
                nativeIdentity!,
                reference!.sequence,
              ),
            ).toBe("provisional");
            if (action === "cancel-before-ack") {
              await nativeReader!.cancel(
                new Error("native response canceled before adoption"),
              );
            } else if (action === "abort-before-ack") {
              await session.acknowledgeArchive(pinToken, false, reference);
            } else if (action === "release-before-ack") {
              await owner.close();
            } else if (action === "session-close-before-ack") {
              await session.close();
            } else if (action === "disconnect-before-ack") {
              await client.close();
            }
            if (!shouldAdopt) {
              expect(counts()).toEqual({
                pins: 0,
                tickets: 0,
                requests:
                  action.includes("close") || action.includes("disconnect")
                    ? 0
                    : 1,
              });
            }
            ackResume.resolve();
          }
          const result = await acquisition;
          expect(result.ok).toBe(shouldAdopt);
          expect(adoptions).toBe(shouldAdopt ? 1 : 0);
          expect(memoryFrames).toBe(0);
          expect(adoptionHandlers).toBe(0);
          if (shouldAdopt) {
            expect(
              store.pinState(
                archive,
                owner.pin,
                nativeIdentity!,
                reference!.sequence,
              ),
            ).toBe("adopted");
            await store.execute(
              { op: "begin", archive, generation: "b1", base: "b0" },
              setupIdentity,
              allow,
            );
            await store.execute(
              { op: "publish", archive, generation: "b1" },
              setupIdentity,
              allow,
            );
            await store.execute(
              { op: "prune", archive, generation: "b1" },
              setupIdentity,
              allow,
            );
            using protectedGeneration = database.prepare(
              "SELECT count(*) AS count FROM generations WHERE id='b0'",
            );
            expect(protectedGeneration.get()).toEqual({ count: 1 });
            if (action === "abort-after-ack") {
              await session.acknowledgeArchive(pinToken, false, reference);
              expect(
                store.pinState(
                  archive,
                  owner.pin,
                  nativeIdentity!,
                  reference!.sequence,
                ),
              ).toBe("adopted");
            } else if (action === "release-after-ack") {
              await owner.close();
              expect(counts()).toEqual({ pins: 0, tickets: 0, requests: 1 });
            } else if (action === "session-close-after-ack") {
              await session.close();
              expect(counts()).toEqual({ pins: 0, tickets: 0, requests: 0 });
            } else if (action === "disconnect-after-ack") {
              await client.close();
              expect(counts()).toEqual({ pins: 0, tickets: 0, requests: 0 });
            }
          }
          eofResume.resolve();
          await httpFinished.promise;
          if (
            shouldAdopt && !action.includes("close") &&
            !action.includes("disconnect") && action !== "release-after-ack"
          ) {
            expect(
              store.pinState(
                archive,
                owner.pin,
                nativeIdentity!,
                reference!.sequence,
              ),
            ).toBe("adopted");
            await session.acknowledgeArchive(pinToken, true, reference);
            expect(adoptions).toBe(1);
            await owner.close();
          }
          await session.close();
          await client.close();
          expect(pendingPulls).toBe(0);
          expect(memoryFrames).toBe(0);
          expect(adoptionHandlers).toBe(0);
          expect(memory.accessForTestingOnly.activeArchiveTransfers).toBe(0);
          expect(counts()).toEqual({ pins: 0, tickets: 0, requests: 0 });
        } finally {
          ackResume.resolve();
          eofResume.resolve();
          await acquisition;
          await client.close();
          await nativeReader?.cancel().catch(() => {});
          nativeReader?.releaseLock();
          httpClient.close();
          serving.abort();
          await server.finished;
          await memory.close();
        }
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  }
});
