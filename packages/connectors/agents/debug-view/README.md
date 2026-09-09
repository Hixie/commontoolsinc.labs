# Agent sessions debug pattern

This pattern shows the live state of an agent connector host and provides an
explicit command composer. The native host deploys it after the initial
collection succeeds. It passes the v2 archive catalog and the shared health,
command, and receipt cells directly. The view uses those links and does not
reconstruct them from causes.

Native session inspection uses the imperative `cf-agent-archive` component. It
requests bounded archive rows and byte pages through authenticated Memory
operations. Native results stay in the component; they do not become Fabric
result-cell values or document history. The collection and storage contract is
in [Bounded native archive](../connector/docs/bounded-archive.md).

## Views

| Tab       | Contents                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Overview  | Host state, command admission, source lifecycle, collection completeness, bounded errors, counts, and connector cell identities          |
| Sessions  | Paged native session and checkout records, bounded metadata, page directories, exact byte-page inspection, and a command target selector |
| Commands  | Confirmed command composer, command values, and receipts                                                                                 |
| Activity  | The host's bounded lifecycle and receipt history                                                                                         |
| Raw cells | On-demand views of shared connector control cells; native history is inspected through archive pages                                     |

## Native session inspection

The component retains one catalog page, one page directory, and one selected
byte page. Catalog and directory responses contain at most 16 rows and may
contain fewer to fit the control-byte limit. A byte page is at most 64 KiB.
Changing the selection releases the old page's download object and clears its
contents. Opening the table does not read every session or transcript.

Use the catalog controls to page through records, restrict the source, select
checkouts, or open an exact session key. **Inspect** opens the selected record's
bounded metadata and page directory. **Command** fills the command composer with
the source and native session ID. The component labels a retained record as its
previous complete version when a later native capture was partial.

The component pins the catalog's generation while making requests. Every record
and byte-page read uses that generation and pin. A catalog update switches to a
new generation and releases the old pin; closing the component also releases it.
Storage pruning preserves records required by active pins.

Page inspection displays the page's SHA-256 hash, metadata, a text rendering,
and **Download exact bytes**. A page can split a UTF-8 character or JSON token.
The text rendering can therefore differ from a whole-value decoding at that
boundary. The download preserves the source bytes exactly.

Native page metadata records the source file and offset. Codex database values
also identify the table, signed row ID, column, and SQLite storage class. Claude
subagent pages identify their child transcript. A `native-end` directory entry
records the completed native extent's byte count and hash. A reader follows
contiguous native offsets and verifies that digest to reconstruct one extent.

Session directories also contain derived `messages` pages and `git-context`
pages. They are separate from exact native extents. The record's `gitContext`
range identifies every page of its complete Git observation, with byte count and
hash. This includes head, sanitized remotes, and observation time even when the
remote list exceeds the metadata budget. A failed later Git lookup can retain
the previous complete observation while publishing current native bytes; the
record's failure flag and observation time identify that state.

Metadata titles and message text are bounded previews. Exact native bytes
preserve larger values and records without normalized messages. Native logs and
database values are not the v1 provider API event objects. Reconstructing an
API-shaped conversation requires the provider's interpretation of those
persisted records.

## Command composer

The Commands tab can append `prompt`, `cancel`, `rename`, `set-mode`, and
`set-config-option` values to the connector's command cell. The form validates
the source, native session ID, payload, and connector format limits. The
Sessions tab has a Command button that fills the source and native session ID
without displaying that ID in the session table. Choosing a session starts a
fresh draft so payload fields from another conversation do not carry over.

Reviewing creates an immutable command snapshot with a generated ID and
timestamp. A modal shows the complete snapshot, including prompt text, before
the user can send it. Sending serializes the snapshot as JSON and uses
`Cell.push()`. The connector accepts both object values and JSON strings. The
string keeps the appended value inline in the shallow command action array, so
the host receives the complete command without following another cell.
Concurrent command producers append instead of replacing each other's command
arrays. The host deduplicates command IDs, publishes an in-flight receipt before
calling a driver, and publishes the terminal outcome in the receipt index.

Command drafts, the pending confirmation, validation messages, and the last
submission message use `Writable.perSession`. They are not shared between
viewers. The command array is shared connector state. The composer disables its
review and send actions while host health reports that command admission is
stopped.

## Deployment and authorization

The supported deployment path is `deployAgentSessionsDebugView()` from
`@commonfabric/agents-host`. It supplies the native catalog handle and shared
control-cell inputs, binds the deterministic command queue to the verified
command-submission handler, and labels the rendered result for the owner. The
host stores an owner-confidential registration and prints its piece ID. It does
not add the piece to the space-wide default app registry.

On later starts, the host reuses a prepared piece only when its pattern
identity, configured owner, and connector input links match. A new pattern
identity creates a new piece. The private registration identifies the current
piece and retains retired causes. The host removes stale shared-registry links
and stops superseded local runners without traversing their result graphs.

The native host negotiates the required archive protocol and limits before
connector-cell synchronization, ledger setup, driver startup, or debug
deployment. Toolshed must enable `MEMORY_ARCHIVE_ROOT` and allow the viewer's
exact origin through `MEMORY_ARCHIVE_ORIGINS`. The optional
`MEMORY_ARCHIVE_QUOTA_BYTES` limits archive disk use. See the
[host README](../host/README.md#run-it) for setup.

Archive access requires an authenticated Memory session and authorization
against the acting principal and trusted labels on the catalog handle. The
server binds the archive to its owner and connector writer. Clients cannot
select arbitrary filesystem paths. The composer is the pattern's only write path
to connector data; it appends to the protected command queue. Session inspection
cannot change archive records, the catalog, health, or receipts.

Tab selection and command drafts use `Writable.perSession`. Archive selection
and page bytes live in the browser component. Different viewers keep independent
inspection and draft state. Commands, previews, native pages, and Git metadata
are owner-confidential data; space membership alone does not grant access.

## Existing v1 data

Native startup leaves the old recent and complete indexes, session manifests,
and event chunks frozen. A first v2 catalog requires a full, complete native
scan. An initial partial or targeted scan cannot publish that catalog or proceed
to debug deployment. Migration reads native sources instead of assembling old
Fabric transcript graphs.

**Inspect a legacy document** accepts one document ID. It reads one document
within fixed byte and nesting limits and keeps linked documents as addresses.
Oversized documents return an explicit bounded-inspection result. This action
does not traverse a transcript or migrate the old data.

The pattern retains its v1 input mode for library callers that explicitly supply
recent and complete index cells. That mode uses the old session-row and manifest
links and raw detail pieces. It is separate from the native host path and does
not provide the native archive's memory bound. V1 cells keep their stored
identities and formats, described in
[Interfaces and protocols](../connector/docs/interfaces.md#v1-fabric-graphs-and-shared-control-cells).

## Verification

```sh
deno task cf check packages/connectors/agents/debug-view/main.tsx --no-run
deno task cf test packages/connectors/agents/debug-view/main.test.tsx \
  --root . --verbose
```
