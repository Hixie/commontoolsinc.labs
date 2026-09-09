/**
 * Opt-in host and Toolshed RSS benchmark. Native fixtures and result logs stay
 * in the requested directory so interrupted runs can be inspected.
 */

import { PROFILE_CEILINGS, ProfileSafety } from "./host-memory-safety.ts";
import { parseArgs } from "@std/cli/parse-args";
import { encodeHex } from "@std/encoding/hex";
import { ProfileProcess as Process } from "./host-memory-process.ts";
import { createHasher } from "@commonfabric/content-hash";
import { Identity } from "@commonfabric/identity";
import type { ProfileConfig } from "./host-memory-common.ts";
import { collectionLimits } from "../src/session-stream.ts";

const args = parseArgs(Deno.args, {
  string: [
    "directory",
    "sessions",
    "bytes",
    "read-bytes",
    "page-bytes",
    "codex-bin",
  ],
  boolean: [
    "debug-view",
    "recover",
    "fixtures-only",
    "readback",
    "initial-only",
    "delete",
    "unique-blocks",
  ],
  default: {
    sessions: "16",
    bytes: "65536",
    "debug-view": true,
    readback: true,
  },
});
if (!args.directory) {
  throw new Error(
    "--directory is required; this benchmark retains its fixtures and logs",
  );
}
const directory = String(args.directory);
const sessions = Number(args.sessions);
const bytes = Number(args.bytes);
const limits = collectionLimits({
  ...(args["read-bytes"] === undefined
    ? {}
    : { readBytes: Number(args["read-bytes"]) }),
  ...(args["page-bytes"] === undefined
    ? {}
    : { pageBytes: Number(args["page-bytes"]) }),
});
for (const value of [sessions, bytes]) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Fixture dimensions must be positive integers");
  }
}
await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
using safety = new ProfileSafety(directory);
await safety.sample();
safety.check();
if (
  sessions > PROFILE_CEILINGS.files ||
  sessions * (bytes + 65536) > PROFILE_CEILINGS.sourceBytes
) throw new Error("Fixture request exceeds the explicit safety ceilings");
const dataset = `${directory}/native`;
const identityPath = `${directory}/identity.key`;
let config: ProfileConfig;
const configPath = `${directory}/profile.json`;
const first = "00000000-0000-4000-8000-000000000000";
const firstPath = `${dataset}/claude/projects/fixture/${first}.jsonl`;

