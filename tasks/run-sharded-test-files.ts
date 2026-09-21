#!/usr/bin/env -S deno run --allow-env --allow-read --allow-run

import { parseShard, type Shard } from "./shard-utils.ts";
import { testFilesUnder } from "./test-topology/deno-task.ts";
import {
  AGENTS_HOST_TEST_WEIGHTS,
  PIECE_TEST_WEIGHTS,
  TASK_TEST_WEIGHTS,
} from "./test-timing-weights.ts";
import { assignWeightedShards } from "./weighted-shards.ts";

const PROFILES = {
  "agents-host": { weights: AGENTS_HOST_TEST_WEIGHTS, defaultWeight: 0.4 },
  piece: { weights: PIECE_TEST_WEIGHTS, defaultWeight: 0.2 },
  tasks: { weights: TASK_TEST_WEIGHTS, defaultWeight: 0.2 },
} as const;

type ProfileName = keyof typeof PROFILES;

/**
 * Lists test modules below `root` using stable slash-separated paths.
 *
 * The walk is the topology's, so that the files this runner hands to
 * `deno test` and the units the topology enumerates for the same member
 * are one set. A rule of its own here would run tests no lane could be
 * asked for, and would do it silently.
 */
export async function collectTestFiles(root: string): Promise<string[]> {
  return (await testFilesUnder(root))
    .map((file) => file.replaceAll("\\", "/").replace(/^\.\//, ""))
    .sort();
}

/** Selects the files assigned to one weighted shard. */
export function selectShardedTestFiles(
  files: string[],
  shard: Shard | undefined,
  weights: Readonly<Record<string, number>>,
  defaultWeight: number,
): string[] {
  if (!shard) return [...files].sort();
  if (shard.total > files.length) {
    throw new Error(
      `Shard count ${shard.total} exceeds test file count ${files.length}.`,
    );
  }
  const assignments = assignWeightedShards(
    files.map((name) => ({
      name,
      weight: weights[name] ?? defaultWeight,
    })),
    shard.total,
  );
  return files.filter((name) => assignments.get(name) === shard.index).sort();
}

async function main(): Promise<void> {
  const [envName, profileRaw, root, separator, ...testFlags] = Deno.args;
  if (!envName || !(profileRaw in PROFILES) || !root || separator !== "--") {
    throw new Error(
      "Usage: run-sharded-test-files.ts ENV PROFILE ROOT -- TEST_FLAGS...",
    );
  }
  const profileName = profileRaw as ProfileName;
  const profile = PROFILES[profileName];
  const shardRaw = Deno.env.get(envName);
  const shard = shardRaw ? parseShard(shardRaw) : undefined;
  const files = selectShardedTestFiles(
    await collectTestFiles(root),
    shard,
    profile.weights,
    profile.defaultWeight,
  );
  if (files.length === 0) {
    throw new Error(
      `No test files selected${shardRaw ? ` for ${shardRaw}` : ""}.`,
    );
  }

  const label = shardRaw ? ` shard ${shardRaw}` : "";
  console.log(`Running ${profileName} test${label} files:`);
  for (const file of files) console.log(`  ${file}`);
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["test", ...testFlags, ...files],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!result.success) Deno.exit(result.code);
}

if (import.meta.main) await main();
