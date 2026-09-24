import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import { getBinary } from "@astral/astral";
import { COVERAGE_ARTIFACT } from "@commonfabric/test-support/records";
import { commandWords } from "./ci-workflow.ts";
import { phaseOf } from "./ci-step-phases.ts";
import { BINARY_CACHE_DIR, COMPILE_CACHE_FILE } from "./ci-capabilities.ts";
import {
  FULL_LANE_BOUND_SECONDS,
  FULL_LANES_MAX,
  FULL_RUN_LABEL,
  LANE_BOUND_SECONDS,
  LANES,
} from "./test-selection/policy.ts";

/** The lane numbers a run of `count` lanes has, as the matrix lists them. */
function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

/** What separates a work step's bound from the bound on its job. */
const JOB_HEADROOM_MINUTES = 10;

/**
 * How far the backstop has to clear the largest bound a lane is packed
 * against. A lane that reaches the backstop is one the packer got wrong, and
 * it is carrying the measurements that correct the packer, so there has to be
 * room above the packed bound for such a lane to land. The figure itself is a
 * judgment about how wrong the packer can be; this is the shape that judgment
 * has to keep.
 */
const BACKSTOP_CLEARANCE = 4;

/** A step of a job, as the parsed workflow holds it. */
interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  "timeout-minutes"?: unknown;
  "continue-on-error"?: unknown;
}

/** A job of a workflow, as the parsed workflow holds it. */
interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  "timeout-minutes"?: unknown;
  strategy?: { matrix?: unknown };
  permissions?: Record<string, string>;
  env?: Record<string, unknown>;
  environment?: string;
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: unknown;
  steps?: Step[];
}

/** A workflow file, as `@std/yaml` parses it. */
interface Workflow {
  name?: string;
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: Record<string, unknown>;
  env?: Record<string, unknown>;
  jobs: Record<string, Job>;
}

/** The job with this id, which the workflow has to have. */
function jobOf(workflow: Workflow, jobId: string): Job {
  const job = workflow.jobs[jobId];
  assert(job, `${jobId} job not found`);
  return job;
}

/** The step with this name, which the job has to have. */
function stepOf(job: Job, stepName: string): Step {
  const step = (job.steps ?? []).find((step) => step.name === stepName);
  assert(step, `${stepName} step not found`);
  return step;
}

/** Where in its job the step with this name sits, or -1. */
function stepIndex(job: Job, stepName: string): number {
  return (job.steps ?? []).findIndex((step) => step.name === stepName);
}

/** The jobs a job waits for, written as a list or as one name. */
function needsOf(job: Job): string[] {
  if (job.needs === undefined) return [];
  return typeof job.needs === "string" ? [job.needs] : job.needs;
}

/**
 * Every key and every string value anywhere under a node, so that a check
 * asking whether a workflow names something reads what the parser read and
 * never a comment.
 */
function textsOf(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(textsOf);
  if (node !== null && typeof node === "object") {
    return Object.entries(node).flatMap((
      [key, value],
    ) => [key, ...textsOf(value)]);
  }
  return [];
}

/** Whether anything under a node names `text`. */
function names(node: unknown, text: string): boolean {
  return textsOf(node).some((value) => value.includes(text));
}

/** How many jobs a job's matrix expands to, one for a job with none. */
function expandedJobCount(job: Job): number {
  const matrix = job.strategy?.matrix;
  if (matrix === undefined || typeof matrix !== "object" || matrix === null) {
    return 1;
  }
  const { include, ...dimensions } = matrix as Record<string, unknown>;
  if (Array.isArray(include) && Object.keys(dimensions).length === 0) {
    return include.length;
  }
  return Object.values(dimensions).reduce<number>(
    (count, values) => count * (Array.isArray(values) ? values.length : 1),
    1,
  );
}

/**
 * The bounds the workflow declares, by the name its `env:` block gives them.
 * A bound is written once there, as a YAML anchor, and every job and step
 * holding it aliases the anchor, so the parsed value of every bound is one of
 * these.
 */
function declaredBounds(workflow: Workflow): Map<string, number> {
  return new Map(
    Object.entries(workflow.env ?? {})
      .filter(([name, value]) =>
        name.endsWith("_TIMEOUT_MINUTES") && typeof value === "number"
      )
      .map(([name, value]) => [name, value as number]),
  );
}

const workflowDirectory = new URL("../.github/workflows/", import.meta.url);

async function workflow(name: string): Promise<Workflow> {
  return parseYaml(
    await Deno.readTextFile(new URL(name, workflowDirectory)),
  ) as Workflow;
}

async function workflowNames(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(workflowDirectory)) {
    if (entry.isFile && /\.ya?ml$/.test(entry.name)) names.push(entry.name);
  }
  return names.sort();
}

// Every YAML file under .github, so the composite actions are read alongside
// the workflows that use them.
async function* githubYamlPaths(
  directory: URL = new URL("../.github/", import.meta.url),
): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(directory)) {
    const path = new URL(
      `${entry.name}${entry.isDirectory ? "/" : ""}`,
      directory,
    );
    if (entry.isDirectory) yield* githubYamlPaths(path);
    else if (/\.ya?ml$/.test(entry.name)) yield path;
  }
}

/**
 * The steps a parsed workflow or composite action holds: every job's, or the
 * action's own.
 */
function stepsOf(document: unknown): Step[] {
  const parsed = document as {
    jobs?: Record<string, Job>;
    runs?: { steps?: Step[] };
  };
  return [
    ...Object.values(parsed.jobs ?? {}).flatMap((job) => job.steps ?? []),
    ...(parsed.runs?.steps ?? []),
  ];
}

/** The workflows a `workflow_run` trigger follows, by name. */
function followedWorkflows(workflow: Workflow): string[] {
  const run = workflow.on.workflow_run as { workflows?: string[] } | undefined;
  return run?.workflows ?? [];
}

Deno.test("every workflow and composite action is valid YAML", async () => {
  // A workflow that does not parse produces ZERO jobs on every push. The
  // checks below read the workflows they are about, and this one reads every
  // file under `.github`, the composite actions included, so a file nothing
  // else here opens is held to parsing too. An unquoted `default: ` inside a
  // step name is enough to turn a workflow into a nested mapping the runner
  // refuses.

  const broken: string[] = [];
  for await (const path of githubYamlPaths()) {
    const contents = await Deno.readTextFile(path);
    try {
      parseYaml(contents);
    } catch (error) {
      broken.push(
        `${path.pathname.split("/.github/")[1]}: ${
          String(error).split("\n")[0]
        }`,
      );
    }
  }
  assertEquals(
    broken,
    [],
    "these files under .github do not parse as YAML — the runner will " +
      "schedule NO jobs from them",
  );
});

