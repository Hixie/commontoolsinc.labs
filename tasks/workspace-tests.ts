// Implementation of the root `deno task test` runner. The entry point is
// tasks/test.ts; the logic lives here because `deno coverage` skips files
// whose names end in test.ts, and the coverage-debt metric scores an
// unmeasured file as fully uncovered.
import * as path from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { decode, encode } from "@commonfabric/utils/encoding";
import { parseShard, type Shard } from "./shard-utils.ts";
import { WORKSPACE_TEST_WEIGHTS } from "./test-timing-weights.ts";
import { assignWeightedShards } from "./weighted-shards.ts";

export const ALL_DISABLED: string[] = [];

export function getPackageName(memberPath: string): string {
  const relativePath = memberPath.replace(/^\.\//, "");
  return relativePath.replace(/^packages\//, "");
}

export function parseDisabledPackageList(raw: string | undefined): string[] {
  return (raw ?? "").split(/[,\s]+/).filter((name) => name.length > 0);
}

export async function initializeDb(cwd: string = Deno.cwd()): Promise<void> {
  console.log("Initializing database dependencies...");
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["task", "initialize-db"],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!result.success) {
    console.error("Failed to initialize database dependencies.");
    console.log(decode(result.stdout));
    console.error(decode(result.stderr));
    Deno.exit(result.code);
  }
}

// One package's test task while it is running, together with everything it has
// printed so far. A finished package's output reaches the log through
// `reportPackageFailure`; this is what a package that has not finished can
// still be asked about.
interface RunningTestTask {
  packageName: string;
  startedAt: number;
  child: Deno.ChildProcess;
  stdout: Uint8Array[];
  stderr: Uint8Array[];
}

const runningTestTasks = new Set<RunningTestTask>();

/** How far one package's test task has got. */
export interface RunningPackage {
  packageName: string;
  elapsedMs: number;
  output: string;
}

function joinChunks(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

async function collectStream(
  stream: ReadableStream<Uint8Array>,
  chunks: Uint8Array[],
): Promise<void> {
  for await (const chunk of stream) chunks.push(chunk);
}

/** The packages whose test tasks are running right now, and their progress. */
export function runningPackages(): RunningPackage[] {
  const now = Date.now();
  return [...runningTestTasks].map((task) => ({
    packageName: task.packageName,
    elapsedMs: now - task.startedAt,
    output: decode(joinChunks(task.stdout)) + decode(joinChunks(task.stderr)),
  }));
}

/**
 * Signal every one of `tasks` that is still running. A task whose process
 * ended between the caller reading the list and this call is left alone: it is
 * the run's own bookkeeping that is a step behind, and the process is gone
 * either way.
 */
export function stopTestTasks(
  tasks: Iterable<{ child: Pick<Deno.ChildProcess, "kill"> }>,
  signal: Deno.Signal,
): void {
  for (const task of tasks) {
    try {
      task.child.kill(signal);
    } catch {
      // the task's process is already gone
    }
  }
}

/** The message an interrupted run leaves behind, addressed to a log reader. */
export function formatInterruptReport(
  signal: string,
  running: RunningPackage[],
): string {
  if (running.length === 0) {
    return `Interrupted by ${signal}. No package test task was running.`;
  }
  const lines = [
    `Interrupted by ${signal}. These package test tasks were still running:`,
  ];
  for (const { packageName, elapsedMs, output } of running) {
    const elapsed = `${Math.round(elapsedMs / 1000)}s in`;
    if (output.length === 0) {
      lines.push(`- ${packageName}, ${elapsed}: nothing printed yet`);
      continue;
    }
    lines.push(`- ${packageName}, ${elapsed}:`);
    for (const line of output.replace(/\n$/, "").split("\n")) {
      lines.push(`    ${line}`);
    }
  }
  return lines.join("\n");
}

export async function testPackage(
  memberPath: string,
  packageName: string,
  packagePath: string,
  coverageRoot: string | undefined,
  extraEnv?: Record<string, string>,
): Promise<{
  memberPath: string;
  packageName: string;
  packagePath: string;
  durationMs: number;
  result: Deno.CommandOutput;
}> {
  const startedAt = Date.now();
  let result: Deno.CommandOutput;
  try {
    const env: Record<string, string> = { ENV: "test", ...extraEnv };
    if (coverageRoot) {
      env.DENO_COVERAGE_DIR = path.join(
        coverageRoot,
        packageName.replaceAll("/", "__"),
      );
    }

    const child = new Deno.Command(Deno.execPath(), {
      args: ["task", "test"],
      cwd: packagePath,
      env,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    // Read both streams as they arrive rather than taking the whole output at
    // the end, so the text is in hand while the task is still running.
    const task: RunningTestTask = {
      packageName,
      startedAt,
      child,
      stdout: [],
      stderr: [],
    };
    runningTestTasks.add(task);
    try {
      const [status] = await Promise.all([
        child.status,
        collectStream(child.stdout, task.stdout),
        collectStream(child.stderr, task.stderr),
      ]);
      result = {
        success: status.success,
        code: status.code,
        signal: status.signal,
        stdout: joinChunks(task.stdout),
        stderr: joinChunks(task.stderr),
      };
    } finally {
      runningTestTasks.delete(task);
    }
  } catch (e) {
    result = {
      success: false,
      stdout: new Uint8Array(),
      stderr: encode(`${e}`),
      code: 1,
      signal: null,
    };
  }

  const durationMs = Date.now() - startedAt;
  const duration = (durationMs / 1000).toFixed(1);
  const status = result.success ? "ok" : "failed";
  console.log(`Finished ${packageName} in ${duration}s (${status})`);

  return {
    memberPath,
    packageName,
    packagePath,
    durationMs,
    result,
  };
}

type PackageResult = Awaited<ReturnType<typeof testPackage>>;

function reportPackageFailure(result: PackageResult): void {
  console.error(`Failed ${result.packageName} (${result.packagePath})`);
  console.log(decode(result.result.stdout));
  console.error(decode(result.result.stderr));
}

// Read the workspace member list from the root manifest. Parsed with the JSONC
// parser so a `deno.jsonc` carrying comments is read correctly.
export async function readWorkspaceMembers(
  configPath: string | URL = "./deno.jsonc",
): Promise<string[]> {
  const manifest = parseJsonc(await Deno.readTextFile(configPath)) as {
    workspace: string[];
  };
  return manifest.workspace;
}

export function assertTaskTestsIncluded(members: string[]): void {
  if (members.some((memberPath) => getPackageName(memberPath) === "tasks")) {
    return;
  }
  throw new Error(
    "The root workspace must include tasks so the workspace test job runs the task tests.",
  );
}

// One `deno task test` invocation: a workspace member, plus environment
// variables when the member is one slice of an internally sharded package.
export interface TestUnit {
  memberPath: string;
  packageName: string;
  env?: Record<string, string>;
}

// Packages whose test runner supports internal sharding via an environment
// variable. When the workspace run itself is sharded, such a package is
// expanded into `total` weighted units so one heavy package can run across
// several workspace shards. Without a workspace shard (local runs), the
// package runs as a single unit and the variable stays unset.
const INTERNALLY_SHARDED_PACKAGES: Record<
  string,
  { total: number; envVar: string }
> = {
  // packages/cli/test/run-tests.ts reads CLI_TEST_SHARD.
  cli: { total: 10, envVar: "CLI_TEST_SHARD" },
  piece: { total: 3, envVar: "PIECE_TEST_SHARD" },
  tasks: { total: 3, envVar: "TASK_TEST_SHARD" },
};

// Enabled workspace members are split by observed test cost. Without a shard,
// every enabled member is selected as a single unit.
export function selectShardMembers(
  members: string[],
  disabledPackages: string[],
  shard: Shard | undefined,
): TestUnit[] {
  const enabled = members.filter(
    (memberPath) => !disabledPackages.includes(getPackageName(memberPath)),
  );
  if (!shard) {
    return enabled.map((memberPath) => ({
      memberPath,
      packageName: getPackageName(memberPath),
    }));
  }

  const units: TestUnit[] = [];
  for (const memberPath of enabled) {
    const packageName = getPackageName(memberPath);
    const split = INTERNALLY_SHARDED_PACKAGES[packageName];
    if (!split) {
      units.push({ memberPath, packageName });
      continue;
    }
    for (let slice = 1; slice <= split.total; slice++) {
      units.push({
        memberPath,
        packageName: `${packageName} (${slice}/${split.total})`,
        env: { [split.envVar]: `${slice}/${split.total}` },
      });
    }
  }

  const assignments = assignWeightedShards(
    units.map((unit) => ({
      name: unit.packageName,
      weight: WORKSPACE_TEST_WEIGHTS[unit.packageName] ?? 1,
      group: unit.memberPath,
    })),
    shard.total,
  );
  return units
    .filter((unit) => assignments.get(unit.packageName) === shard.index)
    .sort((a, b) =>
      (WORKSPACE_TEST_WEIGHTS[b.packageName] ?? 1) -
        (WORKSPACE_TEST_WEIGHTS[a.packageName] ?? 1) ||
      a.packageName.localeCompare(b.packageName)
    );
}

// Cap on concurrently running package test tasks. Individual packages may also
// parallelize their tests. Half the cores limits that nested concurrency while
// allowing independent packages to overlap. TEST_CONCURRENCY overrides it.
export function testConcurrency(
  raw = Deno.env.get("TEST_CONCURRENCY"),
): number {
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(
        `Invalid TEST_CONCURRENCY "${raw}"; expected a positive integer.`,
      );
    }
    return parsed;
  }
  return Math.max(2, Math.floor(navigator.hardwareConcurrency / 2));
}

export async function runTests(
  disabledPackages: string[],
  shard?: Shard,
  workspaceCwd: string = Deno.cwd(),
): Promise<boolean> {
  const suiteStartedAt = Date.now();
  const units = selectShardMembers(
    await readWorkspaceMembers(path.join(workspaceCwd, "deno.jsonc")),
    disabledPackages,
    shard,
  );
  if (units.length === 0) {
    console.error("No workspace packages selected to test.");
    return false;
  }
  // Resolve to an absolute path: each package's test subprocess runs with its
  // own cwd, so a relative DENO_COVERAGE_DIR would land under
  // packages/<pkg>/... instead of the shared workspace coverage directory.
  const coverageRootRaw = Deno.env.get("DENO_COVERAGE_DIR");
  const coverageRoot = coverageRootRaw
    ? path.resolve(workspaceCwd, coverageRootRaw)
    : undefined;

  const results: PackageResult[] = [];
  let nextUnit = 0;
  let failureSeen = false;
  const workerCount = Math.min(testConcurrency(), units.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failureSeen && nextUnit < units.length) {
      const unit = units[nextUnit++];
      console.log(`Testing ${unit.packageName}...`);
      const packagePath = path.resolve(workspaceCwd, unit.memberPath);
      const result = await testPackage(
        unit.memberPath,
        unit.packageName,
        packagePath,
        coverageRoot,
        unit.env,
      );
      results.push(result);
      if (!result.result.success) {
        failureSeen = true;
        reportPackageFailure(result);
      }
    }
  });
  await Promise.all(workers);
  const durationResults = [...results].sort((a, b) =>
    b.durationMs - a.durationMs
  );
  const failedPackages = results.filter((result) => !result.result.success);

  console.log("Package timings:");
  for (const result of durationResults) {
    const duration = (result.durationMs / 1000).toFixed(1);
    const status = result.result.success ? "ok" : "failed";
    console.log(`- ${result.packageName}: ${duration}s (${status})`);
  }
  console.log(
    `Total wall time: ${((Date.now() - suiteStartedAt) / 1000).toFixed(1)}s`,
  );

  if (failedPackages.length === 0) {
    console.log("All tests passing!");
  } else {
    console.error("One or more tests failed.");
    console.error("Failed packages:");
    for (const result of failedPackages) {
      console.error(`- ${result.packageName} (${result.packagePath})`);
    }
  }

  return failedPackages.length === 0;
}

