# CI Performance Policy

This repository tracks GitHub Actions wall time so that work on it is driven
by trend data rather than by one-off slow runs. Use this policy when deciding
whether a run is slow enough to act on, and what to do about it.

## Current Posture

A pull request runs five jobs and a push to `main` runs one lane per share of
the whole corpus, and neither number is written in the workflow. The five come
from `LANES` in `tasks/test-selection/policy.ts`; the push count comes from
`deno run -A tasks/ci-lane.ts --full --lane-count`, which reads the working
tree against the manifest. `docs/development/test-selection.md` is the
operating guide for both.

GitHub's Team plan allows the organization
[60 parallel hosted runners](https://docs.github.com/en/actions/reference/limits#job-concurrency-limits-for-github-hosted-runners).
That capacity is shared by every workflow and repository in the organization,
and the full run is what can fill it. A pull request takes five runners.

`LANE_BOUND_SECONDS` is the bound a pull-request lane is packed against, and
`FULL_LANE_BOUND_SECONDS` the bound a lane of the full run is packed against.
What the packer fills is a budget derived from each: the bound less
`LANE_PROLOGUE_SECONDS`, which is what a lane spends before it runs anything,
and `LANE_SAFETY_SECONDS`, which is what it is left with if every estimate is
wrong. So a lane filled to its budget finishes seventy seconds short of its
bound.

Those two are the numbers to move when a lane runs long, and they are not the
workflow's timeouts. `work-timeout` is a backstop, sized for the lane the cost
model got wrong rather than for the lane it got right. Such a lane carries the
measurements the model learns that mistake from, so stopping it costs the next
run the same mistake as well as costing this one every test it had already run.
A full run packed with no usable cost model finished its healthy lanes in
nineteen to forty-nine minutes, which is what an hour is chosen against: past
that a lane is stuck rather than slow, and waiting longer buys nothing.

Rebalancing is not something anybody does here any more. What a test costs is
measured on every run and published in the manifest, and the packer distributes
items by that cost. A lane that runs long is a cost model that has drifted or a
test that got slower, and both are visible in the lane's own job summary, which
prints what it planned against what it spent.

## Required Pull Request Checks

Configure merge protection to require `Status`. The GitHub web interface shows
that check as `CI / Status`, joining the workflow's name to the job's name, but
merge protection stores and matches the job's name on its own.

`Status` needs `pr-tests` and `full-tests`, and exactly one of them runs: the
five selected lanes, or the full run the `ci: full` label asks for. Its rule has
two clauses. Every dependency is `success` or `skipped`, so the path that did
not run does not fail it. And at least one of the two is `success`, so a pull
request on which both were skipped — mislabelled, or excluded by an `if:`
somebody got wrong — fails rather than reporting green over no tests at all.

A new test surface adds no job and changes nothing here. It is a suite under
`tasks/test-topology/`, and the lanes pick it up.

Keep pull request path filters out of workflows that provide required checks.
GitHub leaves a required check pending when a path filter prevents its workflow
from starting.

Require checks from other GitHub Apps separately. A GitHub Actions job cannot
depend on a check produced by another app.

## Revisit Triggers

Revisit CI wall time when at least one of these holds across normal runs:

- A lane finishes past the budget it was packed against, and its summary shows
  the overrun is the plan rather than one slow test.
- The five pull-request lanes finish at visibly different times, which says the
  cost model behind the packing has drifted.
- A test is named in a lane's summary as unschedulable, meaning it costs more
  than a lane can hold and so runs nowhere on a pull request.
- The full run's lane count climbs without the corpus having grown.

## How To Respond

1. Read the lane's job summary. It prints the manifest it resolved, which
   batches it ran, what each was expected to cost, and what it spent.
2. A projection resting on stand-in costs says so in that summary. Such a lane
   is not evidence about the cost model; it is a lane whose tests the store has
   not measured yet.
3. For one test that got slower, fix the test. For a whole suite that did, look
   at the fitted `suiteOverhead` and `correction` the manifest carries for it.
4. Move a dial only from a measurement. Every dial is in
   `tasks/test-selection/policy.ts`, and `deno task test-selection dials`
   prints each one with the reason to move it.

Splitting or rebalancing a job is not a response any more. The packer decides
what goes where, and `deno task test-selection plan --dry-run` says what it
would decide before anything runs.

## A File That Sweeps Many Cases

The packer places tests, not files: a lane runs the tests it was given with the
rest of their file registered as ignored, so the tests of one file can land in
different lanes. A file that sweeps a pattern list with one `it()` per pattern
is therefore divided across lanes one case at a time, with nothing to write
down beyond the tests themselves. What that asks of the file is what every
test file owes a lane: each case passes on its own, and each is named for
what it covers rather than for its position, so that its measured cost follows
it from run to run.

## Pulling Timing Data

The labs repository is public, so the GitHub Actions REST API returns run, job,
and per-step timings unauthenticated — no `gh` or token needed. Logs and
artifacts do need an admin token, so the per-test timings in the `test-timing-*`
artifacts are not reachable this way; measure those locally.

Jobs and steps for a run:
`GET /repos/commonfabric/labs/actions/runs/<run-id>/jobs?per_page=100` — each
job and step carries `started_at` and `completed_at`.

The team ops dashboard's `/bench?view=ci` page provides repeated-run analysis
for labs and loom. It reports overall workflow duration and individual job
duration. Matrix jobs are grouped using the trailing-parenthesis base names from
`scripts/ci-gantt.ts`, with the slowest shard tracked across runs to expose
persistent imbalance.

For a requested history window, the collector retains every successful main
push build when there are at most 200. Larger sets are sorted chronologically
and reduced to exactly 200 builds spread evenly through that run sequence,
including its oldest and newest builds.

## Step Phase Markers

`scripts/ci-gantt.ts` draws each job as a bar and splits that bar into three
segments — setup, work, and shutdown — so the shared scaffolding around a job is
visually separated from the job's own work. For a matrix job this shows, per
shard, how much wall time is setup that every shard repeats versus the unique
work that one shard does.

When the chart contains one workflow run, it draws every execution of a rerun
job on the same row at its actual time. Each bar carries its own duration
beside it, and its tooltip names the attempt and how that attempt ended. Failed
attempts end in a red cross, and the delay before a retry stays blank. Charts
covering several workflow runs use the latest execution of each job from each
run when calculating their aggregate bars.

The chart decides a step's phase from the emoji its name starts with. The emoji
is the marker: the script never reads step wording, only the leading emoji. Every
step we control — in `.github/workflows/*` and in the composite actions under
`.github/actions/*` — must begin with a marker emoji from the table below, and
each emoji belongs to exactly one phase. When you add a step, pick an emoji whose
phase matches what the step does. When you add a genuinely new kind of step,
choose a new emoji, then add it to both this table and the `PHASE_MARKERS` array
in `tasks/ci-step-phases.ts`, keeping the one-emoji-one-phase rule.

**setup** — fetch code, install tools and dependencies, restore caches,
authenticate, and bring test servers and devices up before the real work:

| Emoji | Used for |
| --- | --- |
| 📥 | checkout, download inputs |
| 🦕 | set up Deno |
| 🔍 | verify the lock file and install, resolve refs |
| 📦 | install packages, cache dependencies |
| ♻️ | restore or save a build cache |
| 🛡️ | relax the sandbox for browser tests |
| 🔧 | enable a device |
| ⚙️ | set up an external SDK |
| 🔑 | authenticate to a cloud |
| 🔌 | start a local server for tests |
| ⏳ | wait for a service to be ready |
| 💾 | restore or save a cache |
| 🗃️ | restore a cached native library |
| 🧮 | compute a cache identity |

**work** — the job's actual purpose:

| Emoji | Used for |
| --- | --- |
| 🔎 | checks (format, type, patterns, attestations) |
| 🚧 | guard that fails the build on a banned pattern |
| 🩹 | check for unresolved merge-conflict markers |
| ✅ | validate an artifact a previous step produced |
| 🧪 | run tests |
| 🧩 | run integration tests |
| 🔁 | replay captured fixtures under today's source |
| 🧹 | lint |
| 🧭 | check skill facts |
| 📄 | type-check docs |
| 🏗️ | build binaries or assets |
| 🏋️ | run benchmarks |
| 📊 | produce performance metrics or status reports |
| 🧬 | combine coverage |
| 📝 | generate attestations |
| 🔐 | sign binaries |
| 🚀 | deploy |
| 💬 | post a pull-request comment |

**shutdown** — post-work reports, artifact uploads, log capture, teardown:

| Emoji | Used for |
| --- | --- |
| 🧾 | write a coverage report |
| 📤 | upload artifacts |
| 📋 | capture logs on failure |

A few markers were chosen so the phase stays unambiguous, which is worth knowing
before you "correct" a step name back to a more obvious emoji:

- 🚀 means deploy, which is work. A step that starts a local server for tests is
  setup, so it uses 🔌 instead of 🚀. A step that uploads artifacts to cloud
  storage is shutdown, so it uses 📤.
- 🔍 means verify-then-install, which is setup. Verifying binary attestations is
  work, so that step uses 🔎.
- Downloading logs after a failure is shutdown, so those steps use 📋 rather than
  the 📥 or 📦 download markers.

The steps the runner injects into every job carry no marker, so the script
classifies them by name. Current jobs use `Set up job`, `Post …`, and `Complete
job`. Retained records can also contain `Set up runner` and `Complete runner`.
The two set-up steps count as setup and the rest as shutdown. Any other step
that reaches the chart without a recognized marker is counted as "other", drawn
in gray, and listed on standard error when the script runs, so a missing marker
is easy to find and fix.

## Cache Keys And Post-Job Saves

The combined `actions/cache` action restores during setup and saves in a
post-job step. GitHub evaluates expressions in the action's inputs again for
that save. A `hashFiles()` call written directly in `with.key` therefore walks
the checkout twice: once before the work and once after it.

When a job writes a large generated tree under the checkout, that second walk
can become much more expensive than the first. The workspace test jobs are the
important case here: raw V8 coverage can contain hundreds of thousands of files
by the time post-job steps run.

Resolve any workspace-wide dependency hash in an ordinary setup step and write
it to `GITHUB_OUTPUT`. Give the cache action that step output as its key. The
post-job save can reevaluate the output reference safely because its value was
fixed before the job populated the workspace. The `deno-setup` composite action
uses this shape for the shared Deno dependency cache.

### The Pattern Compile Cache Key

Both lane jobs in `.github/workflows/deno.yml` restore one pattern compile byte
cache between them, at `COMPILE_CACHE_FILE` in `tasks/ci-capabilities.ts`, which
the `compile-cache` capability points the compiler at for whichever pattern
suites a lane turns out to run. Its key carries the compiler-input fingerprint. The runtime's version axis is
`cf/esm-compile/` followed by that same fingerprint, so a compiled document is
stored under `compileCache:cf/esm-compile/<fingerprint>/<identity>`. A cache
entry CI names by the fingerprint therefore holds bytes the compiler now running
emitted, and an entry from any other compiler is one those jobs never ask for.

The fingerprint is not written into the workflow as a literal. Each lane job
resolves it in a setup step, through the
`./.github/actions/compile-cache-key` composite action,
which runs `tasks/compile-cache-key.ts` and offers the value as its
`fingerprint` output. The cache steps then reference that step's output. This is
the shape the section above prescribes, and it buys two things here. The
post-job save re-evaluates the key without walking the fingerprinted trees a
second time. And the CI key and the runtime version become one value computed
once, rather than two descriptions of one list of inputs that can drift apart.

`COMPILE_FINGERPRINT_INPUTS` in
`packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts` is the list
being hashed, and it is the only place that list is written down. Changing what
shapes the emitted bytes means editing it there; nothing in the workflow
enumerates those inputs, so nothing in the workflow has to be changed to match.
That module's own source is in the list, so changing how the fingerprint is
computed moves it too.

The exact key also carries the pattern sources, so an entry is saved afresh when
they change, and the restore prefix leaves them out, so a commit seeds from the
newest entry its compiler wrote. A stale entry costs nothing but a miss: the
runtime files each compiled document under the fingerprint, so bytes a different
compiler emitted are never asked for. The binaries a lane builds sit in the same
directory and are keyed the other way, exactly and with no prefix, because a
capability uses a binary it finds without asking what it was built from.

What the workflow is held to is where the value comes from. "every compile byte
cache is keyed on the compiler fingerprint" in `tasks/ci-workflow.test.ts` reads
every job that sets `CF_COMPILE_CACHE_FILE` or runs a lane, finds the cache entry
covering that file, and fails when its key or a restore prefix does not carry the action's
output, when the job never resolves it, or when it resolves it after the cache
step — which would leave the key holding an empty segment and collapse entries
from different compilers onto one another. The action fails the job outright if
the script prints nothing, so an empty segment cannot reach a key.

## Step And Job Timeouts

Every work step in `.github/workflows/deno.yml` carries its own
`timeout-minutes`, and the `timeout-minutes` on the job around it is at least ten
minutes larger. The two bounds do different things when they are reached.
GitHub ends a job that runs past the bound on the job by cancelling it, so the
job's conclusion is `cancelled` — the conclusion that a run stopped by hand or
superseded by a newer push also carries, and one that reads as nobody's fault. A
step that runs past the bound on the step fails, and its job fails with it. The
headroom between the bounds is what the setup and upload steps around the work
normally need. An individual wedged step can therefore reach its step bound and
report a failure before the outer job bound. The outer bound remains the final
limit when several steps in one job consume unusual amounts of time.

The runner enforces the step bound, so the bound holds only while the runner is
still responding. A job whose runner stops responding runs to the bound on the
job, is cancelled, and keeps no log at all. Running out of memory is one way to
get there. The runner raises the out-of-memory score of every process a step
starts, so that when memory runs out the kernel kills one of those rather than
the runner. Swap puts that kill off until the swap file is full as well, and
while it fills, the machine pages to disk and everything on it slows, the runner
included. So the `deno-setup` composite action turns swap off in every job that
uses it on a GitHub-hosted Linux runner. A job that runs out of memory there
loses a test process and fails in a step that keeps its log. The cost is the
memory the swap file added: a job that needs more than the machine has fails
rather than passing slowly. A self-hosted machine is not reconfigured, because
it outlives the job.

The minutes are written once. The top of the workflow declares them as YAML
anchors, which GitHub Actions has accepted since September 2025:

```yaml
env:
  WORK_TIMEOUT_MINUTES: &work-timeout 50
  JOB_TIMEOUT_MINUTES: &job-timeout 60
```

Every job then reads `timeout-minutes: *job-timeout` and every work step
`timeout-minutes: *work-timeout`. Changing either bound is one edit. The
environment variables are how a workflow declares a value an anchor can name;
nothing reads them, and merge keys (`<<:`) remain unsupported, so an anchor
cannot carry a block that a job then overrides.

What the step bound buys is which way a wedged job ends: a job stopped at its
own bound is `cancelled`, the same conclusion a run somebody stopped by hand
carries, where a step stopped at its own bound fails and names itself.

The lanes carry that same pair rather than one of their own. A lane is packed
against a budget of a few minutes, so nothing that finishes reaches this bound
at all. A job needing its own bound adds a pair of anchors alongside these
rather than a number next to the step.

The deploy jobs carry no bound at all. A deploy hands the work to a script that
lives outside this repository, and a bound here would cancel a deploy this
workflow has no way to size. `tasks/ci-workflow.test.ts` names those jobs and
asks nothing of them.

For every other job, that test fails when a work step has no
bound, when a job has none, when a bound is written as anything but an alias to
an anchor, when fewer than ten minutes separate the step's anchor from its
job's, or when `work-timeout` drops to within a lane's packed bound of that
bound.

## The Lane Shape

Both lane jobs run the same script and differ in two values: whether selection
is on, and which lane of how many this one is.

    deno run -A tasks/ci-lane.ts --lane 3 --of 5 --base origin/main
    deno run -A tasks/ci-lane.ts --full --lane 1 --of 58

Their steps are fixed and do not vary with what the lane runs: check out at
full depth, set up Deno, install, restore `.ci-cache`, set the kernel core
pattern, run the lane, upload what a failing lane left behind, upload the
coverage reports, ship test records. Everything conditional happens inside the
lane runner, which is what makes the workflow independent of the topology.

The binary cache step covers one directory under one exact key. A capability
that finds a binary under `.ci-cache` uses it without asking what it was built
from, so the key names everything a binary is built from and carries no
restore-key prefix. `tasks/binary-cache-key.ts` computes it from
`BINARY_SOURCES` in `tasks/build-binaries.ts` and from what each cached build
is given, and that module's tests hold the list to every path the build names
and every module the binaries embed. Every lane shares the key: an entry holds
whichever lane's binaries were saved first, and a lane wanting another builds
it, which is what a miss costs anyway.

A lane that failed keeps its own working directory, under the job's temporary
directory, and the upload step carries it out. A server's log is written there,
and a lane that failed is when somebody wants to read one. A lane that passed
removes it.

The root `deno task test` is `tasks/test.ts`, which is what somebody runs
locally. It reads the workspace list from `deno.jsonc` and runs `deno task
test` in every member, using half the available cores for package workers —
two on a four-core machine. `TEST_CONCURRENCY` overrides that for a diagnostic
run. When a package fails it prints that package's captured output immediately
and stops starting new package tests. CI does not run it: a lane invokes each
member's test task directly, one file at a time where the member's task is a
single `deno test` or runs the group runner, `tasks/run-test-groups.ts`.

### Tests That Cannot Run Beside Another

Deno runs each parallel test file on its own thread of a single process, so
"process-wide state" means state every file shares: environment variables,
replaced globals, and the current directory. A test that only configures a CLI
it spawns shares nothing — `cf` in `packages/cli/test/utils.ts` takes the
command's environment as an argument and gives it nothing else, so those tests
stay in the parallel group.

Among the serial CLI tests, and why each is serial:

- `test/completion-output.serial.test.ts`,
  `test/completion-providers.serial.test.ts`, `test/fuse.serial.test.ts`,
  `test/inspect-remote.serial.test.ts`, `test/log-level.serial.test.ts`,
  `test/main-command.serial.test.ts`,
  `test/test-runner-compile-byte-cache.serial.test.ts`,
  `test/test-runner-pattern-coverage.serial.test.ts`, and
  `test/wish-command.serial.test.ts` set an environment variable that the test
  process itself then reads, so another file setting the same name would
  decide what they read.
- Every `test/view-commitmsg-*.serial.test.ts` file is serial because some
  tests in the family install Git shims by changing process environment.
- `test/json-command.serial.test.ts` and
  `test/runtime-creation.serial.test.ts` replace globals — the console methods
  and runtime prototype methods.
- `test/view-mod-gate.serial.test.ts` changes into a removed directory to test
  the missing-current-directory fallback.
- `test/view-pager-pty.serial.test.ts` drives a real pseudo-terminal, spawning
  a full CLI child per test. Keystrokes are gated on observed child output
  rather than on timing, so contention slows it but does not flake it; it is
  serial to avoid stacking those children on top of the parallel files.

A serial CLI test file is named `*.serial.test.ts`. The package's `deno-test`
task passes `tasks/run-test-groups.ts` a `--serial` option naming that
pattern, so the runner runs those files after the rest, in a `deno test`
without `--parallel`, and runs the rest of the package's test modules with
`--parallel`. A lane that selects some of the CLI's files splits them the same
way.