Deno.test("CI browser tests use the runner's installed Chrome", async () => {
  const configuredPath = (await workflow("deno.yml")).env?.ASTRAL_BIN_PATH as
    | string
    | undefined;
  const cache = await Deno.makeTempDir();
  const savedPath = Deno.env.get("ASTRAL_BIN_PATH");
  const savedCi = Deno.env.get("CI");
  const savedFetch = globalThis.fetch;

  try {
    assertEquals(configuredPath, "/usr/bin/google-chrome");
    Deno.env.set("CI", "1");
    Deno.env.delete("ASTRAL_BIN_PATH");
    if (configuredPath) Deno.env.set("ASTRAL_BIN_PATH", Deno.execPath());
    globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith("known-good-versions-with-downloads.json")) {
        return Promise.resolve(Response.json({
          versions: [{
            version: "125.0.6400.0",
            downloads: {
              chrome: [
                "linux64",
                "mac-arm64",
                "mac-x64",
                "win64",
              ].map((platform) => ({
                platform,
                url: "https://example.invalid/truncated.zip",
              })),
            },
          }],
        }));
      }
      const truncatedArchive = new Uint8Array(22);
      truncatedArchive.set([0x50, 0x4b, 0x03, 0x04]);
      return Promise.resolve(new Response(truncatedArchive));
    };

    assertEquals(
      await getBinary("chrome", { cache }),
      Deno.execPath(),
    );
  } finally {
    globalThis.fetch = savedFetch;
    if (savedPath === undefined) Deno.env.delete("ASTRAL_BIN_PATH");
    else Deno.env.set("ASTRAL_BIN_PATH", savedPath);
    if (savedCi === undefined) Deno.env.delete("CI");
    else Deno.env.set("CI", savedCi);
    await Deno.remove(cache, { recursive: true });
  }
});

Deno.test("a lane keeps what it needs to explain a failure", async () => {
  // `deno lint` has crashed natively here before, and a stack from the dump
  // is what says where. A suite that could not reach the server it asked for
  // leaves the reason in that server's log. Neither survives a lane that
  // cleans up after itself, so the lane keeps its working directory when it
  // fails and the job uploads that directory beside the dump.
  const job = jobOf(await workflow("deno.yml"), "lanes");
  {
    const enable = stepOf(job, "🔧 Enable native crash dumps").run ?? "";
    assertStringIncludes(enable, "ulimit -c unlimited");
    assertStringIncludes(
      enable,
      'sudo sysctl -w kernel.core_pattern="$GITHUB_WORKSPACE/deno-core.%p"',
    );

    const upload = stepOf(job, "📋 Upload what a failing lane left behind");
    assertEquals(upload.if, "${{ failure() }}");
    assert(upload.uses?.startsWith("actions/upload-artifact@"));
    const paths = String(upload.with?.path).trim().split("\n");
    assertEquals(paths, ["deno-core.*", "${{ runner.temp }}/ci-lane-*"]);
    assertEquals(upload.with?.["if-no-files-found"], "ignore");

    assert(
      stepIndex(job, "🔧 Enable native crash dumps") <
        stepIndex(job, "🧪 Run the lane"),
      "the crash pattern must be set before the lane runs",
    );
  }
});

Deno.test("Status fails a pull request that ran no tests", async () => {
  const ci = await workflow("deno.yml");
  const gate = jobOf(ci, "status");

  // The lanes, whichever run they ran — the five selected lanes, or the
  // full run the `ci: full` label asks for — and the store half of the drift
  // guard, which judges the records they shipped.
  assertEquals(needsOf(gate).sort(), ["lanes", "test-topology-store-check"]);
  assertEquals(ci.name, "CI");
  assertEquals(gate.name, "Status");
  assertEquals(
    gate.if,
    "${{ always() && github.event_name == 'pull_request' }}",
  );

  // Two clauses. The first fails on any job that failed or was cancelled.
  // The second is what stops a pull request whose lanes were skipped — a
  // `plan-full` that failed, or an `if:` somebody got wrong — reporting
  // green over no tests at all, which is the one failure of this design
  // that would otherwise be silent.
  const verify = stepOf(gate, "🔎 Verify pull request jobs");
  assertEquals(verify.env?.JOB_RESULTS, "${{ toJSON(needs) }}");
  const script = verify.run ?? "";
  assertStringIncludes(
    script,
    'select(.value.result != "success" and .value.result != "skipped")',
  );
  assertStringIncludes(script, "lanes=$(jq -r '.lanes.result'");
  assertStringIncludes(script, 'if [[ "$lanes" != "success" ]]; then');

  // The gate is scored here because this is the only job that sees every
  // lane's coverage, and it works out which sets it covers for itself.
  assertStringIncludes(
    stepOf(gate, "📊 Run the coverage gate").run ?? "",
    "tasks/coverage-gate.ts",
  );

  // A path filter would leave the required check pending on a pull request
  // that touches none of the listed paths.
  const pullRequest = ci.on.pull_request as Record<string, unknown>;
  assert(pullRequest, "CI does not run on a pull request");
  assertEquals("paths" in pullRequest, false);
});

Deno.test("the first CI wave leaves runner capacity for another run", async () => {
  const ci = await workflow("deno.yml");
  const githubParallelRunnerLimit = 60;
  const firstWaveRunnerCount = Object.values(ci.jobs)
    .filter((job) => needsOf(job).length === 0)
    .reduce((count, job) => count + expandedJobCount(job), 0);

  assert(
    firstWaveRunnerCount < githubParallelRunnerLimit / 2,
    `the dependency-free wave expands to ${firstWaveRunnerCount} jobs; ` +
      `two overlapping runs must fit within GitHub's ` +
      `${githubParallelRunnerLimit}-runner limit`,
  );
});

Deno.test("the full run's lanes leave runner capacity for another run", () => {
  // The full run's matrix is as wide as the lane count `Plan Full Run`
  // prints, which `FULL_LANES_MAX` caps, and it is the widest fan-out in
  // the workflow. Held to the same half as the first wave, so that one
  // push's full run leaves room for the runs beside it.
  const githubParallelRunnerLimit = 60;
  assert(
    FULL_LANES_MAX <= githubParallelRunnerLimit / 2,
    `the full run may take ${FULL_LANES_MAX} lanes; two overlapping runs ` +
      `must fit within GitHub's ${githubParallelRunnerLimit}-runner limit`,
  );
});

