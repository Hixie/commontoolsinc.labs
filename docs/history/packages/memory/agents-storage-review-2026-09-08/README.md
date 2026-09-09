---
status: historical
created: 2026-09-08
archived: 2026-09-08
reason: "Executed storage contract and allocation audit preceding the bounded archive implementation."
---

# Agent storage contract and allocation review

The measurements in this snapshot used commit `0d4dca379a` in an isolated
worktree. The controlled cases used private child processes. The earlier remote
case used a separate temporary space in a development toolshed. No server
configuration or platform implementation was changed for the measurements.
All controlled profiling processes exited. Measurements are observations; they
do not establish an RSS plateau for the raw Fabric publisher or the proposed
archive transport. Code line numbers refer to the measured commit.

## Publication, reads, cleanup, and lifetime

- **Verified atomic primitive:** a single-space runtime transaction from
  `runtime.edit()`, with connector identity, `prepareCfc()`, and awaited
  `tx.commit()`. `pushStableCellGraph()` already uses this path
  (`packages/connectors/agents/connector/src/fabric-graph.ts:180`). The runner's
  single-space native commit
  (`packages/runner/src/storage/v2-transaction.ts:2497`) reaches
  `Engine.applyCommit()`. That function runs
  `database.transaction(applyCommitTransaction).immediate(...)`
  (`packages/memory/v2/engine.ts:3616`). A multi-space runtime transaction
  splits into separate commits.
- **Verified reader race:** one combined watch delivered `[1,1]` then `[2,2]`.
  Two independent clients observing the same committed update delivered `[2,1]`
  while one genuine effect frame was held. The protected publication proof
  against Labs20 also observed combined `[2,2]` and separate `[2,1]`. Use one
  stable catalog pointer to one immutable generation manifest. Pin it once for
  the entire reader operation.
- **Verified raw read:**
  `session.queryGraph({roots:[{id,selector:{path:[],schema:false}}]})` hydrates
  only the requested document and creates no watch. A `false` selector returned
  one document where `{}` returned three linked documents, in the local and
  remote proofs. Runner `IStorageProvider.sync()` accepts that selector
  (`packages/runner/src/storage/interface.ts:604`). A permissive schema or
  `readStableCellGraphValue()` can traverse the complete linked graph.
- **Verified historical behavior:** `queryGraph({atSeq, roots: ...})` bypasses
  the query evaluation cache (`packages/memory/v2/server.ts:4817`). An immutable
  page set once remains readable at its earlier sequence after its live value is
  cleared. Arbitrarily old reads of mutable, repeatedly patched documents can
  instead replay a large patch suffix: `reconstructPatchedDocument()` calls
  `selectPatches.all()` (`packages/memory/v2/engine.ts:6818`). Do not use
  historical reads of heavily patched mutable roots as a bounded-page primitive.
- **Verified live cleanup:** native `delete` appends a tombstone. Original
  payloads remain in `revision.data` and `commit.original`. Protected connector
  envelopes reject the high-level whole-envelope delete because it removes
  protected CFC metadata. Protected value cleanup succeeds with
  `cell.asSchema(agentOwnerSchema(owner)).withTx(tx).setRawUntyped(undefined)`,
  followed by connector identity, `prepareCfc()`, and commit. This leaves a
  small envelope and the ordinary historical records.
- **Recommended crash recovery:** keep a durable generation allocation journal.
  Advance it in the same bounded transaction as each page creation. After all
  pages are durable, publish the single catalog pointer. Advance each garbage
  cursor in the same transaction that clears those obsolete live page values.
  Generation-specific page IDs avoid shared-page ownership races. Existing
  history cannot supply a strict physical storage bound; the parent explicitly
  accepted that policy and excluded backend compaction.
- **Verified watch cleanup:** await `session.watchSet([])` before closing a
  batch. It immediately clears server graph/entity retention. `client.close()`
  alone detaches the session, retaining its watched documents during the
  30-second reconnect window (`packages/memory/v2/session-registry.ts:92,245`).
  Raw `queryGraph()` creates neither graph nor entity holdings.
