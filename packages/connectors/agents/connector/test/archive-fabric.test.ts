/** Verifies the native catalog boundary against real Fabric storage and CFC. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { archiveAuthorization } from "@commonfabric/runner/cfc/archive";
import { ArchiveStore } from "@commonfabric/memory/v2/archive-store";
import { Server } from "@commonfabric/memory/v2/server";
import { applyCommit } from "@commonfabric/memory/v2/engine";
import {
  type Client,
  connect,
  loopback,
  type SpaceSession,
} from "@commonfabric/memory/v2/client";
import type {
  ArchiveCommand,
  ArchiveIdentity,
  ArchiveResult,
  ArchiveTicket,
} from "@commonfabric/memory/v2/archive";
import {
  ARCHIVE_LIMITS,
  ArchivePinOwner,
} from "@commonfabric/memory/v2/archive";
import type { EntityDocument } from "@commonfabric/memory/v2";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { AgentFabricTarget, createAgentFabricCells } from "../src/fabric.ts";
import { agentOwnerSchema, stableCellId } from "../src/fabric-graph.ts";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import type { AgentArchiveCatalog } from "../src/archive.ts";
import { ClaudeAgentSdkDriver } from "../src/drivers/claude-agent-sdk.ts";
import { CodexAppServerDriver } from "../src/drivers/codex-app-server.ts";
import { CommandWorker } from "../src/commands.ts";
import { CommandLedger } from "../src/command-ledger.ts";
import { AGENT_CONNECTOR_SCHEMAS } from "../src/protocol.ts";
import { sessionKey } from "../src/session-contract.ts";

const nativeId = "00000000-0000-4000-8000-000000000001";
const policy = archiveAuthorization("commonfabric.agents-connector");

Deno.test("native archive capability mismatch fails before any Fabric cells are opened", async () => {
  let openedCells = 0;
  const runtime = {
    storageManager: {
      open: () => ({
        archive: () =>
          Promise.reject(new Error("Archive operation was invoked")),
        archiveLimits: () =>
          Promise.resolve({
            ...ARCHIVE_LIMITS,
            controlBytes: ARCHIVE_LIMITS.controlBytes + 1,
          }),
      }),
    },
    getCell: () => {
      openedCells++;
      throw new Error("Fabric cell was opened");
    },
  } as unknown as Runtime;
  await expect(
    AgentFabricTarget.connectArchive({
      runtime,
      spaceDid: "did:key:synthetic",
      ownerDid: "did:key:synthetic",
    }),
  ).rejects.toThrow("required bounded archive protocol");
  expect(openedCells).toBe(0);
});

describe("native archive Fabric boundary", () => {
  let root: string;
  let owner: Identity;
  let server: Server;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let client: Client;
  let session: SpaceSession;
  let localSeq: number;
  const schemas = new Map<string, ReturnType<typeof agentOwnerSchema>>();

  async function start(): Promise<void> {
    server = new Server({
      store: toFileUrl(`${root}/memory/`),
      subscriptionRefreshDelayMs: 0,
      acl: { mode: "off" },
      authorizeSessionOpen: (message) =>
        (message.authorization as { principal: string }).principal,
      sessionOpenAuth: { audience: "did:key:archive-fabric-test" },
      archive: {
        store: await ArchiveStore.open({ root: `${root}/archive` }),
        authorization: policy,
        allowedOrigins: [],
      },
    });
    storage = EmulatedStorageManager.connectTo(server, { as: owner });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    client = await connect({ transport: loopback(server) });
    session = await client.mount(
      owner.did(),
      {},
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: owner.did() },
      }),
    );
  }
  async function stop(): Promise<void> {
    await runtime.dispose();
    await storage.close();
    await client.close();
    await server.close();
  }
  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "agents-archive-fabric-test-" });
    owner = await Identity.fromPassphrase("native archive fabric boundary");
    await Deno.mkdir(`${root}/memory`);
    await Deno.mkdir(`${root}/claude/projects/project`, { recursive: true });
    await Deno.mkdir(`${root}/codex/sessions`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/claude/projects/project/${nativeId}.jsonl`,
      '{"type":"user","message":{"content":"claude"}}\n',
    );
    await Deno.writeTextFile(
      `${root}/codex/sessions/${nativeId}.jsonl`,
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"codex"}]}}\n',
    );
    localSeq = 0;
    await start();
  });
  afterEach(async () => {
    await stop();
    await Deno.remove(root, { recursive: true });
  });
  const connection = () => ({
    runtime,
    spaceDid: owner.did(),
    ownerDid: owner.did(),
  });
  async function target() {
    const target = await AgentFabricTarget.connectArchive(connection());
    await target.claimStorage();
    target.configureArchive({ scratchDirectory: `${root}/scratch` });
    return target;
  }
  function drivers() {
    return [
      new ClaudeAgentSdkDriver({
        id: "claude",
        driver: "claude-agent-sdk",
        enabled: true,
        configDir: `${root}/claude`,
      }),
      new CodexAppServerDriver({
        id: "codex",
        driver: "codex-app-server",
        enabled: true,
        codexHome: `${root}/codex`,
      }),
    ];
  }
  async function write(id: string, document: EntityDocument) {
    const engine = await server.engineForSpace(owner.did());
    const schemaHash = (document.cfc as { schemaHash: string }).schemaHash;
    applyCommit(engine, {
      sessionId: "legacy-fixtures",
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `cid:${schemaHash}`,
          value: { value: schemas.get(schemaHash) as EntityDocument["value"] },
        }, { op: "set", id, value: document }],
      },
    });
  }
  async function control(command: ArchiveCommand): Promise<ArchiveResult> {
    if (command.op === "pin" && !command.pin) {
      const owner = new ArchivePinOwner(command, control);
      await owner.acquire();
      return { pin: owner.pin, generation: command.generation };
    }
    const result = await session.archive(command);
    if (result instanceof Uint8Array) {
      throw new Error("Expected archive metadata");
    }
    return result;
  }
  function ticket(command: ArchiveCommand): Promise<ArchiveTicket> {
    return client.request({
      type: "archive.ticket",
      requestId: crypto.randomUUID(),
      space: owner.did(),
      sessionId: session.sessionId,
      command,
    });
  }
  function request(capability: ArchiveTicket) {
    return new Request("http://archive.local/api/storage/memory/archive", {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability.token}`,
        "content-type": "application/octet-stream",
        "content-length": "0",
      },
      body: new Uint8Array(0),
    });
  }
  function metadata(principal = owner.did()) {
    const identity: ArchiveIdentity = {
      space: owner.did(),
      principal,
      actingPrincipal: principal,
      sessionId: "fixture",
      connectionId: "fixture",
    };
    const schema = agentOwnerSchema(principal);
    const schemaHash = internSchemaAsTaggedHashString(schema);
    schemas.set(schemaHash, schema);
    return { ...JSON.parse(policy.create(identity, []).cfcPolicy), schemaHash };
  }

  it("never hydrates oversized v1 roots while a partial first scan is recovered by a complete native scan", async () => {
    const cells = createAgentFabricCells(connection());
    const oldIds: string[] = [cells.index, cells.allIndex].map((cell) =>
      cell.getAsNormalizedFullLink().id!
    );
    for (const id of oldIds) {
      await write(id, {
        value: {
          sessions: Array.from(
            { length: 2000 },
            (_, index) => ({ id: `of:session-${index}` }),
          ),
        },
        cfc: metadata(),
      });
    }
    const engine = await server.engineForSpace(owner.did());
    const original = engine.statements.selectCurrentLocal.get.bind(
      engine.statements.selectCurrentLocal,
    );
    using query = stub(
      engine.statements.selectCurrentLocal,
      "get",
      (...args) => {
        if (oldIds.includes((args[0] as { id: string }).id)) {
          throw new Error(
            "Legacy root was hydrated",
          );
        }
        return original(...args);
      },
    );
    const native = await target();
    await Deno.writeTextFile(
      `${root}/claude/projects/project/${nativeId}.jsonl`,
      '{"type":',
    );
    await expect(native.publishStreams(drivers())).rejects.toThrow(
      "migration is incomplete",
    );
    expect(native.cells.catalog.get()).toBeUndefined();
    await Deno.writeTextFile(
      `${root}/claude/projects/project/${nativeId}.jsonl`,
      '{"type":"user","message":{"content":"recovered"}}\n',
    );
    expect(await native.publishStreams(drivers())).toBe(2);
    const catalog = native.cells.catalog.get() as AgentArchiveCatalog;
    expect(catalog.sessionCount).toBe(2);
    expect(catalog.sources.map((source) => source.source.id)).toEqual([
      "claude",
      "codex",
    ]);
    expect(
      query.calls.some(({ args }) =>
        oldIds.includes((args[0] as { id: string }).id)
      ),
    ).toBe(false);
    for (const id of oldIds) {
      expect(
        (await control({ op: "legacy-read", archive: catalog.archive, id }))
          .legacy?.status,
      ).toBe("refused");
    }
  });

  it("invalidates old capabilities on restart and discards interrupted staging before the first catalog switch", async () => {
    const cells = createAgentFabricCells(connection());
    const binding =
      (await control({ op: "open", handle: stableCellId(cells.catalog) }))
        .binding!;
    await control({
      op: "begin",
      archive: binding.id,
      generation: "a1",
      base: null,
    });
    await control({
      op: "record",
      archive: binding.id,
      generation: "a1",
      record: "b1",
      key: "unfinished",
      source: "claude",
    });
    const old = await ticket({
      op: "open",
      handle: stableCellId(cells.catalog),
    });
    await stop();
    await start();
    const stale = await server.handleArchiveRequest(request(old));
    expect(stale.status).toBe(403);
    await stale.body?.cancel();
    const native = await target();
    expect(native.cells.catalog.get()).toBeUndefined();
    expect(await native.publishStreams(drivers())).toBe(2);
    const catalog = native.cells.catalog.get() as AgentArchiveCatalog;
    const current = (await control({
      op: "open",
      handle: stableCellId(native.cells.catalog),
    })).binding!;
    expect(current.pendingGeneration).toBeNull();
    expect(current.generation).toBe(catalog.generation);
    expect(catalog.sessionCount).toBe(2);
  });

  it("retains unscanned source inventory when a reconnected target refreshes one session", async () => {
    const initial = await target();
    await initial.publishStreams(drivers());
    const reconnected = await target();
    await reconnected.refreshSession(drivers()[0], nativeId);
    const catalog = reconnected.cells.catalog.get() as AgentArchiveCatalog;
    expect(catalog.sessionCount).toBe(2);
    expect(
      catalog.sources.map((
        { source, sessionCount, complete },
      ) => [source.id, sessionCount, complete]),
    ).toEqual([["claude", 1, false], ["codex", 1, true]]);
  });

  it("admits native commands during a scan and serializes their archive refresh", async () => {
    const native = await target();
    const driver = drivers()[0];
    await native.publishStreams([driver]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const invoked = Promise.withResolvers<void>();
    const terminalPublished = Promise.withResolvers<void>();
    const initialCatalog = native.cells.catalog.get() as AgentArchiveCatalog;
    const originalStream = driver.streamSessions.bind(driver);
    const scans: (string | undefined)[] = [];
    let active = 0;
    let maximumActive = 0;
    using _stream = stub(driver, "streamSessions", async function* (options) {
      scans.push(options.nativeSessionId);
      maximumActive = Math.max(maximumActive, ++active);
      try {
        if (scans.length === 1) {
          entered.resolve();
          await release.promise;
        }
        yield* originalStream(options);
      } finally {
        active--;
      }
    });
    using _rename = stub(driver, "renameSession", () => {
      invoked.resolve();
      return Promise.resolve({ status: "succeeded" as const });
    });
    const publishReceipt = native.publishReceipt.bind(native);
    using _receipt = stub(native, "publishReceipt", async (receipt) => {
      await publishReceipt(receipt);
      if (receipt.status === "succeeded") terminalPublished.resolve();
    });
    const worker = new CommandWorker(
      new Map([[driver.source.id, driver]]),
      [native],
      await CommandLedger.open(`${root}/command-ledger.json`),
      owner.did(),
    );
    const collection = native.publishStreams([driver]);
    let fullGeneration: string | undefined;
    try {
      await entered.promise;
      await worker.handle([{
        schema: AGENT_CONNECTOR_SCHEMAS.command,
        ownerDid: owner.did(),
        id: "native-scan-command",
        createdAt: "2026-09-08T00:00:00.000Z",
        sourceId: driver.source.id,
        nativeSessionId: nativeId,
        type: "rename",
        payload: { title: "Updated" },
      }]);
      await invoked.promise;
      await terminalPublished.promise;
      expect((await native.readReceipt("native-scan-command"))?.status)
        .toBe("succeeded");
      expect((native.cells.catalog.get() as AgentArchiveCatalog).generation)
        .toBe(initialCatalog.generation);
      expect(scans).toEqual([undefined]);
      expect(active).toBe(1);
    } finally {
      release.resolve();
      await collection;
      fullGeneration = (native.cells.catalog.get() as AgentArchiveCatalog)
        .generation;
      await worker.drain();
    }
    expect(scans).toEqual([undefined, nativeId]);
    expect(maximumActive).toBe(1);
    expect(active).toBe(0);
    const catalog = native.cells.catalog.get() as AgentArchiveCatalog;
    expect(fullGeneration).toBeDefined();
    expect(catalog.generation).not.toBe(fullGeneration);
    const binding = (await control({
      op: "open",
      handle: stableCellId(native.cells.catalog),
    })).binding!;
    expect(binding.generation).toBe(catalog.generation);
    const scope = { archive: catalog.archive, generation: catalog.generation };
    const pin = (await control({ op: "pin", ...scope })).pin!;
    try {
      const record = (await control({
        op: "get",
        ...scope,
        pin,
        key: sessionKey(driver.source.id, nativeId),
      })).records?.[0];
      expect(record).toBeDefined();
      expect(record!.partial).toBe(false);
    } finally {
      await control({ op: "release", archive: catalog.archive, pin });
    }
  });

  it("returns opaque legacy links without graph reads and checks current CFC before each response chunk", async () => {
    const archive =
      (await control({ op: "open", handle: "legacy-inspection" })).binding!.id;
    await write("of:huge-child", { value: "x".repeat(65536), cfc: metadata() });
    await write("of:hidden", {
      value: "private",
      cfc: metadata("did:key:another-reader"),
    });
    const refusal = await control({
      op: "legacy-read",
      archive,
      id: "of:huge-child",
    });
    expect(await control({ op: "legacy-read", archive, id: "of:hidden" }))
      .toEqual(refusal);
    expect(await control({ op: "legacy-read", archive, id: "of:missing" }))
      .toEqual(refusal);
    await write("of:bounded-parent", {
      value: { child: linkRefFrom({ id: "of:huge-child", path: [] }) },
      cfc: metadata(),
    });
    const result = await control({
      op: "legacy-read",
      archive,
      id: "of:bounded-parent",
    });
    expect(result.legacy?.status).toBe("available");
    expect(result.legacy?.wire).toContain("of:huge-child");
    expect(result.legacy?.wire).not.toContain("x".repeat(500));
    expect(
      server.sessionTracksAny(
        owner.did(),
        session.sessionId,
        new Set(["/space/of:bounded-parent", "/space/of:huge-child"]),
      ),
    ).toBe(false);
    await write("of:bounded-parent", {
      value: { a: '"'.repeat(3000), b: '"'.repeat(3000) },
      cfc: metadata(),
    });
    const capability = await ticket({
      op: "legacy-read",
      archive,
      id: "of:bounded-parent",
    });
    const response = await server.handleArchiveRequest(request(capability));
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(
      16384,
    );
    const reader = response.body!.getReader();
    try {
      expect((await reader.read()).value!.length).toBe(16384);
      await write("of:bounded-parent", {
        value: "revoked",
        cfc: metadata("did:key:another-reader"),
      });
      await expect(reader.read()).rejects.toThrow(
        "no longer available for inspection",
      );
    } finally {
      reader.releaseLock();
      await session.acknowledgeArchive(capability.token);
    }
  });
});