Deno.test("every step we name carries a phase marker", async () => {
  // A step whose name starts with no marker in `PHASE_MARKERS` is charted as
  // "other", which is how a job's setup time goes missing from the timings
  // people read when deciding what to make faster. The classifier reads the
  // marker rather than the wording, so the check is the classifier itself.

  const unmarked: string[] = [];
  let steps = 0;
  for await (const path of githubYamlPaths()) {
    const document = parseYaml(await Deno.readTextFile(path));
    for (const step of stepsOf(document)) {
      if (step.name === undefined) continue;
      steps++;
      if (phaseOf(step.name) !== "other") continue;
      unmarked.push(`${path.pathname.split("/.github/")[1]}: ${step.name}`);
    }
  }

  assert(steps > 100, `only ${steps} steps found; the search read nothing`);
  assertEquals(
    unmarked,
    [],
    "these steps start with no marker from docs/development/CI_PERFORMANCE.md",
  );
});

Deno.test("every work step is bounded before its job is", async () => {
  // GitHub ends a job that runs past the job's own `timeout-minutes` by
  // cancelling it, so the job's conclusion is `cancelled` — the same conclusion
  // a run stopped by hand or superseded by a newer push carries, and one that
  // reads as nobody's fault. A step that runs past the step's own bound fails
  // instead, and its job fails with it. Each work step therefore carries a
  // bound of its own, below the bound on the job by the headroom the setup and
  // upload steps around it normally need. Every bound is one the `env:` block
  // declares, so the minutes behind them are written once.

  const headroom = JOB_HEADROOM_MINUTES;
  const ci = await workflow("deno.yml");
  const declared = new Set(declaredBounds(ci).values());
  assert(declared.size > 0, "the workflow declares no bound");
  // The deploy jobs hand the work to a script that lives elsewhere — one on the
  // bastion, one in Cloud Storage — and how long that takes is not this
  // workflow's to say. They carry no bound, so none is asked of them here.
  const unboundedJobs = new Set(["deploy-rapids", "deploy-shell-staging"]);

  for (const [jobId, job] of Object.entries(ci.jobs)) {
    if (unboundedJobs.has(jobId)) continue;
    const jobBound = job["timeout-minutes"];
    assert(
      typeof jobBound === "number" && declared.has(jobBound),
      `${jobId}: timeout-minutes ${jobBound} is not a declared bound`,
    );

    const work = (job.steps ?? []).filter((step) =>
      step.name !== undefined && phaseOf(step.name) === "work"
    );
    // Every job here does work of its own, so an empty list means the steps
    // went unread rather than that this job had none to bound.
    assert(work.length > 0, `${jobId}: no work step found`);

    for (const step of work) {
      const stepBound = step["timeout-minutes"];
      assert(
        typeof stepBound === "number" && declared.has(stepBound),
        `${jobId}: "${step.name}" timeout-minutes ${stepBound} is not a ` +
          `declared bound`,
      );
      assert(
        jobBound - stepBound >= headroom,
        `${jobId}: "${step.name}" is bounded at ${stepBound} minutes within a ` +
          `job bounded at ${jobBound}, leaving under ${headroom} minutes ` +
          `between that step bound and the outer job bound`,
      );
    }
  }
});

Deno.test("Pull Request Comments follows the CI workflow by name", async () => {
  const ci = await workflow("deno.yml");
  const comment = await workflow("pull-request-comments.yml");
  assert(ci.name, "workflow name not found");
  assertEquals(followedWorkflows(comment), [ci.name]);
});

// A workflow_run payload describes the run it names, not the run that
// triggered it, so only a first-level follower of the test workflow can
// read a run's own event, branch and head. A follower of a follower gets
// the default branch and its tip whatever the triggering run was.
Deno.test("the comment job selects runs by the triggering run's own facts", async () => {
  const comment = await workflow("pull-request-comments.yml");
  const conditions = Object.values(comment.jobs).map((job) => job.if ?? "");
  assert(
    conditions.some((condition) =>
      condition.includes("github.event.workflow_run.event == 'push' &&") &&
      condition.includes("github.event.workflow_run.head_branch == 'main' &&")
    ),
    "no job selects a push to main by the triggering run's own facts",
  );
});

// The run report reads the tree of the commit it reports on, so that the
// topology it packs is the pull request's tree as it landed and the diff
// it reads is the change itself. That commit is on the default branch,
// which is what makes it safe to run in a job holding a write token; a
// pull request head in the same job would be running fork-authored code
// with permission to comment as the repository.
Deno.test("the run report checks out the commit it reports on", async () => {
  const comment = await workflow("pull-request-comments.yml");
  const checkout = stepsOf(comment).find((step) =>
    step.uses?.startsWith("actions/checkout@")
  );
  assert(checkout, "the run report checks nothing out");
  assertEquals(checkout.with?.ref, "${{ github.event.workflow_run.head_sha }}");
  assertEquals(checkout.with?.["fetch-depth"], 2);
});

Deno.test("every lane uploads its coverage, and the joiners read it", async () => {
  // A measured set's units are ordinary mandatory items, so the packer
  // spreads them over as many lanes as it likes. What joins them again is
  // the artifact each lane uploads, which is why every lane has to upload
  // one and the jobs that add them up have to name a pattern covering all
  // of them.
  const ci = await workflow("deno.yml");
  const upload = stepOf(
    jobOf(ci, "lanes"),
    "📤 Upload the lane's coverage reports",
  );
  assertEquals(upload.with?.name, "coverage-lane-${{ matrix.lane }}");
  assertEquals(upload.if, "always()");
  assertEquals(upload.with?.path, "coverage/lcov");

  // Every job that adds the reports up: the gate on a pull request, the
  // figures the default branch publishes, and the release report.
  for (const jobId of ["status", "coverage-report", "attest-binaries"]) {
    assert(
      (jobOf(ci, jobId).steps ?? []).some((step) =>
        step.uses?.startsWith("actions/download-artifact@") &&
        step.with?.pattern === "coverage-lane-*"
      ),
      `${jobId} must download the lanes' coverage`,
    );
  }
});