// The signals a kill arrives as, each with the exit code a process killed that
// way conventionally reports: 128 plus the signal's number. Windows has no
// SIGTERM to listen for.
const INTERRUPT_SIGNALS: [Deno.Signal, number][] = Deno.build.os === "windows"
  ? [["SIGINT", 130]]
  : [["SIGINT", 130], ["SIGTERM", 143]];

// CI kills a job that outruns its limit, and the kill arrives here as a
// signal. Say which packages the run was waiting on and how far each of them
// got, then take those packages down: a process the run started that outlives
// it holds the job's output open, and the job log — the only record that
// survives the kill — is discarded when the runner has to be killed in turn.
function reportOnInterrupt(): void {
  for (const [signal, exitCode] of INTERRUPT_SIGNALS) {
    Deno.addSignalListener(signal, () => {
      console.error(formatInterruptReport(signal, runningPackages()));
      stopTestTasks(runningTestTasks, signal);
      Deno.exit(exitCode);
    });
  }
}

export async function main(): Promise<void> {
  reportOnInterrupt();
  const shardRaw = Deno.env.get("TEST_SHARD");
  const shard = shardRaw ? parseShard(shardRaw) : undefined;
  assertTaskTestsIncluded(await readWorkspaceMembers());
  await initializeDb();
  const passed = await runTests(
    [
      ...ALL_DISABLED,
      ...parseDisabledPackageList(Deno.env.get("TEST_DISABLED_PACKAGES")),
    ],
    shard,
  );
  if (!passed) Deno.exit(1);
}
