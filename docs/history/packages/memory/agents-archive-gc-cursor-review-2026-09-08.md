---
status: historical
created: 2026-09-08
archived: 2026-09-08
reason: "Completed narrow review and SQLite proof for the archive garbage-collection cursor."
---

# Archive garbage-collection cursor review

This review followed the
[archive transfer boundary review](agents-archive-boundary-review-2026-09-08.md).
It inspected the subsequent change to `ArchiveStore.#collectGarbage` on base
`0d4dca379aef185d351a013f5bfecbf7918b84e2`. The reviewed store file was copied
into the isolated review worktree. The reviewer made no changes to that file.

The collector now queries strictly after the previous `(archive, hash)` pair. It
orders by the same pair. The loop performs no asynchronous work, so another
archive operation cannot insert a newly orphaned page behind its cursor during
the collection. Archive identifiers and page hashes are nonempty hexadecimal
strings. An initial pair of empty strings precedes every stored pair.

The replacement page-reference check uses the new `pages(archive, hash)` index.
The omitted records join is consistent with the checked insertion path: each
page is inserted using the archive of the record already checked by `#record`.
The collector deletes unreachable records first. Foreign-key cascades remove
their page entries before the orphan query runs. The collector still unlinks the
file before deleting the blob row and reducing its byte accounting.

The independent proof used two archives containing three one-byte pages each.
Within each archive, the middle hash was made unreachable in the private test
catalog. This represented recovery after reference deletion and before file
collection. On reopening, the store removed both orphan files and preserved the
other four files. Fresh pinned reads returned all four original live values.
Each archive reported two bytes, two pages, and two records afterward.

SQLite EXPLAIN QUERY PLAN reported an indexed search on the blobs compound
primary key and an indexed search on `page_archive_hash`. It did not use a
temporary sort. This verifies the query plan used by the fixture; it is not a
wall-clock performance measurement.

The proof is
[`v2-archive-gc-cursor.test.ts`](../../../../packages/memory/test/v2-archive-gc-cursor.test.ts).
The focused command was:

```sh
deno test -A \
  packages/memory/test/v2-archive-gc-cursor.test.ts \
  packages/memory/test/v2-archive-store.test.ts \
  packages/memory/test/v2-archive-concurrency.test.ts
```

The runner reported `3 passed (7 steps) | 0 failed` in one second. The new proof
passed formatting, lint, and type checks. No correctness defect was found in
this narrow change.