Deno.test("the workflow spells the dials the packer reads", async () => {
  // Three numbers and one string decide which of the two runs a pull
  // request takes and how it divides. They live in
  // `tasks/test-selection/policy.ts`, and the workflow writes them out
  // because a GitHub expression cannot read a TypeScript constant. That
  // is the whole reason this test exists: without it a dial moves and
  // the workflow goes on spelling the old value.
  const ci = await workflow("deno.yml");
  const lanes = jobOf(ci, "lanes");

  // A pull request `plan-full` skipped runs `LANES` lanes, which is what the
  // expressions give where it counted none.
  const count = `\${{ needs.plan-full.outputs.lanes || ${LANES} }}`;
  assertEquals(
    (lanes.strategy?.matrix as { lane?: unknown })?.lane,
    `\${{ fromJSON(needs.plan-full.outputs.matrix || '${
      JSON.stringify(range(LANES))
    }') }}`,
  );
  assertEquals(lanes.name, `Tests (\${{ matrix.lane }}/${count})`);
  const run = stepOf(lanes, "🧪 Run the lane").run ?? "";
  assertStringIncludes(run, `--lane \${{ matrix.lane }} --of ${count}`);

  // The full run is the run `plan-full` counted, and any other run is a pull
  // request measured against its base.
  assertStringIncludes(
    run,
    "${{ needs.plan-full.result == 'success' && '--full' || " +
      "format('--base origin/{0}', github.base_ref) }}",
  );
  assertStringIncludes(
    lanes.if ?? "",
    "(needs.plan-full.result == 'skipped' && " +
      "github.event_name == 'pull_request')",
  );

  // Which of the two a pull request takes, `plan-full` decides, naming the
  // label by the same string the selection tooling does.
  assertStringIncludes(
    jobOf(ci, "plan-full").if ?? "",
    `contains(github.event.pull_request.labels.*.name, '${FULL_RUN_LABEL}')`,
  );

  // A run replays the payload it was created with, so a label reaches
  // the `if:` above only when a label change starts a run of its own.
  const types = (ci.on.pull_request as { types?: string[] }).types ?? [];
  assert(types.includes("labeled"), "a label change starts no run");
  assert(types.includes("unlabeled"), "a label removal starts no run");

  // GitHub's kill is a backstop, not the schedule. A lane is packed
  // against `LANE_BOUND_SECONDS` or `FULL_LANE_BOUND_SECONDS`, and one
  // that runs past the bound it was packed against has been given more
  // than it could carry. That is a failure of the cost model, and what
  // corrects the cost model is the measurements that same lane is
  // carrying: killing it there would throw them away along with every
  // test it had already run, and the next run would be packed just as
  // badly. So the backstop clears the largest packed bound several times
  // over, which leaves such a lane finishing late rather than not at all,
  // and the job bound stays the headroom above the step's.
  const bounds = declaredBounds(ci);
  const work = bounds.get("WORK_TIMEOUT_MINUTES");
  const job = bounds.get("JOB_TIMEOUT_MINUTES");
  assert(work !== undefined, "no work bound declared");
  assert(job !== undefined, "no job bound declared");
  const packed = Math.max(LANE_BOUND_SECONDS, FULL_LANE_BOUND_SECONDS);
  assert(
    work * 60 >= BACKSTOP_CLEARANCE * packed,
    `the work backstop is ${work * 60} seconds against a packed bound of ` +
      `${packed}, which leaves an over-packed lane under ` +
      `${BACKSTOP_CLEARANCE} times that bound before GitHub kills it`,
  );
  assertEquals(
    job - work,
    JOB_HEADROOM_MINUTES,
    "the job backstop is not the headroom above the work backstop",
  );
});

Deno.test("a lane's checkout keeps no credential", async () => {
  // A lane runs whatever the change under test put in the tree, and a
  // checkout that persisted its token leaves it in `.git/config` for any
  // of that to read. Nothing in a lane talks to the remote.
  const lanes = jobOf(await workflow("deno.yml"), "lanes");
  assertEquals(
    stepOf(lanes, "📥 Checkout repository").with?.["persist-credentials"],
    false,
  );
});

Deno.test("a lane keeps binaries and compiled bytes under different keys", async () => {
  // The two want opposite keys. A capability that finds a binary uses it
  // without asking what it was built from, so a binary is keyed exactly on
  // its sources and restored from no prefix, which would hand it one built
  // from other sources. Compiled pattern bytes are filed by the runtime
  // under the compiler fingerprint, so a stale entry is a miss rather than a
  // wrong answer, and seeding from an older entry is what lets a commit reuse
  // what the previous one compiled.
  const lanes = jobOf(await workflow("deno.yml"), "lanes");
  const binaries = stepOf(
    lanes,
    "♻️ Restore the binaries the lane built last time",
  );
  assert(binaries.uses?.startsWith("actions/cache@"));
  assert(
    binaries.with?.["restore-keys"] === undefined,
    "the binary cache must not restore from a prefix",
  );
  assertEquals(binaries.with?.path, BINARY_CACHE_DIR);
  assertEquals(
    binaries.with?.key,
    "ci-lane-binaries-${{ steps.lane-cache-key.outputs.binaries }}",
  );
  stepOf(lanes, "♻️ Restore the pattern bytes the lane compiled last time");
  // The binary key is the digest of what the build reads, which
  // `tasks/build-binaries.test.ts` holds `BINARY_SOURCES` to, rather than a
  // list of globs here that a new kind of input could fall outside.
  assertStringIncludes(
    stepOf(lanes, "🧮 Resolve what the lane's caches are keyed on").run ?? "",
    "tasks/binary-cache-key.ts",
  );

  // Neither key calls `hashFiles()` itself. The cache action evaluates its key
  // again for the post-job save, after the lane has filled the checkout, and a
  // key over the whole workspace would walk all of it a second time; both are
  // resolved in a step before the lane runs. One entry per lane per commit
  // would outgrow the repository's cache, so no key names the lane either.
  for (const step of lanes.steps ?? []) {
    const key = String(step.with?.key ?? "");
    assert(
      !key.includes("hashFiles("),
      "a lane cache key walks the checkout at its post-job save",
    );
    assert(
      !key.includes("matrix.lane"),
      "one cache entry per lane per commit outgrows the cache",
    );
  }
});