- **Verified runtime retention:** a caller-held storage provider still returns
  its previous document after `Runtime.dispose()`. `SpaceReplica.close()` does
  not clear its document map (`packages/runner/src/storage/v2.ts:3174,4397`).
  `WatchView.close()` likewise leaves entities in a caller-held view
  (`packages/memory/v2/client.ts:1996`). Drop every retained handle. A
  disposable worker or process is the enforceable boundary for an import batch.

## Controlled profiling method

`agents-storage-profile.ts` launches one private child process containing a real
Memory v2 server and a real WebSocket route. Every run uses a new temporary disk
directory. Eight generations are the hard maximum. Each generation writes 16
immutable pages of at most 256 KiB, publishes a small catalog, watches exactly
those pages, reads each page separately at a pinned sequence, reads one first-
generation historical page, clears prior values, empties watches, and closes the
client. The workload is a controlled Memory v2 equivalent of the earlier
protected runtime workload. It omits CFC/runtime and negotiated compression
costs and therefore does not reproduce the entire toolshed process.

All barriers await completed requests, `server.idle()`, watch acknowledgements,
socket close, or process exit. There are no sleeps or timing-based success
conditions. Instrumentation records stage samples, not an unsampled kernel RSS
maximum. The native allocator control and explicit GC are diagnostic actions in
the private child, not proposed production remedies.

The probes record Deno RSS, heapTotal, heapUsed, external, V8 cumulative
allocated bytes, request bytes, logical decoded contents, encoded transaction
originals, SQLite pager/schema/statement memory, original/revision write bytes,
websocket buffered bytes, watch holdings, decoded-document cache bytes, and
pending catch-up acknowledgements. Byte categories can share immutable values.
They must not be added as though they were disjoint physical allocations.

Counter limits are explicit:

- Deno 2.9.4's Node `arrayBuffers` counter returns zero while live buffers and
  external memory are present. It is unavailable for this measurement.
- The SQLite library is compiled with `DEFAULT_MEMSTATUS=0`. Global malloc
  counters return zero and are unavailable. Per-connection pager, schema,
  statement, and pager-overflow counters work. macOS `malloc_zone_statistics`
  supplies native allocated/reserved bytes.
- macOS reports zero for the malloc maximum-touched field in these runs. It is
  not a measured zero peak.
- Private query-evaluation cache contents are not directly counted. Closing
  storage and dropping the server releases the remaining graph/cache owners. A
  precise attribution among those owners would need an additional object census.
  This review does not label the observed residual as a specific leak.

## Results

Both eight-generation cases wrote 33,545,520 raw UTF-8 bytes. All final
generation barriers observed zero request bytes, decoded requests, transaction
original bytes, websocket buffered bytes, watched payload bytes, and pending
catch-up acknowledgements.

| Observation                                 | Default 128 MiB document cache | One-byte document cache |
| ------------------------------------------- | -----------------------------: | ----------------------: |
| Sampled server RSS peak                     |                      638.7 MiB |               598.4 MiB |
| V8 cumulative allocation at generation 8    |                    2,135.1 MiB |             2,259.0 MiB |
| Final document cache weight                 |                      33.31 MiB |          at most 1 byte |
| Final SQLite pager                          |                      62.71 MiB |               62.71 MiB |
| RSS after explicit GC                       |                      512.2 MiB |               442.4 MiB |
| Heap used after explicit GC                 |                      84.55 MiB |               30.76 MiB |
| Heap used after document cache clear and GC |                      30.69 MiB |               30.69 MiB |
| RSS after SQLite shrink and GC              |                      458.2 MiB |               442.4 MiB |
| RSS after storage close and GC              |                      441.7 MiB |               430.1 MiB |
| Heap used after storage close and GC        |                      22.94 MiB |               22.94 MiB |
| External after storage close and GC         |                       1.38 MiB |                1.38 MiB |

The default-cache peak occurred at generation 6 while encoding the transaction
response: RSS 669,728,768 bytes, heap used 254,377,736 bytes, external
38,599,299 bytes, document cache weight 26,198,664 bytes, and SQLite pager
54,424,576 bytes. One input frame of 4,367,135 bytes, logical decoded commit
strings occupying 8,043,346 UTF-16 bytes, and an encoded reply of 4,368,141
UTF-8 bytes were present. The SQLite transaction had completed, so the
instrumented transaction original was no longer on its active stack. Watches
held zero payload bytes.

Largest counted bounded owners across the run:

