/** Runs the production host with native provider drivers and stage probes. */

import { CommandLedger } from "../src/command-ledger.ts";
import { createAgentFabricCells } from "../src/fabric.ts";
import {
  type RunningAgentsHost,
  startAgentsHost,
} from "../../host/src/start.ts";
import { AgentsHost } from "../../host/src/host.ts";
import {
  type AgentFabricRuntime,
  openAgentFabricRuntime,
} from "../../host/src/fabric-runtime.ts";
import { AgentsHostProcessLock } from "../../host/src/process-lock.ts";
import {
  deployAgentSessionsDebugView,
  describeAgentFabricTarget,
} from "../../host/src/debug-view.ts";
import type { CollectionStage } from "../src/session-stream.ts";
import { assertProfileDataHandlesClosed } from "./host-memory-handles.ts";
import {
  commands,
  config,
  log,
  reply,
  role,
  settled,
} from "./host-memory-common.ts";

let fabric: AgentFabricRuntime | undefined;
let running: RunningAgentsHost | undefined;
let interruptAfter = Infinity;
let interruption: AbortController | undefined;
let counts: Partial<Record<CollectionStage, number>> = {};
let peaks: Partial<Record<CollectionStage, Deno.MemoryUsage>> = {};
function catalogDetails() {
  const catalog = fabric!.target.cells.catalog.get();
  return {
    catalog,
    catalogBytes: new TextEncoder().encode(JSON.stringify(catalog)).length,
    collection: running!.host.health().sync,
    readBytes: config.readBytes,
    pageBytes: config.pageBytes,
  };
}
function observe(stage: CollectionStage) {
  const count = counts[stage] = (counts[stage] ?? 0) + 1;
  if (stage === "publication" && --interruptAfter === 0) {
    interruption!.abort(new Error("Deliberate benchmark interruption"));
  }
  if (count !== 1 && count % (stage === "decoding" ? 4096 : 256) !== 0) return;
  const usage = Deno.memoryUsage();
  const previous = peaks[stage];
  peaks[stage] = previous
    ? {
      rss: Math.max(previous.rss, usage.rss),
      heapUsed: Math.max(previous.heapUsed, usage.heapUsed),
      heapTotal: Math.max(previous.heapTotal, usage.heapTotal),
      external: Math.max(previous.external, usage.external),
    }
    : usage;
  log.write(stage, { count, peak: peaks[stage] });
}
const options = {
  apiUrl: config.apiUrl!,
  identityPath: config.identityPath,
  ownerDid: config.ownerDid,
  space: config.spaceDid ?? "agents-memory-profile",
};
await reply("ready", { pid: Deno.pid });
await commands(async (command) => {
  if (command.op === "open") {
    fabric = await openAgentFabricRuntime({
      ...options,
      deferStorageClaim: true,
    });
    const cells = createAgentFabricCells({
      runtime: fabric.runtime,
      spaceDid: fabric.spaceDid,
      ownerDid: config.ownerDid,
    });
    const ids = [cells.index, cells.allIndex].map((cell) =>
      cell.getAsNormalizedFullLink().id!
    );
    return {
      ids,
      spaceDid: fabric.spaceDid,
      catalogId: cells.catalog.getAsNormalizedFullLink().id!,
    };
  }
  if (command.op === "start") {
    counts = {};
    peaks = {};
    running = await startAgentsHost({
      ...options,
      sources: config.sources.map((source) =>
        source.command?.[0] === "/usr/bin/time"
          ? {
            ...source,
            command: source.command.map((argument) =>
              argument === `${config.directory}/codex.rss`
                ? `${config.directory}/${role}-codex.rss`
                : argument
            ),
          }
          : source
      ),
      checkoutRoots: [],
      debugView: config.debugView,
      acceptCommands: false,
    }, {
      openFabric: async (input) =>
        fabric ??= await openAgentFabricRuntime(input),
      targetLockPath: () => Promise.resolve(`${config.directory}/host.lock`),
      acquireProcessLock: AgentsHostProcessLock.acquire,
      ledgerPath: () => Promise.resolve(`${config.directory}/commands.json`),
      async deployDebugView(
        ...input: Parameters<typeof deployAgentSessionsDebugView>
      ) {
        settled("debug-compilation-before", { peaks, counts });
        const deployed = await deployAgentSessionsDebugView(...input);
        settled("debug-compilation-after", { peaks, counts });
        return deployed;
      },
      openLedger: CommandLedger.open,
      describeTarget: describeAgentFabricTarget,
      createHost(input) {
        fabric!.target.configureArchive({
          scratchDirectory: `${config.directory}/scratch`,
          limits: { readBytes: config.readBytes, pageBytes: config.pageBytes },
          observe,
        });
        return new AgentsHost(input);
      },
    });
    return settled("startup", {
      count: running.initialSessionCount,
      ...catalogDetails(),
      debugPieceId: running.debugPieceId,
      peaks,
      counts,
    });
  }
  if (command.op === "refresh" || command.op === "interrupt") {
    counts = {};
    peaks = {};
    interruption = new AbortController();
    interruptAfter = command.op === "interrupt" ? 8 : Infinity;
    let interrupted = false;
    try {
      await running!.host.synchronize(
        String(command.stage ?? command.op),
        interruption.signal,
      );
    } catch (error) {
      if (!interruption.signal.aborted) throw error;
      interrupted = true;
    } finally {
      interruptAfter = Infinity;
    }
    if (command.op === "interrupt" && !interrupted) {
      throw new Error("The requested interruption did not occur");
    }
    return settled(String(command.stage ?? command.op), {
      interrupted,
      ...catalogDetails(),
      peaks,
      counts,
    });
  }
  if (command.op === "sample") {
    return settled(String(command.stage), { peaks, counts });
  }
  if (command.op === "stop") {
    if (running) await running.stop("benchmark-completed");
    else await fabric?.runtime.dispose();
    running = undefined;
    fabric = undefined;
    return settled(`${role}-closed`, {
      peaks,
      counts,
      handles: await assertProfileDataHandlesClosed(config.directory),
    });
  }
  throw new Error("Unknown host profile command");
});