Deno.test("every compile byte cache is keyed on the compiler fingerprint", async () => {
  // A compile byte cache holds bytes one compiler emitted, and the runtime
  // stores each of them under `compileCache:<fingerprint>/<identity>`. Keying
  // the CI entry on that same fingerprint is what makes a restored entry usable
  // rather than dead weight, and the compile-cache-key action is where the
  // value comes from. A job that points the compiler at a cache file is the
  // one that needs it. A step that names the file with `CF_COMPILE_CACHE_FILE`
  // points the compiler at it directly; a lane does it through its
  // `compile-cache` capability, at the path `tasks/ci-capabilities.ts` holds,
  // whatever the lane turns out to run.
  const ci = await workflow("deno.yml");
  const fingerprint = "${{ steps.compile-cache-key.outputs.fingerprint }}";
  const resolver = "./.github/actions/compile-cache-key";

  let entries = 0;
  for (const [jobId, job] of Object.entries(ci.jobs)) {
    const steps = job.steps ?? [];
    const resolvedAt = steps.findIndex((step) => step.uses === resolver);
    const files = new Set<string>();
    for (const env of [job.env, ...steps.map((step) => step.env)]) {
      const file = env?.CF_COMPILE_CACHE_FILE;
      if (typeof file === "string") files.add(file);
    }
    for (const step of steps) {
      for (
        const match of (step.run ?? "").matchAll(
          /CF_COMPILE_CACHE_FILE=("[^"]*"|\S+)/g,
        )
      ) {
        files.add(match[1].replace(/^"|"$/g, ""));
      }
    }
    // A job that runs a lane, as opposed to one that only asks how many
    // lanes a run needs.
    if (steps.some((step) => step.run?.includes("--lane ${{ matrix.lane }}"))) {
      files.add(COMPILE_CACHE_FILE);
    }

    if (files.size === 0) {
      assert(
        resolvedAt < 0,
        `${jobId} resolves a fingerprint it keys nothing on`,
      );
      continue;
    }
    assert(
      resolvedAt >= 0,
      `${jobId} uses a compile cache without resolving the fingerprint`,
    );
    for (const file of files) {
      const at = steps.findIndex((step) => step.with?.path === file);
      assert(at >= 0, `${jobId} caches nothing at ${file}`);
      assert(
        at > resolvedAt,
        `${jobId} keys ${file} before resolving the fingerprint`,
      );
      const cache = steps[at].with!;
      assert(typeof cache.key === "string", `${jobId} has no key for ${file}`);
      assertStringIncludes(cache.key, fingerprint);
      for (
        const prefix of String(cache["restore-keys"] ?? "").trim().split("\n")
          .filter((line) => line.length > 0)
      ) {
        assertStringIncludes(prefix, fingerprint);
      }
      entries += 1;
    }
  }
  assert(entries > 0, "no compile byte cache found in deno.yml");
});
Deno.test("Dashboard publishes only from main, never from a pull request", async () => {
  const ci = await workflow("deno.yml");
  const dashboard = await workflow("dashboard-image.yml");

  assertEquals(names(ci, "dashboard-image.yml"), false);
  assertEquals("dashboard" in ci.jobs, false);

  assertEquals(dashboard.name, "Dashboard");
  assertEquals(dashboard.on.workflow_dispatch, {});
  const push = dashboard.on.push as { branches?: string[]; paths?: string[] };
  assertEquals(push.branches, ["main"]);
  assert(push.paths && push.paths.length > 0, "the push is not path-filtered");
  assertEquals("pull_request" in dashboard.on, false);
  assertEquals("workflow_call" in dashboard.on, false);
  assertEquals(dashboard.permissions, { contents: "read" });
  assertEquals(dashboard.concurrency?.group, "dashboard-${{ github.ref }}");
  assertEquals(Object.keys(dashboard.jobs).sort(), ["publish", "tests"]);

  // A manual run can name any ref, so the tests job refuses anything but main
  // before the publish job it gates gets a credential. The guard has to fail
  // the run, not just report: a guard that only warns lets a dispatch from any
  // branch move the `latest` tag.
  const tests = jobOf(dashboard, "tests");
  assertEquals(tests.permissions?.["id-token"], undefined);
  const guard = stepOf(tests, "🔎 Verify the run is on main");
  assertEquals(guard.if, "${{ github.ref != 'refs/heads/main' }}");
  assertStringIncludes(guard.run ?? "", "\nexit 1\n");

  const publish = jobOf(dashboard, "publish");
  assertEquals(needsOf(publish), ["tests"]);
  assertEquals(publish.if, undefined);
  assertEquals(publish.permissions, {
    contents: "read",
    "id-token": "write",
  });

  // Both tags go up in the one push: the immutable commit tag the infra
  // overlay pins, and the `latest` the deployment follows.
  const build = stepOf(publish, "🏗️ Build and push dashboard image").with;
  assertEquals(build?.push, true);
  assertEquals(
    build?.["build-args"],
    "DASHBOARD_GIT_COMMIT=${{ github.sha }}\n",
  );
  assertEquals(
    build?.tags,
    "${{ env.IMAGE }}:${{ github.sha }}\n${{ env.IMAGE }}:latest\n",
  );
});

Deno.test("the Dashboard workflow records no tests", async () => {
  const dashboard = await workflow("dashboard-image.yml");
  const relay = await workflow("test-records-relay.yml");

  // CI runs `packages/dashboard`'s test task on the same commit and records
  // what it runs. Recording the same task again here would file each of those
  // tests twice against one commit, so this workflow takes no part in test
  // records at either end: it spools nothing, and the relay does not follow
  // it. Reinstating either half alone produces a run whose records are
  // gathered and never shipped.
  assertEquals(names(dashboard, "CF_TEST_RECORDS_DIR"), false);
  assertEquals(names(dashboard, "run-recorded"), false);
  assertEquals(names(dashboard, "test-records-ship"), false);
  assert(dashboard.name, "the workflow has no name");
  assertEquals(
    followedWorkflows(relay).includes(dashboard.name),
    false,
    `the relay follows ${dashboard.name}, whose records nothing gathers`,
  );
});

Deno.test("the Coverage Report job records no tests", async () => {
  const job = jobOf(await workflow("deno.yml"), "coverage-report");

  // It reads the coverage artifacts of every lane in this run, so no lane
  // can be asked to run it, and the criterion in `docs/specs/test-records.md`
  // under "Recording" puts it outside test records: no wrapper, and no JUnit
  // file gathered. What its spool holds is the run's coverage measurements,
  // which it ships under the name readers list the store for.
  assert(
    typeof job.env?.CF_TEST_RECORDS_DIR === "string",
    "the job has no spool for its measurements",
  );
  assert(
    !names(job, "run-recorded"),
    "the job wraps its command in run-recorded",
  );
  const ship = stepOf(job, "📤 Ship test records");
  assertEquals(ship.with?.artifact, COVERAGE_ARTIFACT);
  assertEquals(ship.with?.junit, undefined);
  // It runs, and it fails nothing: a landed change that leaves one more
  // line uncovered must not turn the default branch red.
  const publish = stepOf(job, "📊 Publish what the run measured");
  assertStringIncludes(publish.run ?? "", "tasks/coverage-report.ts");
  assertEquals(publish["continue-on-error"], true);
});