| Owner                         |                                       Maximum | Observation                                                   |
| ----------------------------- | --------------------------------------------: | ------------------------------------------------------------- |
| Input request wire text       |                         4,367,135 UTF-8 bytes | One 16-page transaction                                       |
| Decoded commit strings        |                        8,043,346 UTF-16 bytes | 4,193,993 logical UTF-8 bytes                                 |
| Encoded transaction original  | 4,366,971 UTF-8 bytes; 8,389,302 UTF-16 bytes | Present alongside input and decoded commit during persistence |
| Encoded reply                 |                         4,368,141 UTF-8 bytes | Commit response includes the page revisions                   |
| Websocket buffered bytes      |                               4,368,351 bytes | One large reply plus small control/effect data                |
| Watched logical contents      |                         4,193,558 UTF-8 bytes | Exactly one generation                                        |
| Decoded-document cache weight |                              34,931,937 bytes | Historical revisions accumulate within the configured cache   |

Adjacent-stage allocation deltas attribute about 605 MiB to reply construction
and encoding, 341 MiB to completion of SQLite transactions, 264 MiB to revision
writes, and 146 MiB to commit-original encoding in the default-cache case. These
are intervals between probes, not exclusive allocator call stacks. They show
that the work allocates many transient copies of a fixed live page batch.

The one-byte-cache native controls give the strongest residual-RSS evidence:
SQLite shrink reduced native malloc bytes in use from 190.3 MiB to 97.3 MiB. RSS
stayed at 442.4 MiB. After storage close, malloc bytes in use were 96.9 MiB and
reserved bytes were 301.6 MiB. `vmmap` reported 57.9 MiB of resident empty
large-allocation regions, 101.0 MiB of resident empty small-allocation regions,
and 140.1 MiB of fragmentation in the default malloc zone. Mapped files occupied
only 160 KiB resident. Native allocator pressure relief reported zero bytes
released. Ending the private process is the complete resource boundary.

## Relation to the 64-generation toolshed observation

The earlier Labs20 proof wrote 268,365,040 raw payload bytes. Sampled toolshed
RSS peaked at 2,515,632,128 bytes and ended cleanup at 1,447,084,032 bytes. Its
document cache reached the configured approximately 128 MiB bound and evicted
old entries. Subsequent read-only `vmmap` observed about 1 GiB footprint, 276.0
MiB resident empty large-allocation regions, 100.3 MiB resident empty
small-allocation regions, and only 26.7 MiB resident mapped files.

The controlled results support transient codec/FFI/transport allocation, bounded
historical document caching, SQLite pager growth, and native allocator retention
as contributors. They do not supply the missing server V8 counters at the
original 2.4 GiB peak. They therefore cannot assign every byte of that peak to a
specific owner or prove that long-run RSS plateaus.

The original space database contains 193 original commits with 280,607,143
payload bytes and 2,115 revision rows with 280,145,586 payload bytes. The
database file was 559,546,368 bytes, plus a 42,039,376-byte WAL. Clearing live
values does not delete those records. Historical payload size on disk is not
equivalent to resident memory.

## Concrete copy sites and archive recommendation

- `encodeMemoryBoundary()` delegates to the Fabric JSON codec
  (`packages/memory/v2.ts:2167`). `JsonEncodeAct` builds the encoded tree and
  uses `JSON.stringify()`
  (`packages/data-model/src/codec-json/JsonEncodeAct.ts:27`).
- Decode parses a complete string and freezes the parsed tree before walking it
  (`packages/data-model/src/codec-json/wire-text.ts:22` and
  `JsonDecodeAct.ts:43`). These operations require the complete frame in memory.
- Engine persistence encodes the entire `commit.original`
  (`packages/memory/v2/engine.ts:5546`) and each revision separately (`:5973`).
  The SQLite driver then `TextEncoder.encode()` copies every bound string
  (`@db/sqlite@0.13.0/src/statement.ts:316`). The probe observes an
  approximately 4.17 MiB external-memory increase when binding the complete
  original.
- `Server` returns the complete applied commit, including revision documents
  (`packages/memory/v2/server.ts:3943`). The measured transaction reply is
  approximately as large as its input.
- Historical cache misses decode complete stored document strings. Patch
  reconstruction decodes the base and patch list and re-encodes the result to
  weigh the cache (`packages/memory/v2/engine.ts:6798,6818,6841`).
