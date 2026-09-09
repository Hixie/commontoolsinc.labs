// deno-lint-ignore-file cf-imports/no-inline-module-import -- Toolshed modules read the private environment installed during startup.
/** Runs the Toolshed HTTP routes, Memory backend, and runtime in one process. */

import { PROFILE_CEILINGS } from "./host-memory-safety.ts";
import { Database } from "@db/sqlite";
import { ARCHIVE_LIMITS } from "@commonfabric/memory/v2/archive";
import { toFileUrl } from "@std/path";
import type { Engine } from "@commonfabric/memory/v2/engine";
import { applyCommit } from "@commonfabric/memory/v2/engine";
import { encodeMemoryBoundary } from "@commonfabric/memory/v2";
import { archiveAuthorization } from "@commonfabric/runner/cfc/archive";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { agentOwnerSchema } from "../src/fabric-graph.ts";
import { commands, config, log, reply, settled } from "./host-memory-common.ts";
import { assertProfileDataHandlesClosed } from "./host-memory-handles.ts";

const ready = Promise.withResolvers<
  (request: Request) => Response | Promise<Response>
>();
let requests = 0;
let responseBytes = 0;
let maxResponseBytes = 0;
let archiveResponseBytes = 0;
let maxArchiveResponseBytes = 0;
let archiveResponses = 0;
const http = Deno.serve({
  hostname: "127.0.0.1",
  port: config.apiUrl ? Number(new URL(config.apiUrl).port) : 0,
  onListen() {},
}, async (request) => {
  const response = await (await ready.promise)(request);
  const bytes = Number(response.headers.get("content-length") ?? 0);
  responseBytes += bytes;
  maxResponseBytes = Math.max(maxResponseBytes, bytes);
  if (++requests % 1024 === 0) sample("http-response");
  if (
    new URL(request.url).pathname === "/api/storage/memory/archive" &&
    response.body
  ) {
    let consumed = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          consumed += chunk.byteLength;
          if (consumed > ARCHIVE_LIMITS.controlBytes) {
            throw new Error("Archive response exceeded its byte ceiling");
          }
          controller.enqueue(chunk);
        },
        flush() {
          if (consumed !== bytes) {
            throw new Error("Archive response length did not match its header");
          }
          archiveResponses++;
          archiveResponseBytes += consumed;
          maxArchiveResponseBytes = Math.max(maxArchiveResponseBytes, consumed);
        },
      }),
    );
    return new Response(body, response);
  }
  return response;
});
const apiUrl = `http://127.0.0.1:${http.addr.port}`;
for (
  const [key, value] of Object.entries({
    ENV: "test",
    API_URL: apiUrl,
    MEMORY_URL: apiUrl,
    MEMORY_DIR: toFileUrl(`${config.directory}/memory/`).href,
    MEMORY_ARCHIVE_ROOT: `${config.directory}/archive`,
    MEMORY_ARCHIVE_QUOTA_BYTES: String(PROFILE_CEILINGS.archiveBytes),
    MEMORY_ARCHIVE_ORIGINS: apiUrl,
    IDENTITY: config.identityPath,
    CACHE_DIR: `${config.directory}/cache`,
    LOG_LEVEL: "silent",
    DISABLE_LOG_REQ_RES: "true",
    OTEL_ENABLED: "false",
    CFTS_AI_GATEWAY_URL: "",
    EXPERIMENTAL_SERVER_EXECUTION: "false",
  })
) Deno.env.set(key, value);
Deno.env.delete("DB_PATH");