Deno.test("the CFC Property Suite workflow records no tests", async () => {
  const suite = await workflow("cfc-properties.yml");
  const relay = await workflow("test-records-relay.yml");

  // Both of the job's steps fall outside what a record is for, and for the
  // two different reasons `docs/specs/test-records.md` gives under
  // "Recording". The suite step runs `deno test` directly, with no
  // `--junit-path` to ingest and no registration preload, so nothing under
  // it records; a wrapper passes recording through to what it runs, so one
  // here would file a line summarizing the invocation and nothing else.
  // Those tests are units of `workspace-unit` and record when CI runs
  // them. The audit step reads the corpus the step before it wrote, so no
  // lane can be asked to run it. The workflow therefore takes no part in
  // test records at either end: it spools nothing, and the relay does not
  // follow it. Spooling again without the relay produces a run whose
  // records are gathered and never shipped, and the relay assertion is
  // what keeps its follow list honest about which workflows record.
  assert(
    !names(suite, "CF_TEST_RECORDS_DIR"),
    "the workflow spools test records",
  );
  assert(
    !names(suite, "run-recorded"),
    "the workflow wraps a command in run-recorded",
  );
  assert(
    !names(suite, "test-records-ship"),
    "the workflow ships test records",
  );
  assert(suite.name, "the workflow has no name");
  assertEquals(
    followedWorkflows(relay).includes(suite.name),
    false,
    `the relay follows ${suite.name}, whose records nothing gathers`,
  );

  // Both checks themselves still run.
  const runs = (jobOf(suite, "cfc-properties").steps ?? []).map((step) =>
    step.run ?? ""
  );
  assert(
    runs.includes(
      "deno test --shuffle=$(deno task -q test-seed) -A test/cfc-properties/",
    ),
    "the suite step does not run the suite",
  );
  assert(
    runs.some((run) => run.includes("deno task cfc-audit ")),
    "no step runs the audit",
  );
});

Deno.test("One commit publishes one set of release artifacts", async () => {
  // A release artifact is named after the commit it was built from, and the
  // deploy hands the bastion a commit rather than a build. So a commit has one
  // tarball and one checksum for that tarball, and they stay as they were
  // published. Two builds of one commit do not produce the same tarball: the
  // binaries are compiled again, and `tar` records modification times. Publish
  // a second build over a first and a reader can come away holding one build's
  // tarball beside the other build's checksum, which is what the deploy's
  // `sha256sum -c` reports as a failure. docs/development/deploying.md covers
  // the invariant.

  const ci = await workflow("deno.yml");

  // Main can receive the same head commit twice, which starts two runs of that
  // commit. Grouping a push by the commit makes the second run wait for the
  // first, so the two builds never publish at once. Grouping it by anything
  // that differs between runs of one commit, `github.run_id` among them, puts
  // them in separate groups and lets them overlap.
  assertEquals(ci.concurrency, {
    group: "${{ github.workflow }}-" +
      "${{ github.event.pull_request.number || github.sha }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });

  // Waiting alone leaves the second run free to publish over the first once the
  // first has finished, so the publish itself is what holds the bytes still: a
  // commit that already has both objects keeps them. The pair is published
  // together, in the one branch, because publishing just one of them is how a
  // commit ends up with two builds' halves.
  const upload = stepOf(
    jobOf(ci, "attest-binaries"),
    "📤 Upload artifacts to Google Cloud Storage",
  ).run ?? "";
  const guard =
    'if gsutil -q stat "$BUCKET/$TARBALL" && gsutil -q stat "$BUCKET/$CHECKSUM"; then';
  const guardStart = upload.indexOf(guard);
  assert(
    guardStart >= 0,
    "the published pair is not looked for before it is published",
  );
  const branchStart = upload.indexOf("\nelse\n", guardStart);
  const branchEnd = upload.indexOf("\nfi\n", branchStart);
  assert(
    branchStart >= 0 && branchEnd > branchStart,
    "publishing branch not found",
  );
  const branch = upload.slice(branchStart, branchEnd);

  for (const object of ["$TARBALL", "$CHECKSUM"]) {
    const copy = `gsutil cp "release/${object}" "$BUCKET/"`;
    assertStringIncludes(branch, copy);
    assertEquals(
      upload.split(copy).length - 1,
      1,
      `${copy} runs somewhere other than the branch that publishes the pair`,
    );
  }
});

Deno.test("Deploy steps call the bastion wrapper the way it accepts", async () => {
  // The bastion's /opt/cf/deploy.sh takes an environment name and a
  // 40-character commit SHA, and nothing else. Hand it a third argument, an
  // environment it does not know, or a revision that is not a full SHA, and it
  // prints its usage and exits 1, failing the deploy job. That script belongs
  // to the infra repository, so nothing else here sees it and the call sites
  // are checked instead. docs/development/deploying.md covers the seam.

  const environments = ["estuary", "rapids"];
  // The revision has to expand to a full SHA, which is a property of what the
  // expression reads rather than of the expression itself. `github.ref_name`
  // would look just as much like a revision here and fail on the bastion, so
  // the expressions whose value is a full SHA are named.
  const revisions = ["${{ github.sha }}", "${{ steps.resolve.outputs.sha }}"];

  const callers: string[] = [];
  for (const name of await workflowNames()) {
    const parsed = await workflow(name);
    const mentions = textsOf(parsed).filter((text) =>
      text.includes("/opt/cf/deploy.sh")
    ).length;
    if (mentions === 0) continue;
    callers.push(name);

    // Invocations are found as the whole `script:` input of a step. Counting
    // every value that mentions the script separately catches a call site
    // written some other way, which would otherwise go unchecked.
    const invocations = stepsOf(parsed)
      .map((step) => step.with?.script)
      .filter((script): script is string =>
        typeof script === "string" && script.startsWith("/opt/cf/deploy.sh")
      );
    assertEquals(
      invocations.length,
      mentions,
      `${name}: every deploy.sh call belongs on a single script: line`,
    );

    for (const invocation of invocations) {
      assert(
        !invocation.trim().includes("\n"),
        `${name}: \`${invocation}\` is more than one line`,
      );
      const args = commandWords(invocation).slice(1);
      assertEquals(args.length, 2, `${name}: wrong arity in \`${invocation}\``);
      assert(
        args[0].startsWith("${{") || environments.includes(args[0]),
        `${name}: unknown environment in \`${invocation}\``,
      );
      assert(
        revisions.includes(args[1]),
        `${name}: \`${args[1]}\` is not known to be a full SHA, in ` +
          `\`${invocation}\``,
      );
    }
  }

  // Every workflow that calls the script is checked, so a new one is covered
  // without being listed. The two that call it today are named to catch the
  // case where the search comes back empty and the loop above does nothing.
  for (const name of ["deno.yml", "deploy-production.yml"]) {
    assert(callers.includes(name), `${name}: no deploy.sh call found`);
  }
});

Deno.test("a configured presence URL reaches every shell bundle CI builds", async () => {
  // Both shells CI builds take their co-presence endpoint from a repository
  // variable, and an unset variable is a supported state that builds a working
  // shell. Every check the wiring performs therefore sits inside an
  // `if [ -n "$PRESENCE_URL" ]` that a repository without the variable never
  // enters, so those checks cannot report on the wiring itself: remove the
  // wiring and the same runs stay green. The properties a configured value
  // depends on are checked here instead, against the workflow itself, where
  // repository configuration does not get to decide whether the check runs.

  const ci = await workflow("deno.yml");
  const exports = (step: Step) =>
    (step.run ?? "").includes('PRESENCE_URL=$PRESENCE_URL" >> "$GITHUB_ENV"');

  // Each job that builds a shell, and the directory its build leaves the
  // bundle in. Both are named so the shell embedded in the toolshed binary and
  // the one published to the bucket are held to a single shape.
  const bundles = new Map([
    ["build-toolshed", "packages/toolshed/shell-frontend/scripts"],
    ["deploy-shell-staging", "dist/scripts"],
  ]);

  // Membership is checked both ways. A job that starts carrying a presence URL
  // without being named above would go unchecked, and a job that stops
  // carrying one is a shell that quietly lost co-presence.
  const carriers = Object.entries(ci.jobs)
    .filter(([, job]) => (job.steps ?? []).some(exports))
    .map(([id]) => id);
  assertEquals(carriers.sort(), [...bundles.keys()].sort());

  for (const [id, bundle] of bundles) {
    const steps = jobOf(ci, id).steps ?? [];

    const exporter = steps.findIndex(exports);
    assert(exporter >= 0, `${id}: no step exports PRESENCE_URL`);

    // Read from `vars`, never `secrets`: the value ships inside a bundle any
    // reader can open, so hiding it would cost review and buy nothing.
    assert(
      String(steps[exporter].env?.PRESENCE_URL).startsWith("${{ vars."),
      `${id}: PRESENCE_URL is not read from a repository variable`,
    );

    // What the bundle carries is `URL.href`, which is not always the spelling
    // the variable holds — a host written without a path gains a trailing
    // slash. Exporting the normalized form is what makes the check below an
    // equality on the value that shipped rather than a prefix match.
    const script = steps[exporter].run ?? "";
    assertStringIncludes(script, "packages/shell/src/lib/presence-url.ts");
    assertStringIncludes(script, "?.href");

    // A configured endpoint that did not reach the bundle is a deployment
    // whose co-presence is off with nothing downstream to notice, so the build
    // is not allowed to pass until the URL is found in what it produced.
    const verifier = steps.findIndex((step) =>
      (step.run ?? "").includes(`grep -rqF -e "$PRESENCE_URL" ${bundle}`)
    );
    assert(
      verifier >= 0,
      `${id}: nothing greps ${bundle} for the presence URL`,
    );
    assert(
      /does not reference \$PRESENCE_URL\."\n\s*exit 1\n/.test(
        steps[verifier].run ?? "",
      ),
      `${id}: a presence URL missing from the bundle does not fail the build`,
    );

    // GITHUB_ENV reaches the steps after the one that writes it, and not that
    // step itself. An exporter placed after the build it configures would
    // export a value no later step reads, and the guarded check above would
    // then skip on an empty variable instead of failing.
    assert(
      exporter < verifier,
      `${id}: PRESENCE_URL is exported after the build that has to read it`,
    );
  }
});

Deno.test("every test-records artifact name is store-safe and unique", async () => {
  // The relay derives each store object's name from the artifact's name
  // through objectNameSlug, which collapses characters unsafe in object
  // names. Two artifacts in one run whose names differ only by collapsed
  // characters would produce one object name, and the second would be
  // mistaken for an idempotent re-ship and silently lost. Holding every
  // literal to the already-safe alphabet makes the slug the identity on
  // these names, so distinct names stay distinct in the store. Uniqueness
  // matters per workflow: object names carry the run id, so two different
  // workflows can reuse a name.

  let shipSteps = 0;
  for (const name of await workflowNames()) {
    const artifacts: string[] = [];
    for (const step of stepsOf(await workflow(name))) {
      if (step.uses !== "./.github/actions/test-records-ship") continue;
      shipSteps++;
      const artifact = step.with?.artifact;
      assert(
        typeof artifact === "string",
        `${name}: a ship step with no artifact input`,
      );
      artifacts.push(artifact.trim());
    }
    for (const artifact of artifacts) {
      const literal = artifact.replaceAll(/\$\{\{[^}]*\}\}/g, "");
      assert(
        /^[A-Za-z0-9._-]*$/.test(literal),
        `${name}: artifact name \`${artifact}\` has characters the store ` +
          "slug would collapse",
      );
    }
    assertEquals(
      new Set(artifacts).size,
      artifacts.length,
      `${name}: duplicate test-records artifact names`,
    );
  }
  // The count pins the search itself: zero found steps would mean the
  // extraction broke, not that the repository stopped shipping records.
  assert(shipSteps > 0, "no ship step found");
});

