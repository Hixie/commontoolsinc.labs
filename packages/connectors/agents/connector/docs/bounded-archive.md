# Bounded native archive

The command-line host uses the native v2 archive path for Claude and Codex. The
collector reads native history in fixed buffers and stores it in immutable byte
pages. Session count, transcript size, an individual JSON string's length, and
JSON nesting do not require a corresponding JavaScript array, string, or object
graph. Inventory and parser nesting state can grow on private scratch disk.

The source boundary is [`SessionStream`](../src/session-stream.ts). The
publisher and stored metadata types are in [`archive.ts`](../src/archive.ts).
The backend contract and its negotiated limits are in
[`memory/v2/archive.ts`](../../../../memory/v2/archive.ts).

## Native sources

Claude collection reads project JSONL files and their subagent transcripts.
Codex collection reads active and archived rollout JSONL files and the
per-thread values in its state and history SQLite databases. The inventory
includes sessions present only in a database or only in rollout files. It
resolves duplicate session IDs deterministically and gives a database's
canonical rollout path precedence over directory discoveries.

The collector reads the configured local provider home. Claude uses `configDir`,
then the configured or process `CLAUDE_CONFIG_DIR`, then `~/.claude`. Codex uses
`codexHome`, then the configured or process `CODEX_HOME`, then `~/.codex`. A
Codex command transport does not transfer these files; the host must have local
access to the native source home.

Each database remains in a stable read transaction while its values are
captured. TEXT and BLOB values use incremental reads. Database pages represent
individual column values with table, signed row ID, column, and SQLite storage
class provenance. They are not copies of the database file.

For a log file, the collector pins its identity and captured byte extent. A
bounded hash pass precedes decoding. The decoding pass verifies that same
prefix. Appending after the captured extent is allowed. Replacement, truncation,
a changed prefix, malformed JSON, or a stale Codex projection offset produces a
partial read. Cancellation is checked between bounded reads.

The Claude SDK and Codex App Server remain the command interfaces. Their eager
history APIs are available to library callers, but row pagination does not bound
the size of an individual event or provider response. Native collection does not
call those APIs to assemble history. `AcpDriver` has no `streamSessions()`
implementation. The native publisher rejects it without falling back to eager
collection.

## Stored representation

The Fabric root has schema `commonfabric.agent-connector.catalog.v2`. It holds
the owner DID, opaque archive ID, published generation, counts, and bounded
source health for at most 16 sources. It contains no array of every session.
Source errors retain a total count and examples bounded by both encoded bytes
and count.

Archive records use these metadata schemas:

| Schema                                     | Contents                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `commonfabric.agent-connector.session.v2`  | Bounded summary and recent previews; native byte, event, message, and page counts; revision and content hash; Git observation range and status |
| `commonfabric.agent-connector.checkout.v2` | Bounded repository, branch, and worktree previews; page count and complete Git observation range                                               |

Metadata is limited to 16 KiB per record or page. A control request or response
is limited to 64 KiB. Catalog and page-directory requests return at most 16 rows
and may return fewer to fit the byte limit. Native reads and archive byte pages
are at most 64 KiB. A normalized preview page also has a row limit. These are
memory and transfer bounds; exact native data continues in further pages.

The page directory identifies each page's index, byte count, SHA-256 hash, and
metadata. Page metadata distinguishes four kinds:

| Kind          | Byte contents and provenance                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `native`      | Exact bytes from one source file or database column, with provenance and an offset within that source extent |
| `native-end`  | Empty bytes; metadata records the completed source extent's byte count and hash                              |
| `messages`    | JSON containing bounded, derived message previews                                                            |
| `git-context` | UTF-8 JSON fragments from a complete Git observation, with an offset within that JSON value                  |

Page boundaries can split a UTF-8 character, JSON escape, or native event. A
reader reconstructs one source extent by selecting its `native` pages and
checking contiguous offsets and its `native-end` digest. Concatenating every
page of a session would mix native sources, previews, and Git data. The text
display of a single page is a convenience; its byte download is exact.

The v2 hashes are lowercase hexadecimal SHA-256. `contentHash` covers native
provenance and bytes. `nativeBytes`, `eventCount`, and `messageCount` describe
the native capture and its derived previews. Git observations do not change
these values. `pageCount` includes every page kind.

Native bytes are a different contract from v1 `NativeSessionSnapshot.events`. V1
events came from provider API objects; those APIs can select a conversation
branch, apply compaction, or omit persisted records. V2 preserves captured
native file bytes and database values with explicit provenance. Its summaries
omit `SessionSummary.raw`. Titles and message text in metadata are previews.
Full native values remain in byte pages, including records without a normalized
message. Consumers that need an API-shaped event stream must apply the relevant
provider interpretation to the native capture.

## Git observations

Sessions and discovered checkouts use one representation for complete Git
observations: a `gitContext` range with `firstPage`, `pageCount`, `bytes`, and
`hash`. Its consecutive `git-context` pages contain the full `GitContext` JSON,
including head, sanitized remotes, and observation time. The same representation
applies when the remote list exceeds the record metadata budget.

Session metadata also exposes bounded Git previews, `gitObservedAt`, and
`gitObservationFailed`. If a later Git observation fails, publication keeps the
new native capture and copies the previous complete Git range into the new
record. It pins the previous generation and copies only that range through
bounded reads. The new record does not keep the obsolete native generation
alive. The failure flag describes the latest attempt; the retained observation
time describes the copied data. An initial failure remains explicit when there
is no complete Git observation to retain.

## Publication and migration

