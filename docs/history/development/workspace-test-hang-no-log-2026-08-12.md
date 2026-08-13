---
status: historical
created: 2026-08-12
archived: 2026-08-12
reason: "Investigation record: a workspace test shard that hung for its whole job limit and left no log to say what it was running."
---

# The workspace test shard that hung and left no log, August 2026

## Conclusion

The `Test (2/8)` job of
[run 31637210465](https://github.com/commontoolsinc/labs/actions/runs/31637210465),
on the pull request branch for
[PR #5713](https://github.com/commontoolsinc/labs/pull/5713), made no progress
for its entire thirty-minute job limit and was killed. Which package hung, and
which test inside it, could not be established: the job's log does not exist.
The per-job log endpoint answers `BlobNotFound`, and the run's log archive
holds an entry for every other job in that run and none for this one.

The hang was not caused by the pull request. That branch changes one file,
`packages/patterns/integration/cf-code-editor.test.ts`, which belongs to the
`patterns` package and runs in the Pattern Integration Tests jobs. Shard 2 of
8 of the workspace test matrix runs `piece (1/3)`, `tasks (1/3)`,
`cli (6/10)`, `lib-shell`, `content-hash`, `pure-json`, `spec-model` and
`home-schemas`, and the branch touches none of them. The shard composition was
recomputed from `selectShardMembers` against the branch's own manifest and
weights, which are identical to `main`'s.

## What the shard normally does

Forty successful `Test (2/8)` job logs from the preceding day were read for
their `Package timings:` block. Every package's duration is tightly grouped:

| package | fastest | median | slowest |
| --- | --- | --- | --- |
| `tasks (1/3)` | 99.4s | 156.9s | 168.5s |
| `piece (1/3)` | 69.1s | 122.7s | 132.7s |
| `cli (6/10)` | 25.1s | 71.1s | 75.5s |
| `lib-shell` | 5.9s | 10.1s | 13.0s |
| `content-hash` | 4.2s | 7.7s | 9.2s |
| `spec-model` | 1.9s | 3.2s | 3.9s |
| `pure-json` | 1.4s | 2.1s | 3.0s |
| `home-schemas` | 0.0s | 0.0s | 0.0s |

There is no tail: nothing in the shard trends towards half an hour. The
failure is a package that stopped rather than a package that ran long.

## How often this happens

Every unsuccessful job of every CI run created between 2026-07-27 and
2026-08-12 was listed — 6305 jobs across roughly 2100 runs — and each one's
duration compared against its job limit. Thirty-four ran to a limit. Thirty-two
of those belong to two runs on 2026-08-06 in which every job in the run ran
long at once, which is an infrastructure event rather than a hanging test. The
remaining two are isolated, and both fell on 2026-08-12:

- `Pattern Unit Tests (4/5)` on `main`, 00:15Z, run 31547730742.
- `Test (2/8)` on the PR branch, 20:21Z, run 31637210465.

Neither has a log. Both ran for exactly thirty-five minutes: the thirty-minute
limit, plus the five-minute grace period a killed job is given before it is
force terminated.

## Why the log is missing

Four jobs were run on a fork to find out when a killed job keeps its log.

| what the job did | outcome |
| --- | --- |
| hung on a read that never returns, job-level limit | log kept, `if: always()` step ran |
| the same hang, step-level limit | log kept, step failed, job carried on |
| hung with a child that ignores SIGINT and SIGTERM | log kept; the child was killed about 14 seconds after the limit |
| ran the real workspace runner over a fixture package that never finishes | log kept under both limits |

A job killed at its limit therefore keeps its log as a rule, and the last of
those runs shows the log naming the hung package through its unmatched
`Testing ...` line. What separates the two real incidents is the five-minute
tail: their processes did not end when the runner asked them to, the runner had
to be terminated in turn, and the log was discarded with it. Every fork job
above ended within about fifteen seconds of its limit and kept its log.

## What was changed

Two properties of the run were changed in response, in
`tasks/workspace-tests.ts`:

- The run answers SIGINT and SIGTERM instead of dying of them. It names every
  task still running, how long each has been running, and the tail of what each
  has printed. Package output was previously held until the package finished,
  so a package that never finished contributed nothing to the log at all — not
  even the name of the test file it was inside.
- It signals those tasks before it exits, so nothing it started is left behind
  to keep the runner from finishing.

`docs/development/CI_PERFORMANCE.md` describes the resulting behavior under
"Root Test Job Shape".

## What is still unknown

The hang itself. Nothing here identifies which package stopped, which test it
was in, or what it was waiting on, and the two incidents are too rare — two in
roughly 2100 runs, or once per several thousand job runs — to reproduce by
repetition. A local loop of 75 runs of the same shard, and a fixture-driven
search, produced no hang. The evidence needed is what the next occurrence will
print: the report names the task and shows the last 200 lines it produced,
which is the test file and the case it was inside when it stopped.
