/** Reopens a private snapshot with one Toolshed and one headless browser. */

import { parseArgs } from "@std/cli/parse-args";
import type { ProfileConfig } from "./host-memory-common.ts";
import { ProfileProcess } from "./host-memory-process.ts";
import { ProfileSafety } from "./host-memory-safety.ts";

const args = parseArgs(Deno.args, {
  string: ["directory", "piece", "name", "space"],
  boolean: ["legacy", "readback"],
});
if (!args.directory || !args.name) {
  throw new Error(
    "An existing private benchmark directory and unused run name are required",
  );
}
const directory = String(args.directory);
const configPath = `${directory}/profile.json`;
const config: ProfileConfig = JSON.parse(await Deno.readTextFile(configPath));
const pieceId = args.legacy ? config.legacyPieceId : args.piece;
if (!args.readback && (!pieceId || !config.shellRoot)) {
  throw new Error("A saved piece ID and compiled shell directory are required");
}
using safety = new ProfileSafety(directory);
await safety.sample();
safety.check();
const server = new ProfileProcess(
  "./host-memory-toolshed.ts",
  `${args.name}-toolshed`,
  directory,
);
let browser: ProfileProcess | undefined;
const results: unknown[] = [];
async function save(stage: string, value: unknown) {
  safety.check();
  results.push({ stage, value });
  await Deno.writeTextFile(
    `${directory}/${args.name}-results.json`,
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify({ stage, value }));
}
const failures: unknown[] = [];
try {
  const ready = await server.ready as { apiUrl: string };
  config.apiUrl = ready.apiUrl;
  await Deno.writeTextFile(configPath, JSON.stringify(config));
  await save(
    "toolshed-before",
    await server.call(args.legacy ? "legacy-visit" : "sample", {
      stage: "before-browser",
    }),
  );
  browser = new ProfileProcess(
    args.readback ? "./host-memory-reader.ts" : "./host-memory-browser.ts",
    `${args.name}-${args.readback ? "reader" : "browser"}`,
    directory,
  );
  await browser.ready;
  const visit = await browser.call(args.readback ? "read" : "visit", {
    pieceId,
    ...(args.space ? { space: args.space } : {}),
  }) as { state?: { bootstrapError?: string } };
  await save(args.readback ? "readback" : "browser-visit", visit);
  await save(
    "toolshed-after-visit",
    await server.call("sample", { stage: "after-browser" }),
  );
  if (visit.state?.bootstrapError !== undefined) {
    throw new Error(visit.state.bootstrapError);
  }
  if (!args.legacy && !args.readback) {
    type ServerSample = {
      commitBytes: number;
      demand: {
        unionKeys: number;
        perSession: { tracked: number; watches: number }[];
      };
      activeArchiveTransfers: number;
      archiveResources: { pins: number; tickets: number };
      maxArchiveResponseBytes: number;
    };
    let baseline: ServerSample | undefined;
    const actions = [
      {},
      { row: 0 },
      { label: "Page 1" },
      { label: "Page 2" },
      { label: "Next pages" },
      { label: "Page 17" },
      { row: 1 },
      { label: "Page 1" },
      { label: "Page 2" },
      { label: "Next pages" },
      { label: "Page 17" },
      { row: 0 },
      { label: "Page 1" },
      { row: 1 },
      { label: "Page 1" },
    ];
    for (const [index, action] of actions.entries()) {
      await save(
        `navigate-${index}`,
        await browser.call("navigate", action),
      );
      const serverState = await server.call("sample", {
        stage: `navigate-${index}`,
      }) as ServerSample;
      await save(`toolshed-navigate-${index}`, serverState);
      baseline ??= serverState;
      if (
        serverState.commitBytes !== baseline.commitBytes ||
        JSON.stringify(serverState.demand) !== JSON.stringify(baseline.demand)
      ) {
        throw new Error(
          "Archive navigation changed Fabric writes or watch demand",
        );
      }
      if (
        serverState.activeArchiveTransfers !== 0 ||
        serverState.archiveResources.tickets !== 0 ||
        serverState.archiveResources.pins !== 1
      ) {
        throw new Error(
          "Archive navigation retained a transfer, ticket, or extra reader pin",
        );
      }
    }
    await save("view-closed", await browser.call("close-view"));
    const closedState = await server.call("sample", {
      stage: "view-closed",
    }) as ServerSample;
    if (
      closedState.activeArchiveTransfers || closedState.archiveResources.pins ||
      closedState.archiveResources.tickets
    ) {
      throw new Error("Closing the view retained archive resources");
    }
    await save(
      "toolshed-view-closed",
      closedState,
    );
  }
} catch (error) {
  failures.push(error);
}
for (const process of [browser, server]) {
  try {
    await process?.close();
  } catch (error) {
    failures.push(error);
  }
}
safety.check();
if (failures.length) {
  throw new AggregateError(failures, "Private archive inspection failed");
}
