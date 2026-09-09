---
status: historical
created: 2026-09-09
archived: 2026-09-09
reason: "Functional validation after the final native agent archive rebase."
---

# Native archive validation after rebasing

All fourteen affected package test tasks passed on the first rebased revision.
The harness task and repository checks passed again after a later console
change. The four-file collection and recovery check passed with complete
authenticated readback. The registered browser view kept archive responses
within 65,536 bytes during fifteen navigation actions. The frozen saved-artifact
visit preserved all three original roots without writing them.

[validation.json](validation.json) records the exact revisions, check results,
log hashes, browser counters, and private evidence manifest hashes. These three
functional checks are separate from the
[nine memory measurements](../memory-2026-09-08/README.md). They ran alongside
package tests and are not a new memory comparison.

## Revisions and incoming changes

The original measurements retain their measured upstream base,
`d6d947cb1d096e8a79c5056cf2b89c556bbb6f81`. The 4,000-session case ran at
`fd667c166e25f4524ec1437daf25a25671eeb295`. The other eight cases ran at
`dda5308f992abf386a6d2688076a2e25b18d3e7a`. Both original report files remain
byte-for-byte unchanged; their hashes are recorded in the JSON.

The first fetch after the measurements added these four commits:

| Commit                                     | Inspected changes                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `60a14c61e574b805a2d6664398e44ec303a52db2` | SQLite tombstone documentation and query guidance in the pattern harness.                                  |
| `7ceac175e9b9aca3eafcaaa2ba3f36a027487712` | SQLite ledger and mailbox patterns, harness injection tests, baselines, and documentation.                 |
| `04e66f818e82b72e79403025439d8da36a5e052a` | A runner test for capability arrival during speculation retirement.                                        |
| `cf94f6651b164e8b5e969b3e246c3c7ed3160f56` | Iterative equality and per-call schema validation and default-merge caches, with tests and specifications. |

All fourteen commits from the previous branch tip,
`52a7f62f255255822bf021bb2be0f5a515917e50`, replayed cleanly on
`cf94f6651b164e8b5e969b3e246c3c7ed3160f56`. The replay ended at
`422a5b5e1b74b0d3e0f95273cdcccf74a005cc00`. `git range-diff` marked every
replayed patch equivalent. Independent reviewers read both directions of the
incoming patches and reconstructed the exact before and after files.

The fourteen package tasks and three functional cases used
`e7ca21a4e936ee3ee00041cdf8a3fa27eff8a32c`. Its additional change lets the
benchmark browser use a separate owner identity. The server continues to use its
generated synthetic identity. When no browser identity is configured, the
browser uses the server identity as before. Nine synthetic identity cases
verified selection and failure behavior without opening the original owner's
key.

## Package and repository checks

Each normal `deno task test` ran with the implementation revision and clean
working tree verified before and after execution. `HEADLESS=1` was set.
`NO_COLOR` was unset for the CLI task's terminal-output expectations.

All fourteen package tasks passed:

- `data-model`, `memory`, and `piece`;
- `connectors/agents/connector`, `connectors/agents/host`, and
  `connectors/agents/debug-view`;
- `runtime-client`, `runner`, and `html`;
- `toolshed`, `cli`, and `cf-harness`;
- `ui` and `patterns`.

Repository formatting checked 5,906 files. Lint checked 5,711 files. Repository
type checks and the focused benchmark type checks passed. Documentation checks
passed for all 596 checked code blocks. The JSON gives each command's log hash
and each package task's elapsed time.

The incoming-change reviewers also ran focused checks for equality, canonical
hash agreement, schema validation, default merging, source compatibility,
injected SQLite handles, both new patterns, and the retirement case. Those
checks supplement the normal package tasks.

## Later console rebase

A subsequent fetch added `e69b3797e73252ba810ddb291a85ef3f0a07415b`. The fifteen
branch commits replayed cleanly onto it, ending at
`f545aab41c45e92ccd42bf7ecdcb610f56f83a10`. All fifteen patches remained
equivalent according to `git range-diff`.

The complete difference from the earlier validation revision contains thirteen
files, all under `packages/cf-harness/console` or its console tests. Those files
make the separate harness console address its assets and API relative to its
mount. Independent review read both patch directions and reconstructed every
before and after file. No native archive, Toolshed, runtime, pattern, dependency
lockfile, or saved-piece shell input changed in this step.

The normal `cf-harness` test task passed again at the new implementation
revision. Repository formatting checked 5,911 files, lint checked 5,712 files,
and type checks passed. Documentation checks again passed all 596 checked
blocks. The declared console build passed in an isolated review of the incoming
files. All five changed console test files passed, covering five tests and 226
steps. The JSON records these later results separately. The three functional
cases and fourteen earlier package results keep their actual execution revision.
Their unchanged inputs did not require another run.

## Four-file collection and recovery

