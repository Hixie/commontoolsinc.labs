/** Isolated Memory v2 server with request, SQLite, and transport probes. */
import { toFileUrl } from "@std/path";
import { Server } from "../v2/server.ts";
import type { Engine } from "../v2/engine.ts";
import { SessionRegistry } from "../v2/session-registry.ts";
import { encodeMemoryBoundary } from "../v2.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";
import {
  collectGarbage,
  contentsSize,
  ProfileLog,
  releaseNativeAllocator,
  sqliteMemoryProbe,
  utf8Bytes,
} from "./agents-storage-profile-probes.ts";

const [directory, token, libraryPath, cacheBudget] = Deno.args;
const log = new ProfileLog(`${directory}/server.jsonl`);
const sqlite = sqliteMemoryProbe(libraryPath);
const sessions = new SessionRegistry();
const sockets = new Set<WebSocket>();
const pendingReceives = new Set<Promise<void>>();
let engine: Engine | undefined;
let generation = 0;
let receiveBytes = 0;
let decodedCommit = { utf8: 0, utf16: 0 };
let transactionOriginalBytes = 0;
let transactionOriginalUtf16 = 0;
let decodedRequests = 0;
let totalOriginalBytes = 0;
let totalRevisionBytes = 0;
let lastRevisionBytes = 0;
let sentBytes = 0;
let sentWatchBytes = 0;
let frames = 0;

function watchCounts() {
  let graphCount = 0;
  let graphEntityCount = 0;
  let entityCount = 0;
  let entityBytes = 0;
  let pendingAcks = 0;
  for (const session of sessions.sessionsForSpace("did:key:agents-profile")) {
    graphCount += session.graphs.size;
    entityCount += session.entities.size;
    for (const graph of session.graphs.values()) {
      graphEntityCount += graph.entities.size;
    }
    for (const entry of session.entities.values()) {
      entityBytes += contentsSize(entry.doc).utf8;
    }
    if (session.pendingCaughtUpLocalSeq > session.caughtUpLocalSeq) {
      pendingAcks++;
    }
  }
  return {
    graphCount,
    graphEntityCount,
    entityCount,
    entityBytes,
    pendingAcks,
  };
}

function sample(stage: string, extra: Record<string, unknown> = {}) {
  return log.write(stage, {
    generation,
    outstanding: {
      receives: pendingReceives.size,
      receiveBytes,
      decodedRequests,
      decodedCommit,
      transactionOriginalBytes,
      transactionOriginalUtf16,
      websocketBufferedBytes: [...sockets].reduce(
        (n, socket) => n + socket.bufferedAmount,
        0,
      ),
    },
    transport: { sentBytes, sentWatchBytes, frames },
    sqlite: sqlite.snapshot(
      engine?.database.open ? engine.database.unsafeHandle : undefined,
    ),
    stored: { totalOriginalBytes, totalRevisionBytes, lastRevisionBytes },
    cache: engine
      ? {
        entries: engine.documentCache.size,
        bytes: engine.documentCacheBytes,
        stats: engine.documentCacheStats,
        stagedEntries: engine.stagedDocumentCache?.size ?? 0,
      }
      : undefined,
    watches: watchCounts(),
    ...extra,
  });
}

class ProfileServer extends Server {
  override async transact(...args: Parameters<Server["transact"]>) {
    decodedRequests++;
    decodedCommit = contentsSize(args[0].commit);
    sample("transact-decoded");
    try {
      return await super.transact(...args);
    } finally {
      decodedRequests--;
      decodedCommit = { utf8: 0, utf16: 0 };
      sample("transact-complete");
    }
  }

  override async graphQuery(...args: Parameters<Server["graphQuery"]>) {
    decodedRequests++;
    sample("query-decoded");
    try {
      const result = await super.graphQuery(...args);
      sample("query-result", { resultContents: contentsSize(result) });
      return result;
    } finally {
      decodedRequests--;
    }
  }
}