// These modules read their environment during initialization.
const [
  { default: app },
  { memoryServer },
  { createToolshedRuntime },
  { default: env },
  { StorageManager },
  { identity },
] = await Promise.all([
  import("../../../../toolshed/app.ts"),
  import("../../../../toolshed/routes/storage/memory.ts"),
  import("../../../../toolshed/runtime-options.ts"),
  import("../../../../toolshed/env.ts"),
  import("@commonfabric/runner/storage/cache.deno"),
  import("../../../../toolshed/lib/identity.ts"),
]);
const runtime = createToolshedRuntime(
  env,
  StorageManager.open({ memoryHost: new URL(apiUrl), as: identity }),
);
const archiveDatabase = new Database(
  `${config.directory}/archive/catalog.sqlite`,
  { readonly: true },
);
using archiveCleanup = new DisposableStack();
archiveCleanup.defer(() => archiveDatabase.close());
let engine: Engine | undefined;
let spaceDid = config.spaceDid;
let legacyHydrations = 0;
let legacyRequests = 0;
let legacyVisit = false;
let localReads = 0;
let frozenWrites = 0;
const readExamples: string[] = [];
const operationCounts: Record<string, number> = {};
let commitBytes = 0;
let maxCommitBytes = 0;
const legacyIds = new Set(config.legacyIds ?? []);
const frozenIds = new Set([
  ...legacyIds,
  ...(config.legacyPieceId ? [`of:${config.legacyPieceId}`] : []),
]);
memoryServer.accessForTestingOnly.engineOpener = async (space, open) => {
  const opened = await open(space);
  if ((spaceDid !== undefined && space !== spaceDid) || engine === opened) {
    return opened;
  }
  engine = opened;
  const read = opened.statements.selectCurrentLocal.get.bind(
    opened.statements.selectCurrentLocal,
  );
  opened.statements.selectCurrentLocal.get = (
    ...args: Parameters<typeof read>
  ) => {
    localReads++;
    const id = (args[0] as { id: string }).id;
    if (readExamples.length < 16) readExamples.push(id);
    if (legacyIds.has(id)) {
      legacyHydrations++;
      if (!legacyVisit) {
        throw new Error("Host benchmark observed legacy document hydration");
      }
    }
    return read(...args);
  };
  return opened;
};
for (const operation of ["graphQuery", "watchSet", "watchAdd"] as const) {
  const call = memoryServer[operation].bind(memoryServer);
  Object.assign(memoryServer, {
    [operation]: (message: Parameters<typeof call>[0]) => {
      operationCounts[operation] = (operationCounts[operation] ?? 0) + 1;
      const wire = encodeMemoryBoundary(message);
      if ([...legacyIds].some((id) => wire.includes(id))) {
        legacyRequests++;
        if (!legacyVisit) {
          throw new Error("Host benchmark observed a legacy query or watch");
        }
      }
      return call(message as never);
    },
  });
}
const transact = memoryServer.transact.bind(memoryServer);
memoryServer.transact = (...args) => {
  if (
    args[0].commit.operations.some((operation) =>
      "id" in operation && frozenIds.has(operation.id)
    )
  ) {
    frozenWrites++;
    if (!legacyVisit) {
      throw new Error(
        "Host benchmark observed a write to a frozen legacy root",
      );
    }
  }
  const bytes =
    new TextEncoder().encode(encodeMemoryBoundary(args[0].commit)).length;
  commitBytes += bytes;
  maxCommitBytes = Math.max(maxCommitBytes, bytes);
  log.write("transact", { bytes });
  return transact(...args);
};
function details() {
  let stored;
  const frozenDocuments = [];
  using resources = archiveDatabase.prepare(
    "SELECT (SELECT count(*) FROM pins) AS pins,(SELECT count(*) FROM tickets) AS tickets",
  );
  const archiveResources = resources.get();
  const archiveMetadataBytes: Record<string, number> = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      archiveMetadataBytes[suffix || "database"] = Deno.statSync(
        `${config.directory}/archive/catalog.sqlite${suffix}`,
      ).size;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      archiveMetadataBytes[suffix || "database"] = 0;
    }
  }
  if (engine?.database.open) {
    using revisions = engine.database.prepare(
      "SELECT count(*) AS revisions, sum(octet_length(data)) AS bytes, max(octet_length(data)) AS largest FROM revision",
    );
    stored = revisions.get();
    using head = engine.database.prepare(
      "SELECT seq,op_index,op FROM head WHERE branch='' AND scope_key='space' AND id=?",
    );
    using sizes = engine.database.prepare(
      "SELECT count(*) AS revisions,sum(octet_length(data)) AS bytes,max(octet_length(data)) AS largest FROM revision WHERE branch='' AND scope_key='space' AND id=?",
    );
    for (const id of frozenIds) {
      frozenDocuments.push({ id, head: head.get(id), stored: sizes.get(id) });
    }
  }
  return {
    requests,
    responseBytes,
    maxResponseBytes,
    archiveResponses,
    archiveResponseBytes,
    maxArchiveResponseBytes,
    archiveResources,
    archiveMetadataBytes,
    activeArchiveTransfers:
      memoryServer.accessForTestingOnly.activeArchiveTransfers,
    legacyHydrations,
    legacyRequests,
    localReads,
    readExamples,
    operationCounts: { ...operationCounts },
    frozenWrites,
    legacyVisit,
    commitBytes,
    maxCommitBytes,
    caches: memoryServer.documentCachesDiagnostics(),
    demand: spaceDid
      ? memoryServer.demandSetSizesForSpace(spaceDid)
      : undefined,
    stored,
    frozenDocuments,
  };
}
function sample(stage: string) {
  return log.write(stage, details());
}
let frontend:
  | { fetch: (request: Request) => Response | Promise<Response> }
  | undefined;