Deno.test("the lanes ship records and the workflow knows no suite", async () => {
  // The ship step carries neither a variant nor a JUnit specification,
  // which is the last piece of per-suite knowledge to leave this workflow.
  // A lane may hold default and non-default batches at once, so a job-wide
  // variant could not represent it; the lane runner gathers each batch's
  // records as it finishes and applies that suite's own variant there.
  const ci = await workflow("deno.yml");
  const lanes = jobOf(ci, "lanes");
  assert(
    typeof lanes.env?.CF_TEST_RECORDS_DIR === "string",
    "the lanes run tests without a spool directory",
  );
  const ship = stepOf(lanes, "📤 Ship test records");
  assertEquals(ship.if, "always()");
  // The job a record names is the one the lane ran in.
  assertEquals(ship.with?.job, lanes.name);
  for (const input of ["variant", "junit", "shard"]) {
    assert(
      ship.with?.[input] === undefined,
      `the ship step names a ${input}`,
    );
  }
  assert(
    !names(ci, "--junit-path="),
    "deno.yml names a JUnit output; the suite that writes one says where",
  );
});

Deno.test("test-records-ship forwards its optional variant input", async () => {
  const action = await Deno.readTextFile(
    new URL(
      "../.github/actions/test-records-ship/action.yml",
      import.meta.url,
    ),
  );
  assertStringIncludes(action, "  variant:\n");
  assertStringIncludes(action, "SHIP_VARIANT: ${{ inputs.variant }}");
  assertStringIncludes(
    action,
    'RESOLVED_VARIANT="${SHIP_VARIANT:-${CF_TEST_RECORDS_VARIANT:-}}"',
  );
  assertStringIncludes(action, 'args+=(--variant "$RESOLVED_VARIANT")');
});