The production host collected four synthetic native JSONL files through the
Claude and Codex drivers. Each file had a 2 MiB generation target. Complete
records brought the actual source total to 8,405,538 bytes. Native reads and
archive pages were limited to 65,536 bytes. The production Codex executable was
used without submitting a model prompt.

| Stage                              | Live records | Fully reconstructed records | Native and transferred bytes | Pages |
| ---------------------------------- | ------------ | --------------------------- | ---------------------------- | ----- |
| Initial collection                 | 4            | 4                           | 8,405,538                    | 132   |
| Recovery after append and deletion | 3            | 3                           | 6,304,209                    | 99    |

The fifteen-stage scenario checked an unchanged scan, an 81-byte append to the
first source, deletion of the last source, an interrupted collection, and
restart recovery. Independent authenticated readers verified the native bytes.
The second reader also verified that the deleted record was absent from the
published catalog. Every owned process exited. Native, scratch, and archive
handles closed. Toolshed retained no archive pins, tickets, or transfers after
shutdown.

## Registered browser view

The browser opened the registered archive from the recovered three-record
catalog. A production shell built at the validation revision supplied seventeen
artifacts totaling 9,322,461 bytes. Every artifact hash was checked before and
after both browser cases. The shell manifest has SHA-256
`51790ecded67173d0e59940283d7d2cb633414ba20b8eda4115e8ea1dddbe31e`. The browser
harness verified the top-level Chrome command's `--headless=new` argument before
opening the saved piece.

The saved piece completed without a bootstrap or piece error. Fifteen actions
visited directories and native pages in two sessions. The catalog retained three
rows. The largest archive HTTP response was 65,536 bytes. Each navigation
snapshot had one pin, zero tickets, and zero active transfers. Closing the view
released the pin.

After activation, every navigation snapshot retained 655 tracked keys, 946
watches, and 10,417,430 cumulative Fabric commit bytes. Stored revision counts
and bytes also remained unchanged throughout navigation. There were no legacy
hydrations, legacy requests, or frozen-root writes.

## Frozen saved artifact

This case used a fresh private database copy prepared from the original frozen
snapshot. The earlier memory case used a copy that had already been activated.
The retained source snapshot was checked read-only: 212,566,016 bytes with
SHA-256 `28ac016e1ba41bc85797b89421ab3d2b796ce4deb27a930c7889ad3c2aa9ac18`. Its
WAL contained zero bytes. The three frozen roots in the private copy matched the
original baseline before the visit.

The browser alone opened the original owner's key. Toolshed used a generated
synthetic identity. No host ran in this case. There were zero synthetic native
sources, so its empty expected-source ledger represents the configured input.

The original saved piece completed without an error. Toolshed recorded four
legacy hydrations and one legacy request. Frozen-root writes remained zero. Each
root's head, stored revision count, stored bytes, and largest revision matched
the original baseline at every recorded stage. The visit created other runtime
records in the private copy; the three frozen roots remained unchanged. All
owned processes exited, and archive resources and file handles closed.

## Scope of the existing 10 GiB result

The 10 GiB case was not repeated. An independent comparison covered all 110
files introduced or changed by the archive work. At the validation revision, 106
matched the previous tip exactly. The four differences were the history index
and the benchmark's identity configuration, browser key selection, and README.

The complete connector source, host source, Memory v2, Toolshed storage routes,
runtime-client source, runner storage, content-hash, data-model-schema, and
utils trees were identical. The dependency lockfile, measured authenticated
reader, archive CFC adapter, and CFC prepare module were also identical.

The incoming equality and schema changes operate on runtime values and bounded
catalog metadata. Raw native bytes still travel through the unchanged chunk
reader, page writer, native extent verification, authenticated transfer, and
readback hashing. The incoming caches are scoped to a call or use existing weak
ownership. Review found no changed native byte representation, retention owner,
page size, or transfer sequence that would require repeating the volume case.
Its numerical results remain attributed to their original measured commit.

## Separate upstream findings

Review reproduced two issues in incoming code. They were filed separately on the
Topics board, with identifiers recorded in the JSON.

- The pattern harness guidance treats arbitrary `GROUP BY` queries as bounded
  without a row limit. An in-memory SQLite query returned 600 groups from 600
  distinct input keys. A second independent query returned 1,001 groups from
  1,001 keys.
- A new harness assertion expects the UTC month, while its pattern uses local
  time. With a fixed clock at 00:30 UTC on March 1 and the `America/Los_Angeles`
  timezone, the real harness assertion failed because the pattern selected
  February and the test expected March.

Neither finding changes a native archive path. They are outside this branch's
archive changes.

## Evidence

The three cases preserve 56 sanitized compressed files containing 2,514,146
decoded bytes. Each file's decoded size and SHA-256 were verified against its
private manifest. The tracked JSON retains manifest hashes, accepted role and
shutdown checks, readback totals, and browser counters. Raw native sources,
browser profiles, database copies, identities, process IDs, and local service
URLs are excluded from the tracked report.
