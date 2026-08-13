---
status: historical
created: 2026-08-12
archived: 2026-08-12
reason: "Investigation record: the four lines of tasks/ci-check-lib.ts that the coverage gate charged PR #5728 for, and why adding one unrelated test file took them away."
---

# The four declaration lines a documentation pull request was charged for, August 2026

## Conclusion

[PR #5728](https://github.com/commontoolsinc/labs/pull/5728) reorganized the
historical-documentation index. Its Coverage Check job reported the `tasks`
group four lines worse than the `main` baseline and named the lines it could
not attribute to the diff: `tasks/ci-check-lib.ts` 1338, 1339, 1357 and 1358.

Those are parameter lines of two declarations:

```ts
export async function fetchIssueComments(   // 1338
  issueNumber: number,                      // 1339
): Promise<IssueComment[]> {

export function pullRequestBodyFromEvent(   // 1357
  event: object | undefined,                // 1358
): string | undefined {
```

Both functions were being called by the test suite the whole time. What the
pull request changed was which shard called them. It added
`tasks/check-docs-history-index.test.ts`, and the `tasks` tests are packed into
three shards by recorded timings, so one more file re-packed them. That moved
`tasks/post-coverage-comment.test.ts` from shard 2 to shard 3, away from
`tasks/ci-check-lib.test.ts`, and the four lines dropped to zero in every
shard's report.

The fix is two unit tests in `tasks/ci-check-lib.test.ts`, one calling
`fetchIssueComments()` and one calling `pullRequestBodyFromEvent()`. With them,
a single test file credits all four lines, so no packing can separate the
callers again.

## Why a shard boundary could take the lines away

Each shard writes its own LCOV file and `tasks/combine-coverage-lcov.ts` adds
the per-line counts together, so a line survives if any one shard credits it.
These four lines were credited only when two functions ran in the same report.

`deno coverage` projects V8's byte ranges onto source lines, and a range whose
count is zero drops every line it touches to zero. The ranges are collected
against the emitted JavaScript and mapped back through a source map. In this
file that mapping runs an uncalled function's range past its own closing brace
and across the parameter lines of the declaration below it. So line 1338 was
credited only when `fetchPRFiles()` — the function declared above
`fetchIssueComments()` — also ran, and line 1357 only when
`fetchIssueComments()` ran.

The callers sat in different files. `fetchPRFiles()` was called from
`tasks/ci-check-lib.test.ts`; `fetchIssueComments()` had one caller in the
whole repository, `postCoverageComment()`, reached only from
`tasks/post-coverage-comment.test.ts`; `pullRequestBodyFromEvent()` was reached
only through the error path of `fetchCurrentPRBody()` in
`tasks/ci-check-lib.test.ts`.

Nothing in the pull request's own diff could have added an uncovered line to
the `tasks` group. Its only change under `tasks/` was a new file and its test,
both of which the suite covers.

## The measurements

Each test file was run on its own with its own profile directory, and the
`DA:<line>,<hits>` entries for `tasks/ci-check-lib.ts` were read out of
`deno coverage --lcov`.

| what ran | 1338 | 1341 (body) | 1357 | 1360 (body) |
| --- | --- | --- | --- | --- |
| `post-coverage-comment.test.ts` alone | 0 | 10 | 0 | 0 |
| `ci-check-lib.test.ts` alone, before the fix | 0 | 0 | 0 | 1 |
| the whole `tasks` suite in one profile directory | 5 | 10 | 5 | 1 |
| `ci-check-lib.test.ts` alone, after the fix | 1 | 1 | 1 | 6 |

The first two rows are the failure: each file exercises one of the two
functions a line needs, and neither file on its own credits the line. The third
row is what `main` looked like while the two files shared a shard.

A probe pinned the dependency on the neighboring function directly. A test file
that called only `fetchIssueComments()` reported line 1338 as 0 while the body
of that same function reported 1. Adding a `fetchPRFiles()` call to the same
test, and changing nothing else, took line 1338 to 1.

The re-packing was reproduced by running the shard assignment from
`tasks/run-sharded-test-files.ts` over the file list with and without the pull
request's new test file. Without it both files are in shard 2; with it
`post-coverage-comment.test.ts` moves to shard 3.

## What was ruled out

The mapping behavior could not be reduced to a small example. A two-function
module, a three-function module, and a verbatim copy of the three functions
concerned into a standalone module all credited the parameter lines of a called
function whether or not the function above it ran. Whatever decides it lives in
the emitted layout of the whole file, which means a declaration cannot be
judged from the source and has to be measured.

That is why the fix is a test that calls the function rather than a change to
the declaration. Reformatting a signature onto one line would move the
measurement without making the coverage mean anything more.