let server: ProfileServer | undefined = new ProfileServer({
  ...testSessionOpenServerOptions,
  sessions,
  store: toFileUrl(`${directory}/store/`),
  subscriptionRefreshDelayMs: 0,
  documentCacheBudgetBytes: Number(cacheBudget),
});
server.accessForTestingOnly.engineOpener = async (space, open) => {
  const opened = await open(space);
  if (engine === opened) return opened;
  engine = opened;
  sample("sqlite-configuration", {
    compileOptions: opened.database.prepare("PRAGMA compile_options").all(),
  });
  const original = opened.statements.insertCommit;
  opened.statements.insertCommit = new Proxy(original, {
    get(target, property) {
      if (property !== "run") return Reflect.get(target, property, target);
      return (...args: Parameters<typeof original.run>) => {
        const row = args[0] as { original: string };
        transactionOriginalBytes = utf8Bytes(row.original);
        transactionOriginalUtf16 = row.original.length * 2;
        totalOriginalBytes += transactionOriginalBytes;
        sample("commit-original-encoded");
        const result = target.run(...args);
        sample("commit-original-stored");
        return result;
      };
    },
  });
  const revision = opened.statements.insertRevision;
  opened.statements.insertRevision = new Proxy(revision, {
    get(target, property) {
      if (property !== "run") return Reflect.get(target, property, target);
      return (...args: Parameters<typeof revision.run>) => {
        const row = args[0] as { data: string | null };
        lastRevisionBytes = typeof row.data === "string"
          ? utf8Bytes(row.data)
          : 0;
        totalRevisionBytes += lastRevisionBytes;
        const result = target.run(...args);
        sample("revision-stored");
        return result;
      };
    },
  });
  const database = opened.database;
  opened.database = new Proxy(database, {
    get(target, property) {
      if (property === "transaction") {
        return (...args: Parameters<typeof database.transaction>) => {
          const transaction = target.transaction(...args);
          return Object.assign(
            (...args: Parameters<typeof transaction>) => transaction(...args),
            {
              immediate: (
                ...args: Parameters<typeof transaction.immediate>
              ) => {
                try {
                  return transaction.immediate(...args);
                } finally {
                  transactionOriginalBytes = 0;
                  transactionOriginalUtf16 = 0;
                  sample("sqlite-transaction-complete");
                }
              },
              deferred: transaction.deferred,
              exclusive: transaction.exclusive,
            },
          );
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  sample("engine-opened");
  return opened;
};

const stop = Promise.withResolvers<void>();
const http = Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen({ port }) {
    sample("ready");
    console.log(JSON.stringify({ port, pid: Deno.pid }));
  },
}, async (request) => {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== token) {
    return new Response("Forbidden", { status: 403 });
  }
  if (url.pathname === "/socket") {
    const { socket, response } = Deno.upgradeWebSocket(request);
    const connection = server!.connect((message) => {
      const encoded = encodeMemoryBoundary(message);
      const bytes = utf8Bytes(encoded);
      sentBytes += bytes;
      if (message.type === "session/effect") sentWatchBytes += bytes;
      frames++;
      sample("reply-encoded", { messageType: message.type, replyBytes: bytes });
      socket.send(encoded);
      sample("reply-queued", { messageType: message.type, replyBytes: bytes });
    });
    sockets.add(socket);
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        throw new Error("proof transport requires text");
      }
      const bytes = utf8Bytes(event.data);
      receiveBytes += bytes;
      sample("request-received", { requestBytes: bytes });
      const received = connection.receive(event.data).finally(() => {
        receiveBytes -= bytes;
        pendingReceives.delete(received);
        sample("request-complete");
      });
      pendingReceives.add(received);
    };
    socket.onclose = () => {
      sockets.delete(socket);
      connection.close();
    };
    return response;
  }
  await Promise.all([...pendingReceives]);
  await server?.idle();
  generation = Number(url.searchParams.get("generation") ?? generation);
  const stage = url.searchParams.get("stage") ?? url.pathname;
  if (url.pathname === "/collect") collectGarbage();
  if (url.pathname === "/clear-cache") {
    engine!.documentCache.clear();
    engine!.documentCacheBytes = 0;
    collectGarbage();
  }
  if (url.pathname === "/shrink-sqlite") {
    engine!.database.exec("PRAGMA shrink_memory");
    collectGarbage();
  }
  if (url.pathname === "/close-storage") {
    await server!.close();
    server = undefined;
    engine = undefined;
    collectGarbage();
  }
  const allocatorReleasedBytes = url.pathname === "/release-allocator"
    ? releaseNativeAllocator()
    : undefined;
  const row = sample(stage, { allocatorReleasedBytes });
  if (url.pathname === "/stop") stop.resolve();
  return Response.json(row);
});
await stop.promise;
await http.shutdown();
await server?.close();
log.close();
sqlite.close();
