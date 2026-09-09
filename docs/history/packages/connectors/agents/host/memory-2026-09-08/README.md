---
status: historical
created: 2026-09-08
archived: 2026-09-08
reason: "Measured native agent archive collection, readback, and browser behavior."
---

# Native agent host memory measurements

After the initial native collections, the host retained 137.24 to 140.21 MiB of
JavaScript heap after garbage collection. The authenticated readers retained
33.85 to 35.23 MiB. The Fabric catalog occupied 924 bytes in the two-session
cases and 933 bytes in the session-count cases. The tables below give the source
sizes, elapsed times, transient allocations, disk use, and readback scope for
each case.

## Revision and scope

The upstream base was `d6d947cb1d096e8a79c5056cf2b89c556bbb6f81`. The
4,000-session run used `fd667c166e25f4524ec1437daf25a25671eeb295`. Every other
final case used `dda5308f992abf386a6d2688076a2e25b18d3e7a`. The latter commit
changes only browser measurement failure handling. The archive, host, provider,
and runtime production code is identical between these revisions. Each run
verified its exact commit and clean working tree before and after execution.

The
[benchmark programs](../../../../../../../packages/connectors/agents/connector/bench/README.md)
run the production host, native Claude and Codex drivers, Toolshed, and an
authenticated reader in separate processes. The native collection cases use
private synthetic provider homes and generated identities. The source files
contain valid native JSON records with large escaped strings. File-size labels
are generation targets: the generator writes complete fixed blocks, so the
actual byte counts in the tables can exceed those targets.

The 9,000-session case runs the complete lifecycle. The other native collection
cases run initial collection and readback. Two additional cases visit the
registered archive view and an existing saved artifact in a real headless
browser. The shell build used the exact final commit. All 17 build artifact
hashes were verified before and after each visit. Its private build manifest has
SHA-256 `5409585a597371f7bd9589d517f957c9e63e1ce2e057c9817d8431601895b968`.

## Collection and readback

Memory values in this table are MiB after explicit garbage collection.
Collection time covers the host's recorded collection operation. Reader time
covers its independent verification operation. The JSON also records process
startup and total orchestration durations; these are different intervals.

| Case                    | Actual source bytes | Collection seconds | Readback seconds | Host heap | Toolshed heap | Reader heap | Catalog bytes |
| ----------------------- | ------------------- | ------------------ | ---------------- | --------- | ------------- | ----------- | ------------- |
| 4,000 sessions          | 156,194,000         | 161.539            | 6.316            | 140.21    | 110.97        | 35.07       | 933           |
| 9,000 sessions          | 351,436,500         | 358.976            | 14.045           | 137.72    | 107.47        | 35.23       | 933           |
| 1 GiB, 64 KiB buffers   | 1,073,815,825       | 166.631            | 17.488           | 139.89    | 110.66        | 35.11       | 924           |
| 4 GiB, 64 KiB buffers   | 4,295,029,009       | 667.017            | 68.196           | 137.32    | 107.41        | 35.14       | 924           |
| 1 GiB, 16 KiB buffers   | 1,073,815,825       | 651.272            | 52.233           | 137.35    | 107.48        | 35.20       | 924           |
| 4 GiB, 16 KiB buffers   | 4,295,029,009       | 2716.256           | 218.321          | 137.24    | 107.42        | 33.85       | 924           |
| 10 GiB, distinct blocks | 10,737,572,497      | 1641.009           | 185.584          | 137.35    | 107.39        | 35.14       | 924           |

At the end of initial collection, the 4,000-session and 9,000-session cases both
recorded 1,965,499 Fabric commit bytes, 481 tracked keys, and 506 watches.

The two 1 GiB runs read the same source byte count. Their total orchestration
times were 191.405 seconds with 64 KiB buffers and 710.915 seconds with 16 KiB
buffers. The configured budgets bound each source read and native page. The
reader also holds a fixed 64 KiB verification buffer.

