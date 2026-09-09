---
status: historical
created: 2026-09-08
archived: 2026-09-08
reason: "Implementation review of the agents archive legacy read and migration boundary."
---

# Agents archive legacy boundary review

This review inspected the archive prototype over base commit `0d4dca379a`. Tests
ran in an isolated review worktree. No large memory workload ran. The
implementation was changing during review. The results below describe the
reviewed snapshot, rather than the final branch.

The reviewed `packages/memory/v2/bounded-document.ts` had SHA-256
`540ab120d4fef92d7ee11e1c06673acce6f57b1ce261c53b6744f28b9d900f54`. The reviewed
`packages/runner/src/cfc/archive.ts` had SHA-256
`b10935a8115a8ea0aae7628d4f11c0e259289cebeb7f29bdfe039be1e3698661`.

## Verified findings

- Legacy read status disclosed document state before CFC authorization.
  `server.ts:1804–1809` returned distinct `refused` and `missing` results, while
  a bounded document with forbidden policy returned an authorization error. The
  `LegacyReadRefused` arm had not evaluated the document policy. This was
  established by reading the control flow. The implementer subsequently reported
  replacing these outcomes with the same opaque refusal and adding an
  integration assertion. That fix was not rerun in this review snapshot.
- Legacy policy validation accepted unreadable label maps.
  `runner/src/cfc/archive.ts:15–19` did not validate each entry's path or
  integrity field. The runtime rejected those shapes through
  `prepare.ts:1083–1091,1133–1139`. The review test failed with actual `true`
  against expected `false` for an entry missing its path. The implementer
  subsequently reported extracting and sharing `isWalkableLabelMap` between the
  two callers. That fix was not rerun in this snapshot.
- The bounded reader admitted the symbol codec. `SymbolCodec.ts:94` calls
  `Symbol.for`, introducing process-global state during decoding, before
  document CFC authorization. The review probe observed one such call for a tiny
  stored symbol value. Removing `/Symbol@1` from this legacy format's allowed
  tags avoids that effect. This probe did not measure retained bytes or claim an
  RSS slope.
- Patch paths were not checked against the nesting budget before application.
  `bounded-document.ts:118–122` checked numeric indices, then applied the
  operation and encoded its result before checking depth. A path containing 34
  segments reached patch construction before its result was refused. Rejecting
  excessive parsed pointer depth before application prevents this transient
  violation of the declared depth limit.

The supported patch operations do not include `copy`. I found no mechanism that
repeatedly duplicates a prior subtree without charging incoming values. The 16
KiB aggregate ancestry budget, 64-revision limit, hole accounting, and
post-operation guard prevent a replay from accumulating an arbitrarily large
materialized value. This conclusion comes from inspecting the patch operations
and the guard; it is not a heap measurement or a claim that intermediate values
obey every final-output limit.

## Root retirement

The engine can replace an ordinary `of:` document without loading its prior
value. The test used empty confirmed and pending reads, enabled snapshotting,
and trapped all historical payload readers. One SET and one DELETE over 64 KiB
values succeeded. Snapshotting read the new bounded state. The SET arm in
`engine.ts:5960–5993` writes its incoming document directly.

An active operation field changes this result. The SET guard reads all matching
`op_field_epoch.materialized` rows at `engine.ts:4758–4766` and then reads the
old document at `4769–4774`. The probe observed that old-document read. DELETE
deactivated those fields and succeeded without reading the prior value.

These storage primitives do not establish CFC authorization. Runtime metadata
reads at `prepare.ts:1113` and `metadata.ts:112` name only `cfc`, but the
storage implementation hydrates the containing document before selecting that
path. The bounded legacy reader refuses an oversized containing document.
Therefore neither path supplies bounded old-policy verification for such a
retirement.

A possible implementation needs a bounded policy projection. It can read the
chosen SET or snapshot with the SQLite readonly incremental Blob API, discard
the native value, and retain a bounded CFC envelope. It must account for later
policy-affecting patches and refuse unsupported policy or cross-envelope moves.
Authorization and the final write must use the same document head. Merely
recognizing a root ID or supplying fresh owner policy does not validate the old
policy. This is a design recommendation, not an implemented or tested projector.

## Discovery and startup

The first incomplete native scan is rejected before publication. Its recovery
test passed. Host startup calls synchronization before preparing the debug
target, so a failed first scan does not deploy the new view.

The updated host debug deployment was also inspected directly. Its native
arguments bind `nativeCatalog`, `recentIndexCell`, and `allIndexCell` to the
small catalog at `host/src/debug-view.ts:843–852`. Its preceding and retired
pieces are addressed with shallow schemas. Registry cleanup compares opaque
links. `runner.ts:7163–7227` stops a locally addressed piece without syncing it.
I found no old-index traversal in this fresh host deployment path.

Registry removal does not block an old piece URL. On browser startup,
`shell/src/views/AppView.ts:462–468` loads the piece named by the current URL
and then starts it. `lib-shell/src/runtime.ts:624–644` and
`runtime-client/src/backends/runtime-processor.ts:2219–2224` do not require
registry membership. A restored old debug-view URL can therefore start its
unchanged arguments. A guarantee covering that route requires a bounded
retirement, redirect, or refusal before ordinary piece hydration.

## Reusable evidence

All three review files passed formatting, lint, and type checking.

| Test file                                                        | Snapshot result                                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/memory/test/v2-bounded-document.test.ts`               | Four steps passed.                                                                      |
| `packages/runner/test/cfc/archive.test.ts`                       | Three steps passed.                                                                     |
| `packages/connectors/agents/connector/test/archive.test.ts`      | Four steps passed, including first-partial recovery.                                    |
| `packages/memory/test/agents-legacy-retirement-review.test.ts`   | Two steps passed.                                                                       |
| `packages/runner/test/cfc/agents-legacy-boundary-review.test.ts` | One step failed for the unreadable-policy acceptance described above.                   |
| `packages/memory/test/agents-legacy-decoder-review.test.ts`      | Both steps failed because the guarded operation was invoked once instead of zero times. |

The new proof files are small behavior probes. They do not profile RSS and do
not start an external server. Their deliberate failures describe the reviewed
implementation, so they require the corresponding fixes before joining a green
production test suite.