if (config.shellRoot) {
  const { createShellStaticRouter } = await import(
    "../../../../toolshed/routes/shell/shell-static.ts"
  );
  frontend = createShellStaticRouter(config.shellRoot);
}
ready.resolve((request) => {
  const path = new URL(request.url).pathname;
  return frontend && !path.startsWith("/api/") &&
      !path.startsWith("/_health") && !path.startsWith("/static/")
    ? frontend.fetch(request)
    : app.fetch(request);
});
await reply("ready", { apiUrl, pid: Deno.pid });
settled("ready", details());

await commands(async (command) => {
  if (command.op === "seed") {
    const ids = command.ids as string[];
    spaceDid = String(command.spaceDid);
    const schema = agentOwnerSchema(config.ownerDid);
    const schemaHash = internSchemaAsTaggedHashString(schema);
    const policy = archiveAuthorization("commonfabric.agents-connector");
    const cfc = {
      ...JSON.parse(
        policy.create({
          space: spaceDid,
          principal: config.ownerDid,
          actingPrincipal: config.ownerDid,
          connectionId: "fixture",
          sessionId: "fixture",
        }, []).cfcPolicy,
      ),
      schemaHash,
    };
    const opened = await memoryServer.engineForSpace(spaceDid!);
    const operations = [
      { op: "set" as const, id: `cid:${schemaHash}`, value: { value: schema } },
      ...ids.map((id) => ({
        op: "set" as const,
        id,
        value: {
          value: {
            sessions: Array.from(
              { length: 2000 },
              (_, index) => ({
                manifest: {
                  "/": {
                    "link@1": { id: `of:legacy-session-${index}`, path: [] },
                  },
                },
              }),
            ),
          },
          cfc,
        },
      })),
    ];
    applyCommit(opened, {
      sessionId: "profile-legacy-fixtures",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations,
      },
    });
    for (const id of ids) {
      legacyIds.add(id);
      frozenIds.add(id);
    }
    return { ids, schemaHash };
  }
  if (command.op === "legacy-visit") {
    if (spaceDid) await memoryServer.engineForSpace(spaceDid);
    legacyVisit = true;
    return settled("legacy-visit-start", details());
  }
  if (command.op === "sample") {
    await memoryServer.idle();
    return settled(String(command.stage), details());
  }
  if (command.op === "stop") {
    await runtime.dispose();
    await memoryServer.close();
    await http.shutdown();
    const closed = details();
    archiveCleanup.dispose();
    return settled("closed", {
      ...closed,
      handles: await assertProfileDataHandlesClosed(config.directory),
    });
  }
  throw new Error("Unknown Toolshed profile command");
});