The 4 GiB runs took 745.382 seconds with 64 KiB buffers and 2945.026 seconds
with 16 KiB buffers. Their retained host heaps after initial collection were
137.32 MiB and 137.24 MiB respectively.

Every reader checks every record's identity, counts, extents, and stored native
digest. It additionally reconstructs the first Claude and Codex files and every
file larger than one configured page. The small session-count cases therefore
fully reconstruct two files. All bytes in each larger-file case are
reconstructed through authenticated page requests and compared with the source
SHA-256 digest.

| Case                    | Records checked | Files fully reconstructed | Native bytes reconstructed | Native page reads |
| ----------------------- | --------------- | ------------------------- | -------------------------- | ----------------- |
| 4,000 sessions          | 4000            | 2                         | 78,097                     | 2                 |
| 9,000 sessions          | 9000            | 2                         | 78,097                     | 2                 |
| 1 GiB, 64 KiB buffers   | 2               | 2                         | 1,073,815,825              | 16,386            |
| 4 GiB, 64 KiB buffers   | 2               | 2                         | 4,295,029,009              | 65,538            |
| 1 GiB, 16 KiB buffers   | 2               | 2                         | 1,073,815,825              | 65,542            |
| 4 GiB, 16 KiB buffers   | 2               | 2                         | 4,295,029,009              | 262,148           |
| 10 GiB, distinct blocks | 5               | 5                         | 10,737,572,497             | 163,845           |

These are finite measurements of the listed inputs. The implementation's buffer
and ownership contracts are described in the
[bounded archive documentation](../../../../../../../packages/connectors/agents/connector/docs/bounded-archive.md).

## Transient memory and disk storage

The following memory values are MiB. Each column takes the maximum across that
case, including restarted processes. Kernel RSS comes from the role's
operating-system resource report. Sampled heap is the largest observed V8 heap
sample. The GC column is the largest object-heap size at the start of a recorded
collection. These are distinct measurements. Aggregate RSS is the largest sum in
the supervisor's process-tree samples.

| Case                    | Host kernel RSS | Host sampled heap | Host GC object peak | Toolshed kernel RSS | Aggregate sampled RSS |
| ----------------------- | --------------- | ----------------- | ------------------- | ------------------- | --------------------- |
| 4,000 sessions          | 820.47          | 376.83            | 388.76              | 476.78              | 1777.16               |
| 9,000 sessions          | 818.06          | 366.15            | 383.72              | 566.70              | 1840.94               |
| 1 GiB, 64 KiB buffers   | 994.45          | 380.96            | 392.92              | 408.83              | 1907.16               |
| 4 GiB, 64 KiB buffers   | 1006.80         | 376.58            | 387.83              | 474.53              | 1976.69               |
| 1 GiB, 16 KiB buffers   | 804.69          | 357.46            | 379.09              | 450.42              | 1767.25               |
| 4 GiB, 16 KiB buffers   | 801.73          | 367.42            | 384.59              | 547.09              | 1867.55               |
| 10 GiB, distinct blocks | 1009.48         | 381.70            | 393.88              | 584.41              | 2059.05               |

The JSON includes each role's RSS, heap, external-memory sample distributions,
GC peaks, and retained stage measurements. It uses nearest-rank medians and 95th
percentiles of observed samples. These statistics are not weighted by time.
ArrayBuffer or native allocator counters that were unavailable are not reported
as measured zeros. GC tracing for the browser supervisor does not measure the
browser worker; the browser section uses developer-tools heap measurements.

The following storage values are bytes. Immutable page totals were measured
after all processes exited. SQLite values were measured at the end of initial
host collection. The 9,000-session page totals therefore include the later
lifecycle work. The JSON preserves complete post-shutdown archive totals and
maximum observed disk use separately.