A collection stages records in a new archive generation. It publishes the
generation before updating the bounded Fabric catalog pointer. Readers pin the
generation they use, so page requests cannot mix records from different
collections. Pins are released when the reader changes generations or closes.
Pruning retains data needed by active pins.

A failed native session read discards its staged record and retains the previous
complete record, marked partial. An incomplete source inventory retains unseen
prior sessions. A complete inventory can remove sessions that are no longer
present. A failed targeted refresh preserves the published catalog; a successful
targeted refresh retains other sessions and does not claim complete inventory.
Restart aborts abandoned staging before starting a new generation.

The first v2 catalog requires a full, complete native collection. A partial
initial scan or targeted scan cannot initialize it. The host therefore does not
deploy the debug view or admit commands after such a failure. Existing v1 roots
remain frozen: native startup does not hydrate, rewrite, or delete the old
session indexes, manifests, or event chunks. V2 starts from native sources,
without converting the old Fabric graph.

The eager v1 library APIs and stored identities remain available for existing
callers. The archive UI can inspect one old document within fixed byte and
nesting limits. Linked documents remain addresses. An oversized document returns
an explicit bounded-inspection result instead of recursively assembling its
graph.

## Pin ownership and response acknowledgement

Archive transport protocol 2 requires a client-owned pin identifier before a pin
request is sent. The UI installs an `ArchivePinOwner` in its current selection
before calling `acquire()`. The publisher and authenticated reader also retain
that owner before acquisition. The Memory session assigns a monotonic request
sequence before ticket admission. The identifier and sequence remain attached to
the ticket, HTTP execution, acknowledgement, status query, and release.

Ticket admission reserves a pin and protects its generation from pruning. Each
authenticated session may have one pending or provisional request. Published
reader pins and provisional pins share the limit of eight pins per principal and
128 per server. Different sessions belonging to the same principal have separate
provisional slots.

The durable request state has these transitions:

| State       | Trigger                                          | Ownership                                                                                             |
| ----------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Pending     | Ticket admitted                                  | The installed owner names a reserved pin.                                                             |
| Provisional | HTTP pin operation executes                      | The owner retains the request while response verification is incomplete.                              |
| Adopted     | Successful consumption acknowledgement           | Complete body length and SHA-256 verification have passed; the server rechecks current authorization. |
| Released    | Failure, cancellation, or explicit owner closure | Only the matching identity, archive, identifier, and sequence are released.                           |

A failure acknowledgement cannot release an adopted pin. Explicit owner closure
can release it. Duplicate acknowledgements have no additional effect. An old
execution, acknowledgement, or close cannot modify a later request that reuses
an identifier with a different sequence. A successful acknowledgement cannot
revive a released request.

The client reads until its response reader returns `done: true`. It rejects
extra bytes, early EOF, and a mismatched SHA-256 digest before acknowledging
success. The local owner is installed before acquisition. The authenticated
success acknowledgement adopts that exact provisional request after the server
checks current authorization. It returns without waiting for the server's HTTP
response stream to finish. A later HTTP cancellation releases only a
still-provisional pin. An adopted pin remains owned until explicit release or
session closure. Pending response work retains its transfer slot until it has
unwound.

An uncertain acquisition keeps its local owner and known identifier. The owner
can query `status()` or call `close()` after a lost HTTP or acknowledgement
response. These are explicit operations and do not use retries or timeouts.
Control responses include a SHA-256 digest. Native page reads also verify their
expected immutable page digest before acknowledging consumption.

The server retains one sequence high-water row per authenticated session. There
are at most 16 such rows per principal and 128 per server. Admission refuses a
new session row when that separate bookkeeping limit is full. It does not evict
active sessions or forget their sequence history. Memory session detach,
connection closure, transport shutdown, and archive restart release the
corresponding pin and sequence state. Pending I/O keeps its admission slot until
it has unwound.

A session whose close acknowledgement fails keeps its cleanup ownership. Another
explicit `close()` finishes that cleanup. Concurrent closes share the same
operation. Client shutdown joins a pending session close and releases the
connection's remaining ownership when the transport disconnects.

## Server and access requirements

Toolshed enables the archive only when `MEMORY_ARCHIVE_ROOT` is set to an
absolute, private directory. `MEMORY_ARCHIVE_ORIGINS` is a comma-separated list
of exact browser origins permitted to transfer pages, including scheme and port.
For example, an operator can configure `https://app.example.test`; a wildcard or
a URL path is not an exact origin. `MEMORY_ARCHIVE_QUOTA_BYTES` optionally
limits native bytes per archive, including staged pages. These are server
settings, separate from host source configuration.

The server owns the archive root and its SQLite catalog and immutable page
files. Clients send opaque archive and record identities, not filesystem paths
or SQL. The backend verifies the private root and confines its file access to
that root. Publication failures, including quota failures, preserve the prior
published catalog.

Archive operations require an authenticated Memory session. Authorization uses
the acting principal and trusted Common Fabric confidentiality and integrity
labels on the handle. The durable archive binding records the owner and
connector writer authority. Browser page access uses the same authorized archive
operations and the configured origin policy.

`AgentFabricTarget.connectArchive()` negotiates the archive protocol and every
hard limit before synchronizing connector cells. The host performs this step
before claiming roots, opening its ledger, starting drivers, or deploying the
debug view. A missing or incompatible backend fails startup. There is no
unbounded remote fallback.

The debug component calls the archive API imperatively. It retains one catalog
page, one page directory, and one selected byte page. Archive results and page
bytes are not written to Fabric result cells or document history.