- Negotiated compression adds a full UTF-8 source buffer, accumulated compressed
  chunks, a combined buffer, and an envelope. Decode accumulates expanded
  chunks, combines them, then creates a string
  (`packages/memory/v2/message-compression.ts:174,193,238,263`). The controlled
  cases disabled this transport layer; the earlier toolshed case used the
  production remote transport.

The proposed **16 KiB acknowledged transfer frames and 64 KiB immutable pages**
are an appropriate review target. Enforce both as byte limits in the serving
path, including actual streamed bytes. Keep one unacknowledged frame per
transfer and a global limit on concurrent transfers and total in-flight bytes.
Otherwise many individually bounded transfers can still grow memory without a
process bound. Return small acknowledgements containing an offset or digest, not
uploaded bytes. A frame acknowledgement follows the completed private-file
write; sealing follows validation, durability, and atomic publication of the
native generation. Publication of the small Fabric catalog follows sealing.

A WebSocket API assembles a complete frame before application code can reject
its length. That check bounds accepted work but does not bound the receive
allocation for an oversized frame. A bounded HTTP body reader, or a transport
with an enforced incoming-frame limit, is needed for that stronger guarantee.

Stream bytes directly to private files. Do not bind native page bodies into
SQLite, pass them through Fabric codecs, accumulate response chunks, or echo
whole pages in write acknowledgements. Decode at most one 64 KiB page on a
consumer. Bound metadata and diagnostic queues separately. Keep reusable content
hashes, ACL/CFC policy, and catalog metadata in their existing canonical
systems.

Fabric `atSeq` does not snapshot an external archive. The archive must pin a
generation for a reader or explicitly reject an expired generation so the caller
restarts the complete operation. It must not silently substitute pages from the
current generation. A durable staging manifest and a bounded garbage cursor
recover abandoned writes. A server restart must restore access to sealed
generations before advertising the archive capability.

Existing readonly SQLite disk sources are server-local, registered in memory,
capped at 4,096, and lack an unregister API. Their read query materializes
`stmt.values(...).map(...)` (`packages/memory/v2/sqlite/exec.ts:135`). They need
bounded rows and bounded row bytes. Ordinary Fabric SQLite write operations
still preserve their large parameters in `commit.original`. Existing `/blobs`
routes are unauthenticated and store Fabric cell values; the `blob_store`
statements have no active put/get implementation. None of these is already the
required authenticated archive lifecycle.

## Durable evidence and reusable probes

[`measurements.json`](measurements.json) preserves the RSS peak row for each
server stage, the peak row for each measured memory and byte owner, every
completed-generation barrier, and the diagnostic cleanup rows. It also records
SHA-256 checksums and row counts for the original client and server JSONL files.
Rows are selected from the original observations without changing their values.
Byte categories can overlap; the rows are not an additive heap census.

The smallest reusable harness consists of these three opt-in scripts:

- [`agents-storage-profile.ts`](../../../../../packages/memory/test/agents-storage-profile.ts)
  coordinates the bounded workload and awaits observable completion.
- [`agents-storage-profile-server.ts`](../../../../../packages/memory/test/agents-storage-profile-server.ts)
  hosts a private Memory server and observes transport and SQLite stages.
- [`agents-storage-profile-probes.ts`](../../../../../packages/memory/test/agents-storage-profile-probes.ts)
  records V8, native allocator, SQLite, and logical byte counters.

These scripts are not automatic tests. They accept at most eight generations.
Run from `packages/memory`, explicitly selecting the same SQLite shared library
that the child engine loads:

```sh
DENO_SQLITE_PATH=/absolute/path/to/the/matching/sqlite/library deno run --quiet -A --v8-flags=--expose-gc test/agents-storage-profile.ts 8 134217728
```

Use cache budget `1` for the second diagnostic case. The library must match
`@db/sqlite@0.13.0` and the host architecture. The coordinator also accepts its
path as argument three. The original measurements predated this portable path
configuration and used the same fixed cached library in both child and probe.

Adapting the workload to an archive transport must retain its completion
barriers and report active request, response, file, and buffer owners. It must
include acknowledged-but-unconsumed responses. The raw Fabric measurements do
not validate the archive implementation's memory behavior.