| Case                    | Immutable page files | Immutable page bytes | Initial SQLite database | Initial WAL | Initial shared memory |
| ----------------------- | -------------------- | -------------------- | ----------------------- | ----------- | --------------------- |
| 4,000 sessions          | 8,002                | 158,814,111          | 20,881,408              | 4,165,352   | 32,768                |
| 9,000 sessions          | 18,000               | 357,292,079          | 46,878,720              | 4,181,832   | 32,768                |
| 1 GiB, 64 KiB buffers   | 46                   | 2,696,862            | 10,293,248              | 4,173,592   | 32,768                |
| 4 GiB, 64 KiB buffers   | 46                   | 2,684,574            | 41,037,824              | 4,161,232   | 32,768                |
| 1 GiB, 16 KiB buffers   | 46                   | 665,246              | 40,996,864              | 4,173,592   | 32,768                |
| 4 GiB, 16 KiB buffers   | 46                   | 685,726              | 164,290,560             | 4,194,192   | 32,768                |
| 10 GiB, distinct blocks | 163,849              | 10,737,483,340       | 152,621,056             | 4,206,552   | 32,768                |

The repeated-block 1 GiB and 4 GiB inputs deduplicate substantially. Their
source byte counts do not represent an equal volume of stored immutable pages.
The 10 GiB case gives every generated block a distinct fixed-width tag. Its page
file totals measure the resulting distinct storage. Empty staging directories
were verified after shutdown in every accepted case.

The 10 GiB source files contain 10,737,572,497 bytes. Their ordered native page
references cover exactly that many bytes. Three files share the same final
30,831-byte page. Two files share the same final 30,882-byte page. All five tail
pages begin at offset 2,147,483,648. Storing each identical tail once saves
61,662 bytes for the first group and 30,882 bytes for the second group.

Distinct native page files therefore occupy 10,737,479,953 bytes. Five message
pages add 3,276 bytes. One shared Git-context page adds 111 bytes. The shared
native-end page has an empty body. The exact formula is:

```text
10,737,572,497 source bytes
       - 92,544 bytes saved by repeated native tail references
        + 3,387 bytes in distinct non-native page bodies
 = 10,737,483,340 bytes in distinct immutable files
```

The 89,157-byte difference is the saved native bytes less the added non-native
page bodies. SQLite storage is measured separately in the table above. The
native byte stream excludes no source region and adds no framing or separators.
An independent post-run check reread all five complete source files and every
immutable native page. It verified each page's length and SHA-256 digest, then
required contiguous source offsets from zero through each file's full length.
Each reconstructed file's SHA-256 matched its source file, stored native extent,
and authenticated-reader manifest. The check also verified all non-native page
hashes, the absence of unreferenced blobs, and the exact physical file
inventory. The JSON preserves per-file digests, duplicate-page hashes and
locations, page-kind totals, and the hash of this private accounting record.

## Lifecycle and browser observations

The 9,000-session lifecycle completed 15 recorded stages in 1871.014 seconds. It
collected and independently read the initial 9,000 records, refreshed unchanged
sources, appended 81 bytes to the first record, and deleted the final record. It
interrupted an upload after eight publications and restarted both the host and
Toolshed. The recovered reader verified 8,999 surviving records containing
351,397,507 native bytes. Its two fully reconstructed files contained 78,178
bytes. Every expected append and deletion was checked by ordinal and digest. All
six process roles exited successfully, including their 16 owned processes.

The registered 4 GiB view completed fifteen navigation actions across both
sessions, their directories, and selected byte pages. Each completed action
retained one pin and had zero outstanding tickets or transfers. Closing the
widget released the pin. The Fabric totals stayed at 657 tracked keys, 960
watches, and 10,739,977 commit bytes during navigation. The largest observed
archive HTTP body was 65,536 bytes. Archive response length and digest checks
passed. The view kept two catalog rows throughout navigation.

After the registered view opened, the page retained 8.06 MiB of JavaScript heap
and the worker retained 87.58 MiB. After closure they retained 8.08 MiB and
87.48 MiB. The worker's sampled heap peak was 171.64 MiB. The largest sampled
renderer RSS was 1,165.70 MiB. Renderer RSS includes more than retained archive
payloads.

