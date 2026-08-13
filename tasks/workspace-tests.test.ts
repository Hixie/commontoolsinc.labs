import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { decode } from "@commonfabric/utils/encoding";
import {
  assertTaskTestsIncluded,
  formatInterruptReport,
  initializeDb,
  parseDisabledPackageList,
  readWorkspaceMembers,
  runTests,
  selectShardMembers,
  stopTasks,
  testConcurrency,
  testPackage,
} from "./workspace-tests.ts";
import { WORKSPACE_TEST_WEIGHTS } from "./test-timing-weights.ts";

const WORKSPACE_SHARDS = 8;
const CLI_SHARDS = 10;

const runnerEntryPoint = fromFileUrl(new URL("./test.ts", import.meta.url));
const workspaceConfig = fromFileUrl(new URL("../deno.jsonc", import.meta.url));
const workspaceLock = fromFileUrl(new URL("../deno.lock", import.meta.url));

// Write a minimal workspace under `dir`: a root deno.jsonc listing the
// members, and one directory per package whose `test` task records that it
// ran by writing a marker file into the package directory.
async function makeWorkspace(
  dir: string,
  packageNames: string[],
  rootTasks: Record<string, string> = {},
): Promise<void> {
  await Deno.writeTextFile(
    `${dir}/deno.jsonc`,
    JSON.stringify({
      workspace: packageNames.map((name) => `./packages/${name}`),
      tasks: rootTasks,
    }),
  );
  for (const name of packageNames) {
    await Deno.mkdir(`${dir}/packages/${name}`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/packages/${name}/deno.jsonc`,
      JSON.stringify({ tasks: { test: "echo ok > ran.txt" } }),
    );
  }
}

async function ranPackages(
  dir: string,
  packageNames: string[],
): Promise<string[]> {
  const ran: string[] = [];
  for (const name of packageNames) {
    try {
      await Deno.stat(`${dir}/packages/${name}/ran.txt`);
      ran.push(name);
    } catch {
      // no marker: the package's test task did not run
    }
  }
  return ran;
}

Deno.test("parseDisabledPackageList parses comma and whitespace separated names", () => {
  assertEquals(parseDisabledPackageList("runner, ui\nshell\tcli"), [
    "runner",
    "ui",
    "shell",
    "cli",
  ]);
});

Deno.test("parseDisabledPackageList ignores empty entries", () => {
  assertEquals(parseDisabledPackageList(" runner, ,ui "), ["runner", "ui"]);
  assertEquals(parseDisabledPackageList(undefined), []);
});

function unitNames(units: { packageName: string }[]): string[] {
  return units.map((unit) => unit.packageName);
}

Deno.test("selectShardMembers returns every enabled member without a shard", () => {
  assertEquals(
    selectShardMembers(
      ["./packages/b", "./packages/a", "./tasks"],
      ["a"],
      undefined,
    ),
    [
      { memberPath: "./packages/b", packageName: "b" },
      { memberPath: "./tasks", packageName: "tasks" },
    ],
  );
});

Deno.test("selectShardMembers balances enabled members by weight", () => {
  const members = [
    "./packages/d",
    "./packages/b",
    "./packages/a",
    "./packages/c",
    "./packages/e",
  ];
  assertEquals(
    unitNames(selectShardMembers(members, [], { index: 1, total: 2 })),
    ["a", "c", "e"],
  );
  assertEquals(
    unitNames(selectShardMembers(members, [], { index: 2, total: 2 })),
    ["b", "d"],
  );
});

Deno.test("selectShardMembers excludes disabled members before assigning shards", () => {
  const members = ["./packages/a", "./packages/b", "./packages/c"];
  assertEquals(
    unitNames(selectShardMembers(members, ["a"], { index: 1, total: 2 })),
    ["b"],
  );
  assertEquals(
    unitNames(selectShardMembers(members, ["a"], { index: 2, total: 2 })),
    ["c"],
  );
});

Deno.test("selectShardMembers expands the cli package into internal shards when sharded", () => {
  const members = ["./packages/a", "./packages/cli", "./packages/z"];

  // Without a workspace shard, cli stays a single unit with no shard env.
  assertEquals(selectShardMembers(members, [], undefined), [
    { memberPath: "./packages/a", packageName: "a" },
    { memberPath: "./packages/cli", packageName: "cli" },
    { memberPath: "./packages/z", packageName: "z" },
  ]);

  const selections = Array.from(
    { length: WORKSPACE_SHARDS },
    (_, offset) =>
      selectShardMembers(members, [], {
        index: offset + 1,
        total: WORKSPACE_SHARDS,
      }),
  );
  const units = selections.flat();
  const cliUnits = units.filter((unit) => unit.packageName.startsWith("cli "))
    .toSorted((a, b) => {
      const slice = (name: string) => Number(name.match(/\((\d+)\//)?.[1]);
      return slice(a.packageName) - slice(b.packageName);
    });
  assertEquals(
    cliUnits,
    Array.from({ length: CLI_SHARDS }, (_, offset) => ({
      memberPath: "./packages/cli",
      packageName: `cli (${offset + 1}/${CLI_SHARDS})`,
      env: { CLI_TEST_SHARD: `${offset + 1}/${CLI_SHARDS}` },
    })),
  );
  assertEquals(unitNames(units).filter((name) => name === "a"), ["a"]);
  assertEquals(unitNames(units).filter((name) => name === "z"), ["z"]);
});

Deno.test("selectShardMembers expands piece and tasks into internal shards", () => {
  const members = ["./packages/piece", "./tasks"];
  const units = Array.from(
    { length: 3 },
    (_, offset) =>
      selectShardMembers(members, [], { index: offset + 1, total: 3 }),
  ).flat();

  assertEquals(
    unitNames(units).sort(),
    [
      "piece (1/3)",
      "piece (2/3)",
      "piece (3/3)",
      "tasks (1/3)",
      "tasks (2/3)",
      "tasks (3/3)",
    ],
  );
});

Deno.test("real workspace timing weights limit two-worker makespans", async () => {
  const expectedCliUnits = Array.from(
    { length: CLI_SHARDS },
    (_, offset) => `cli (${offset + 1}/${CLI_SHARDS})`,
  );
  const profiledCliUnits = Object.keys(WORKSPACE_TEST_WEIGHTS)
    .filter((name) => name.startsWith("cli ("))
    .toSorted((a, b) => {
      const slice = (name: string) => Number(name.match(/\((\d+)\//)?.[1]);
      return slice(a) - slice(b);
    });
  assertEquals(profiledCliUnits, expectedCliUnits);

  const members = await readWorkspaceMembers(
    new URL("../deno.jsonc", import.meta.url),
  );
  const makespans = Array.from(
    { length: WORKSPACE_SHARDS },
    (_, offset) => {
      const workerLoads = [0, 0];
      const units = selectShardMembers(members, ["runner"], {
        index: offset + 1,
        total: WORKSPACE_SHARDS,
      });
      for (const unit of units) {
        const worker = workerLoads[0] <= workerLoads[1] ? 0 : 1;
        workerLoads[worker] += WORKSPACE_TEST_WEIGHTS[unit.packageName] ?? 1;
      }
      return Math.max(...workerLoads);
    },
  );

  assertEquals(
    Math.max(...makespans) < 80,
    true,
    `modeled workspace two-worker makespans: ${makespans.join(", ")}`,
  );
});

Deno.test("readWorkspaceMembers reads the workspace list from a JSONC manifest", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-members-" });
  try {
    const configPath = `${dir}/deno.jsonc`;
    // Comments must not break parsing — that is the whole point of the JSONC
    // parser here.
    await Deno.writeTextFile(
      configPath,
      `{
  // workspace packages
  "workspace": ["./packages/a", "./packages/b"]
}
`,
    );
    assertEquals(await readWorkspaceMembers(configPath), [
      "./packages/a",
      "./packages/b",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertTaskTestsIncluded requires tasks in the root workspace", () => {
  assertTaskTestsIncluded(["./packages/api", "./tasks"]);
  assertThrows(
    () => assertTaskTestsIncluded(["./packages/api"]),
    Error,
    "workspace must include tasks",
  );
});

// Run `fn` with TEST_CONCURRENCY set or cleared, then restore the caller's
// value. This keeps each test independent of the ambient environment.
async function withTestConcurrency<T>(
  value: string | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = Deno.env.get("TEST_CONCURRENCY");
  if (value === undefined) {
    Deno.env.delete("TEST_CONCURRENCY");
  } else {
    Deno.env.set("TEST_CONCURRENCY", value);
  }
  try {
    return await fn();
  } finally {
    if (saved === undefined) {
      Deno.env.delete("TEST_CONCURRENCY");
    } else {
      Deno.env.set("TEST_CONCURRENCY", saved);
    }
  }
}

Deno.test("testConcurrency parses the override and defaults to half the cores", async () => {
  assertEquals(testConcurrency("3"), 3);
  await withTestConcurrency(undefined, () => {
    assertEquals(
      testConcurrency(),
      Math.max(2, Math.floor(navigator.hardwareConcurrency / 2)),
    );
  });
  let threw = false;
  try {
    testConcurrency("zero");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("runTests drains every package with a concurrency limit of one", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-serialpool-" });
  try {
    await makeWorkspace(dir, ["a", "b", "c"]);
    await withTestConcurrency("1", async () => {
      const passed = await runTests([], undefined, dir);
      assertEquals(passed, true);
    });
    assertEquals(await ranPackages(dir, ["a", "b", "c"]), ["a", "b", "c"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTests reports a failure and stops scheduling packages", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-fail-fast-" });
  try {
    await makeWorkspace(dir, ["a", "b", "c"]);
    await Deno.writeTextFile(
      `${dir}/packages/a/deno.jsonc`,
      JSON.stringify({
        tasks: {
          test:
            "echo started > ran.txt && echo upstream package download failed >&2 && exit 1",
        },
      }),
    );

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => {
      errors.push(values.map(String).join(" "));
    };
    let passed: boolean;
    try {
      passed = await withTestConcurrency(
        "1",
        () => runTests([], undefined, dir),
      );
    } finally {
      console.error = originalError;
    }

    assertEquals(passed, false);
    assertEquals(await ranPackages(dir, ["a", "b", "c"]), ["a"]);
    const downloadErrorIndex = errors.findIndex((message) =>
      message.includes("upstream package download failed")
    );
    const summaryIndex = errors.indexOf("One or more tests failed.");
    assertEquals(downloadErrorIndex >= 0, true);
    assertEquals(summaryIndex >= 0, true);
    assertEquals(downloadErrorIndex < summaryIndex, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTests runs every enabled package's test task", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-run-" });
  try {
    await makeWorkspace(dir, ["a", "b", "c"]);
    const passed = await runTests(["b"], undefined, dir);
    assertEquals(passed, true);
    assertEquals(await ranPackages(dir, ["a", "b", "c"]), ["a", "c"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTests runs only the selected shard's packages", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-shard-" });
  try {
    await makeWorkspace(dir, ["a", "b", "c", "d"]);
    const passed = await runTests([], { index: 2, total: 2 }, dir);
    assertEquals(passed, true);
    assertEquals(await ranPackages(dir, ["a", "b", "c", "d"]), ["b", "d"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTests passes internal shard environment to expanded packages", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-clishard-" });
  try {
    await makeWorkspace(dir, ["a", "cli", "z"]);
    await Deno.writeTextFile(
      `${dir}/packages/cli/deno.jsonc`,
      JSON.stringify({
        tasks: { test: "echo shard=$CLI_TEST_SHARD > ran.txt" },
      }),
    );
    const shard = { index: 1, total: WORKSPACE_SHARDS };
    const expected = selectShardMembers(
      ["./packages/a", "./packages/cli", "./packages/z"],
      [],
      shard,
    ).find((unit) => unit.packageName.startsWith("cli "));
    const passed = await runTests([], shard, dir);
    assertEquals(passed, true);
    const ran = await Deno.readTextFile(`${dir}/packages/cli/ran.txt`);
    assertEquals(ran.trim(), `shard=${expected?.env?.CLI_TEST_SHARD}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("testPackage reports a failure when the package directory cannot be spawned in", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-nodir-" });
  try {
    const outcome = await testPackage(
      "./packages/missing",
      "missing",
      `${dir}/packages/missing`,
      undefined,
    );
    assertEquals(outcome.result.success, false);
    assertEquals(outcome.packageName, "missing");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("initializeDb runs the initialize-db task in the given directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-initdb-" });
  try {
    await makeWorkspace(dir, [], {
      "initialize-db": "echo ok > initialized.txt",
    });
    await initializeDb(dir);
    await Deno.stat(`${dir}/initialized.txt`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("formatInterruptReport shows how far each running task got", () => {
  const report = formatInterruptReport("SIGTERM", [
    {
      name: "piece (1/3)",
      elapsedMs: 1_800_000,
      output: "running 3 tests from ./test/link-reactivity.test.ts\n",
    },
    { name: "cli (6/10)", elapsedMs: 65_000, output: "" },
  ]);

  assertEquals(report.split("\n"), [
    "Interrupted by SIGTERM. These tasks were still running:",
    "- piece (1/3), 1800s in:",
    "    running 3 tests from ./test/link-reactivity.test.ts",
    "- cli (6/10), 65s in: nothing printed yet",
  ]);
});

Deno.test("formatInterruptReport keeps the tail of a long output, and says how much it left", () => {
  const output = Array.from({ length: 203 }, (_, line) => `line ${line + 1}`);
  const report = formatInterruptReport("SIGINT", [
    { name: "cli (6/10)", elapsedMs: 1000, output: output.join("\n") },
  ]).split("\n");

  assertEquals(report[1], "- cli (6/10), 1s in:");
  assertEquals(report[2], "    (3 earlier lines not shown)");
  assertEquals(report[3], "    line 4");
  assertEquals(report.at(-1), "    line 203");
});

Deno.test("formatInterruptReport says so when nothing was running", () => {
  assertEquals(
    formatInterruptReport("SIGINT", []),
    "Interrupted by SIGINT. No task was running.",
  );
});

Deno.test("stopTasks signals the tasks that are left, ending or not", () => {
  const signalled: string[] = [];
  stopTasks([
    {
      child: {
        kill: () => {
          throw new TypeError("Child process has already terminated");
        },
      },
    },
    { child: { kill: (signal?: Deno.Signal) => signalled.push(signal!) } },
  ], "SIGTERM");

  assertEquals(signalled, ["SIGTERM"]);
});

// Write a workspace whose `slow` package announces that its tests are really
// under way — by connecting to `readyPort` — and then never finishes. The
// connection lives as long as that package's process does, so a reader of it
// learns when the process is gone.
async function makeHangingWorkspace(
  dir: string,
  readyPort: number,
): Promise<void> {
  await makeWorkspace(dir, ["tasks", "slow"], { "initialize-db": "echo ok" });
  await Deno.writeTextFile(
    `${dir}/packages/slow/deno.jsonc`,
    JSON.stringify({ tasks: { test: "deno run --allow-net hang.ts" } }),
  );
  await Deno.writeTextFile(
    `${dir}/packages/slow/hang.ts`,
    [
      `console.log("the slow package is midway through its tests");`,
      `await Deno.connect({ hostname: "127.0.0.1", port: ${readyPort} });`,
      "await new Promise(() => {});",
      "",
    ].join("\n"),
  );
}

// A package's output is held until that package finishes, so a package that
// never finishes has shown nothing. CI kills a job that outruns its limit and
// the kill arrives as a signal, which is the last moment the run has to say
// which package it was waiting on — and the log is all that survives the kill.
Deno.test("an interrupted run names the package it was waiting on", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-interrupt-" });
  const ready = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  let slowPackage: Deno.Conn | undefined;
  try {
    await makeHangingWorkspace(dir, (ready.addr as Deno.NetAddr).port);
    const run = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "--allow-run",
        // The lockfile the workspace already has, resolution frozen against
        // it, so this run cannot resolve the dependency graph afresh or write
        // a new lockfile over the one it borrowed.
        "--config",
        workspaceConfig,
        "--lock",
        workspaceLock,
        "--frozen",
        runnerEntryPoint,
      ],
      cwd: dir,
      // The run under test reads these, and this process has whatever the job
      // running it set. Empty values leave it with the whole fixture
      // workspace to run and its coverage where its own packages put theirs.
      env: {
        TEST_SHARD: "",
        TEST_DISABLED_PACKAGES: "",
        TEST_CONCURRENCY: "",
        DENO_COVERAGE_DIR: "",
      },
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    // Whichever comes first: the slow package's test task announcing that it
    // is really running, or the run ending without ever starting it. The
    // second is a broken fixture, and saying so beats waiting on an
    // announcement that is never coming.
    const announced = ready.accept();
    const ended = run.status;
    const announcedFirst = await Promise.race([
      announced.then(() => true),
      ended.then(() => false),
    ]);
    if (!announcedFirst) {
      announced.catch(() => {}); // the listener closes below
      const { code, stderr } = await run.output();
      throw new Error(
        `the run ended before the slow package started, with code ${code}:\n${
          decode(stderr)
        }`,
      );
    }
    slowPackage = await announced;

    run.kill("SIGINT");
    const { code, signal, stderr } = await run.output();
    const report = decode(stderr);

    assertStringIncludes(report, "Interrupted by SIGINT");
    assertStringIncludes(report, "- slow, ");
    // Handled rather than died of: a run killed by the signal reports the
    // signal here and never reaches its own reporting.
    assertEquals(signal, null);
    assertEquals(code, 130);

    // The run takes its packages with it, so nothing it started is left
    // behind. This read ends when that package's process does.
    assertEquals(await slowPackage.read(new Uint8Array(1)), null);
  } finally {
    slowPackage?.close();
    ready.close();
    await Deno.remove(dir, { recursive: true });
  }
});