if (args.recover) {
  config = JSON.parse(await Deno.readTextFile(configPath));
  const recoveredLimits = collectionLimits({
    readBytes: args["read-bytes"] === undefined
      ? config.readBytes
      : limits.readBytes,
    pageBytes: args["page-bytes"] === undefined
      ? config.pageBytes
      : limits.pageBytes,
  });
  config.readBytes = recoveredLimits.readBytes;
  config.pageBytes = recoveredLimits.pageBytes;
} else {
  const key = await Identity.generatePkcs8();
  const identity = await Identity.fromPkcs8(key);
  await Deno.writeFile(identityPath, key, { createNew: true, mode: 0o600 });
  const codex = String(args["codex-bin"] ?? "codex");
  config = {
    directory,
    dataset,
    identityPath,
    ownerDid: identity.did(),
    readBytes: limits.readBytes,
    pageBytes: limits.pageBytes,
    debugView: args["debug-view"],
    sources: [
      {
        id: "claude",
        driver: "claude-agent-sdk",
        enabled: true,
        configDir: `${dataset}/claude`,
      },
      {
        id: "codex",
        driver: "codex-app-server",
        enabled: true,
        codexHome: `${dataset}/codex`,
        command: Deno.build.os === "darwin"
          ? [
            "/usr/bin/time",
            "-l",
            "-o",
            `${directory}/codex.rss`,
            codex,
            "app-server",
            "--listen",
            "stdio://",
          ]
          : [codex, "app-server", "--listen", "stdio://"],
      },
    ],
  };
  await Deno.mkdir(`${dataset}/claude/projects/fixture`, {
    recursive: true,
    mode: 0o700,
  });
  await Deno.mkdir(`${dataset}/codex/sessions`, {
    recursive: true,
    mode: 0o700,
  });
  using expected = await Deno.open(`${directory}/expected.jsonl`, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  const encoder = new TextEncoder();
  const block = encoder.encode(
    ("x".repeat(128) + '\\n\\t\\uD83D\\uDC08\\"\\\\🐈').repeat(256),
  );
  let totalBytes = 0;
  for (let index = 0; index < sessions; index++) {
    safety.check();
    const id = `00000000-0000-4000-8000-${
      index.toString(16).padStart(12, "0")
    }`;
    const source = index % 2 === 0 ? "claude" : "codex";
    const path = source === "claude"
      ? `${dataset}/claude/projects/fixture/${id}.jsonl`
      : `${dataset}/codex/sessions/${id}.jsonl`;
    using file = await Deno.open(path, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    const hash = createHasher();
    let written = 0;
    const write = async (chunk: Uint8Array) => {
      safety.check();
      hash.update(chunk);
      written += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        offset += await file.write(chunk.subarray(offset));
      }
    };
    await write(
      encoder.encode(
        source === "claude"
          ? `{"type":"assistant","uuid":"${id}","message":{"role":"assistant","content":"`
          : `{"type":"response_item","payload":{"type":"message","id":"${id}","role":"assistant","content":[{"type":"output_text","text":"`,
      ),
    );
    let chunkIndex = 0;
    while (written < bytes) {
      if (args["unique-blocks"]) {
        encoder.encodeInto(
          index.toString(16).padStart(8, "0") +
            (chunkIndex++).toString(16).padStart(8, "0"),
          block,
        );
      }
      await write(block);
    }
    await write(encoder.encode(source === "claude" ? '"}}\n' : '"}]}}\n'));
    totalBytes += written;
    const row = encoder.encode(
      JSON.stringify({
        source,
        id,
        path,
        bytes: written,
        hash: encodeHex(hash.digest()),
        events: 1,
        messages: 1,
      }) + "\n",
    );
    let offset = 0;
    while (offset < row.length) {
      offset += await expected.write(row.subarray(offset));
    }
    if ((index + 1) % 1024 === 0) {
      console.log(
        JSON.stringify({ stage: "fixtures", sessions: index + 1, totalBytes }),
      );
    }
  }
  await Deno.writeTextFile(
    `${directory}/dataset.json`,
    JSON.stringify({
      sessions,
      bytesPerSession: bytes,
      totalBytes,
      uniqueBlocks: args["unique-blocks"],
    }),
  );
  await Deno.writeTextFile(configPath, JSON.stringify(config));
}

if (args["fixtures-only"]) Deno.exit(0);

let toolshed: Process | undefined;
let host: Process | undefined;
let reader: Process | undefined;
let sequence = 0;
for await (const file of Deno.readDir(directory)) {
  const prior = /^host-(\d+)\.stdout$/.exec(file.name);
  if (prior) sequence = Math.max(sequence, Number(prior[1]) + 1);
}
const observations: unknown[] = [];
const resultPath = `${directory}/results-${sequence}.json`;
async function save(stage: string, value: unknown) {
  safety.check();
  observations.push({ stage, value });
  await Deno.writeTextFile(resultPath, JSON.stringify(observations, null, 2));
  await Deno.writeTextFile(
    `${directory}/results.json`,
    JSON.stringify(observations, null, 2),
  );
  console.log(JSON.stringify({ stage, value }));
}
async function startToolshed() {
  toolshed = new Process(
    "./host-memory-toolshed.ts",
    `toolshed-${sequence}`,
    directory,
  );
  const ready = await toolshed.ready as { apiUrl: string };
  config.apiUrl = ready.apiUrl;
  await Deno.writeTextFile(configPath, JSON.stringify(config));
  const preflight = await fetch(`${config.apiUrl}/api/storage/memory/archive`, {
    method: "OPTIONS",
    headers: {
      origin: config.apiUrl,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type",
    },
  });
  if (
    preflight.status !== 204 ||
    preflight.headers.get("access-control-allow-origin") !== config.apiUrl
  ) {
    throw new Error(
      "Toolshed archive preflight did not preserve its exact origin policy",
    );
  }
  await preflight.body?.cancel();
  const denied = await fetch(`${config.apiUrl}/api/storage/memory/archive`, {
    method: "OPTIONS",
    headers: {
      origin: "https://untrusted.example",
      "access-control-request-method": "POST",
    },
  });
  if (
    denied.status !== 403 || denied.headers.has("access-control-allow-origin")
  ) throw new Error("Toolshed accepted an unlisted archive origin");
  await denied.body?.cancel();
}
async function readback(stage: string) {
  if (!args.readback) return;
  reader = new Process(
    "./host-memory-reader.ts",
    `reader-${sequence}-${stage}`,
    directory,
  );
  await reader.ready;
  await save(`readback-${stage}`, await reader.call("read"));
  await reader.close();
  reader = undefined;
}
async function startHost() {
  host = new Process("./host-memory-host.ts", `host-${sequence}`, directory);
  await host.ready;
  const opened = await host.call("open") as { ids: string[]; spaceDid: string };
  if (!config.legacyIds) {
    await toolshed!.call("seed", opened);
    config.legacyIds = opened.ids;
    config.spaceDid = opened.spaceDid;
    await Deno.writeTextFile(configPath, JSON.stringify(config));
  }
  await save(`startup-${sequence}`, await host.call("start"));
  await save(
    `toolshed-startup-${sequence}`,
    await toolshed!.call("sample", { stage: "host-startup" }),
  );
}
const failures: unknown[] = [];
try {
  await startToolshed();
  await startHost();
  await readback("startup");
  if (!args["initial-only"]) {
    await save(
      "unchanged",
      await host!.call("refresh", { stage: "unchanged" }),
    );
    await save(
      "toolshed-unchanged",
      await toolshed!.call("sample", { stage: "unchanged" }),
    );
    await Deno.writeTextFile(
      firstPath,
      '{"type":"user","uuid":"appended","message":{"content":"Appended native record"}}\n',
      { append: true },
    );
    await save("append", await host!.call("refresh", { stage: "append" }));
    await save(
      "toolshed-append",
      await toolshed!.call("sample", { stage: "append" }),
    );
    if (args.delete) {
      const info = JSON.parse(
        await Deno.readTextFile(`${directory}/dataset.json`),
      );
      const lastIndex = info.sessions - 1;
      const lastId = `00000000-0000-4000-8000-${
        lastIndex.toString(16).padStart(12, "0")
      }`;
      const lastPath = lastIndex % 2 === 0
        ? `${dataset}/claude/projects/fixture/${lastId}.jsonl`
        : `${dataset}/codex/sessions/${lastId}.jsonl`;
      await Deno.remove(lastPath);
      await save(
        "deletion",
        await host!.call("refresh", { stage: "deletion" }),
      );
      await save(
        "toolshed-deletion",
        await toolshed!.call("sample", { stage: "deletion" }),
      );
    }
    await save("interrupt", await host!.call("interrupt"));
    await host!.close();
    host = undefined;
    await toolshed!.close();
    toolshed = undefined;
    sequence++;
    await startToolshed();
    await startHost();
    await readback("recovered");
    await save(
      "toolshed-recovered",
      await toolshed!.call("sample", { stage: "recovered" }),
    );
  }
} catch (error) {
  failures.push(error);
}
for (const process of [reader, host, toolshed]) {
  try {
    if (process === toolshed && toolshed) {
      const state = await toolshed.call("sample", {
        stage: "before-shutdown",
      }) as {
        activeArchiveTransfers: number;
        archiveResources: { pins: number; tickets: number };
      };
      await save("before-shutdown", state);
      if (
        state.activeArchiveTransfers || state.archiveResources.pins ||
        state.archiveResources.tickets
      ) {
        throw new Error("Completed host retained archive resources");
      }
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    await process?.close();
  } catch (error) {
    failures.push(error);
  }
}
safety.check();
if (failures.length) throw new AggregateError(failures, "Benchmark failed");