The frozen-artifact case used a fresh private SQLite backup of an already
activated snapshot. The original snapshot occupied 212,566,016 bytes and had
SHA-256 `28ac016e1ba41bc85797b89421ab3d2b796ce4deb27a930c7889ad3c2aa9ac18`. The
original saved artifact executed to completion through its original code. Its
document and both original indexes retained the same revision heads and stored
byte totals as the snapshot. Toolshed recorded five legacy hydrations, one
legacy request, 15,848 local reads, and zero writes to the frozen roots. The
final case is a browser visit of the already activated snapshot. The earlier
activation belongs to the historical measurements described below.

The frozen visit retained 134.97 MiB of worker heap and 8.27 MiB of page heap.
Its worker's sampled heap peak was 234.04 MiB. Toolshed retained 177.55 MiB of
heap and 814.55 MiB of RSS after the visit. The largest sampled renderer RSS was
1,316.20 MiB. These observations apply to this exact saved artifact.

## Bounds, cleanup, and checks

The supervisor ceilings were 10,000 generated files, 12 GiB of source bytes, 16
GiB of archive files, and 32 GiB for the private run directory. It stopped a run
at 3 GiB of RSS for any process or 5 GiB of aggregate RSS. No accepted case
recorded a safety stop. Collection and independent readback use one transfer at
a time. The browser's observed transfer counts are retained as measured sample
distributions in the JSON.

Acceptance requires every expected role and scenario result, successful process
exit, no remaining owned processes, and zero open native, scratch, and archive
handles at orderly host and Toolshed shutdown. Toolshed must also finish with
zero pins, tickets, and active archive transfers. Browser acceptance requires
successful saved-piece completion without a bootstrap error. The evidence
validator checks each case's exact budgets, fixture counts, readback scope,
append and deletion results, and unchanged frozen documents.

Repo-wide type checking, formatting, and lint passed after the upstream rebase.
The normal test tasks passed for Memory, UI, connector, host, debug view,
runtime client, runner, HTML, Toolshed, and CLI. The later browser measurement
change passed focused type checking and ten completion/failure checks. The
Memory package task grants UID inspection so that the existing archive-root
ownership check runs under its normal test permissions. UI browser tests and the
actual browser visits ran headlessly.

## Evidence and reproduction

The tracked [measurement summary](measurements.json) contains configurations,
fixture digests, stage values, observed sample statistics, cleanup evidence, and
hashes of the private per-case manifests. Each private manifest gives the
SHA-256 and uncompressed length of every retained measurement file. It also
records compressed lengths and acceptance checks. Private compressed samples,
the storage manifest, the frozen snapshot comparison, and the shell build
manifest are retained during review and landing. Raw logs, identities, tokens,
source contents, local addresses, and process identifiers are excluded from the
tracked report and from the sanitized measurement files.

Expected and verified fixture manifests use ordinal records. The JSON's ordered
fixture digest hashes compact JSON with sorted keys and a trailing newline per
record. Decompressing each private measurement file reproduces the length and
hash in its manifest. The storage manifest names each accepted case by its
manifest hash and records logical lengths of regular files without following
symbolic links.

The five earlier private collections remain labeled as historical prefixes in
the summary. They preceded the final ownership changes or the upstream rebase.
The earlier 9,000-session attempt failed after a deletion-contract mismatch.
Those records are separate from the successful final lifecycle reported here.

For a fresh session-count lifecycle, use:

```sh
deno run -A packages/connectors/agents/connector/bench/host-memory.ts \
  --directory "$BENCHMARK_DIRECTORY" \
  --sessions 9000 --bytes 4096 --delete \
  --read-bytes 65536 --page-bytes 65536 \
  --codex-bin "$CODEX_BINARY"
```

For initial collection and full large-file reconstruction, add `--initial-only`
and use two sessions with a per-file target of 536870912 or 2147483648 bytes.
Set both budgets to 16384 for the smaller-buffer cases. The distinct-data case
uses five sessions with a per-file target of 2147483648 bytes, 65536-byte
budgets, and `--unique-blocks`. The benchmark README describes the private
production shell build and browser visit commands. Exact inputs and revision
provenance are recorded per case in the JSON.