Deno.test("deno.yml names no test surface", async () => {
  // Adding a test, a kind of test, or a configuration of existing tests is
  // a change to a module under `tasks/test-topology/` and never a change to
  // this workflow. What proves it is that the workflow names none of them:
  // no suite, no shard count, no server-execution arm, no skip list. The
  // topology's own tests hold each of those to what it must be.
  const ci = await workflow("deno.yml");
  for (
    const named of [
      "EXPERIMENTAL_SERVER_EXECUTION",
      "server-execution-on-skips.ts",
      "TEST_SHARD",
      "TEST_DISABLED_PACKAGES",
      "deno task test",
      "deno task integration",
      "deno task cfcheck",
    ]
  ) {
    assert(
      !names(ci, named),
      `deno.yml names ${named}, which belongs to the topology`,
    );
  }

  // The two scripts it does run, and nothing else decides what a lane does.
  assert(names(ci, "tasks/ci-lane.ts"), "deno.yml runs no lane");
  assert(names(ci, "tasks/coverage-gate.ts"), "deno.yml runs no gate");
});

Deno.test("the run in tomorrow's order runs the full lanes and ships nothing", async () => {
  const ci = await workflow("deno.yml");
  const tomorrow = await workflow("test-order-tomorrow.yml");
  const relay = await workflow("test-records-relay.yml");

  // The scheduled workflow works out the next Pacific day's seed and hands it
  // to the CI workflow, which puts it where every test runner reads it.
  assertEquals(tomorrow.on.schedule, [{ cron: "0 11 * * *" }]);
  assert(
    tomorrow.jobs.seed.steps?.some((step) =>
      step.run?.includes("deno task -q test-seed --tomorrow")
    ),
    "no step asks for the next day's seed",
  );
  const call = tomorrow.jobs.ci;
  assertEquals(call.uses, "./.github/workflows/deno.yml");
  assertEquals(call.with, { "shuffle-seed": "${{ needs.seed.outputs.seed }}" });
  assertEquals(ci.env?.CF_TEST_SHUFFLE_SEED, "${{ inputs.shuffle-seed }}");

  // A called run takes its caller's event, which is never a pull request, so
  // the full lanes run and the selected ones do not. Every test the tree
  // holds is then run in tomorrow's order, not the share a change would pick.
  assert(
    ci.jobs["plan-full"].if?.startsWith(
      "github.event_name != 'pull_request' ||",
    ),
    "a called run does not run the full lanes",
  );
  assertStringIncludes(
    ci.jobs.lanes.if ?? "",
    "(needs.plan-full.result == 'skipped' && " +
      "github.event_name == 'pull_request')",
    "a called run runs the selected lanes",
  );

  // GitHub refuses to start the run when a called job asks for a permission
  // the call does not grant, whether or not the job would run. The call grants
  // exactly what the jobs ask for and no more, and hands on no secrets, so the
  // only jobs that name one run for a push alone.
  const asked = new Map<string, string>();
  for (const job of Object.values(ci.jobs)) {
    for (const [scope, level] of Object.entries(job.permissions ?? {})) {
      if (asked.get(scope) !== "write") asked.set(scope, level);
    }
  }
  assertEquals(call.permissions, Object.fromEntries(asked));
  assertEquals(call.secrets, undefined);

  // A called run takes its caller's ref as well, and the scheduled run's ref
  // is main. So a job that holds a deployment environment or a secret runs
  // only for a push to main, and a guard on the branch alone would let the
  // scheduled run attest and deploy. The store half of the drift guard
  // judges the commit, which the commit's own run already does.
  const shipping = Object.entries(ci.jobs)
    .filter(([, job]) =>
      job.environment !== undefined ||
      textsOf(job).some((text) => /secrets\.(?!GITHUB_TOKEN\b)/.test(text))
    )
    .map(([id]) => id);
  assertEquals(shipping.sort(), [
    "attest-binaries",
    "deploy-rapids",
    "deploy-shell-staging",
  ]);
  for (const id of shipping) {
    assertEquals(
      ci.jobs[id].if,
      "github.event_name == 'push' && github.ref == 'refs/heads/main'",
      `${id} can run in a called run`,
    );
  }
  assertEquals(
    ci.jobs["test-topology-store-check"].if,
    "!cancelled() && ((github.event_name == 'pull_request') || " +
      "(github.event_name == 'push' && github.ref_name == 'main'))",
    "the store half of the drift guard can run in a called run",
  );

  // The relay follows a workflow by its own name, and a called run belongs to
  // its caller, so the relay names this workflow as well as the CI workflow
  // for the records of both to ship.
  const followed = followedWorkflows(relay);
  assert(followed.includes(ci.name!), "the relay does not follow CI");
  assert(
    followed.includes(tomorrow.name!),
    "the relay does not follow the run in tomorrow's order",
  );
});

Deno.test("the store half of the drift guard reads every lane's records", async () => {
  const ci = await workflow("deno.yml");
  const job = jobOf(ci, "test-topology-store-check");

  // An identity is claimed by the suite that would run it, so a record
  // artifact this job does not see is a surface it cannot hold the topology
  // to. It therefore waits for every job that ships records — the lanes and
  // nothing else — and downloads them by the prefix the ship step names them
  // under. A job shipping the run's coverage measurements alone ships no
  // test's record, so its artifact holds nothing to hold the topology to.
  const shippers = Object.entries(ci.jobs)
    .filter(([, candidate]) =>
      (candidate.steps ?? []).some((step) =>
        step.uses === "./.github/actions/test-records-ship" &&
        step.with?.artifact !== COVERAGE_ARTIFACT
      )
    )
    .map(([id]) => id);
  assertEquals(shippers, ["lanes"]);
  assertEquals(needsOf(job).sort(), shippers);
  assert(
    (job.steps ?? []).some((step) => step.with?.pattern === "test-records-*"),
    "the job downloads no lane's records",
  );

  // The records are held to the commit the run checked out, and the
  // directory is named rather than the files under it, so the guard is
  // handed the download itself and fails when it holds nothing. The whole
  // command is compared, because a glob appended to the directory
  // contains the directory.
  const command = (job.steps ?? [])
    .map((step) => step.run ?? "")
    .find((run) => run.includes("deno task check-test-topology"));
  assert(command, "the job does not run the topology check");
  assertEquals(
    command.replace(/\s+/g, " ").trim(),
    'deno task check-test-topology --commit "$GITHUB_SHA" ' +
      "--records test-records-artifacts",
  );

  // The guard reads the artifacts of every lane in this run, so no lane can
  // be asked to run it, and `docs/specs/test-records.md` under "Recording"
  // puts it outside test records: no spool directory, no wrapper, no ship
  // step.
  assert(!names(job, "CF_TEST_RECORDS_DIR"), "the job spools test records");
  assert(
    !names(job, "run-recorded"),
    "the job wraps its command in run-recorded",
  );
  assert(!names(job, "test-records-ship"), "the job ships test records");
});
