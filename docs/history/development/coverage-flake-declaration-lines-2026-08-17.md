---
status: historical
created: 2026-08-17
archived: 2026-08-17
reason: "Investigation record: the four declaration lines of tasks/ci-check-lib.ts whose coverage moved with the task test shard split."
---

# The four declaration lines that moved with the shard split, August 2026

## Conclusion

Lines 1338, 1339, 1357 and 1358 of `tasks/ci-check-lib.ts` were covered on some
runs of the continuous-integration suite and not on others, with no change to
their source, and the coverage-debt gate failed pull requests that had not
touched them.

The four lines are the declaration lines of two functions:

```text
1338  export async function fetchIssueComments(
1339    issueNumber: number,

1357  export function pullRequestBodyFromEvent(
1358    event: object | undefined,
```

Neither line was reached by anything other than declaring the function, and the
body of each function was reported as covered on the same runs where its
declaration read zero. What decided the declaration was whether the function
declared *before* it in the file had also run in the same coverage profile.

`fetchIssueComments` had no test of its own in `tasks/ci-check-lib.test.ts`; it
was reached only through `postCoverageComment()`, which
`tasks/post-coverage-comment.test.ts` drives. The function before it,
`fetchPRFiles`, and the function after it, `pullRequestBodyFromEvent`, were both
covered by `tasks/ci-check-lib.test.ts`. So the four lines were covered exactly
when those two test files landed in the same shard, and uncovered when they did
not.

## How the shard split decides it

The task tests are split three ways by measured test cost, in
`selectShardedTestFiles()` in `tasks/run-sharded-test-files.ts`, and those slices
are then distributed across the workspace test jobs. Each job sets its own
`DENO_COVERAGE_DIR` and runs `tasks/write-coverage-lcov.ts` over it, so the V8
profiles are merged into line counts once per job. The per-job LCOV reports are
combined later by `tasks/combine-coverage-lcov.ts`, which sums per-line counts.

That ordering is what makes this an all-or-nothing outcome rather than something
the combination step could repair. When both test files are in one job their
profiles merge before the line counts are computed, and the declaration lines
come out covered. When they are in different jobs each job computes zero for
those lines, and summing zero with zero is zero.

At the time of the investigation `tasks/ci-check-lib.test.ts` was in shard 1 of
3 and `tasks/post-coverage-comment.test.ts` in shard 3 of 3. The assignment is
recomputed from `TASK_TEST_WEIGHTS` in `tasks/test-timing-weights.ts`, which is
regenerated from observed timings, so it moves without anyone touching the
tests.

## Why a declaration line depends on its neighbour

`deno coverage` compares V8's coverage ranges, which are offsets in UTF-16 code
units, against character offsets computed from the source. `ci-check-lib.ts`
contains one emoji, in the pull request comment template on line 903, and that
emoji is two code points outside the Basic Multilingual Plane — two UTF-16 code
units each, one character each. Every coverage range after line 903 is therefore
compared two characters to the right of where it belongs.

A function that was never called is reported as a single zero-count range ending
just past its closing brace, which is the last character of that line. Shifted
two characters right, the range's end lands past the start of the next line —
the next function's declaration — and deno's rule that a never-called function's
range covers its own declaration line then zeroes it.

[The live note](../../development/deno-coverage-astral-offset-shift.md) works
through the mechanism and carries a reproduction.

## The fix

`tasks/ci-check-lib.test.ts` gained direct tests for `fetchIssueComments` — one
for its pagination and null-body handling, one for a single short page — and for
`pullRequestBodyFromEvent`. That test file already covered `fetchPRFiles` and
`fetchCurrentPRBody`, so all four consecutive functions are now driven by one
test file, and each declaration line is covered by whichever shard that file
runs in.

Measured on the file alone, with the flags the `tasks` package runs its tests
with, all four lines report a hit:

```text
DA:1338,1
DA:1339,1
DA:1357,1
DA:1358,1
```

Running the three task shards separately and combining their reports, no line of
`tasks/ci-check-lib.ts` is covered only when the shards are merged instead. That
comparison is what confirms the coupling is gone; before the change it named
exactly the four lines.
