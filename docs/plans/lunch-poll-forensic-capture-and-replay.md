# Lunch poll forensic capture and replay

**Status:** proposed. Research is complete. Implementation has not started.
Written 2026-07-27 against `upstream/main` at
`a52f37cfe12249e694f3aa1dc3d1e036551e6c00`. The point-in-time service and
access evidence gathered for this plan is preserved in the
[2026-07-27 instrumentation audit](../history/lunch-poll-forensic-instrumentation-audit-2026-07-27.md).

## Decision

The current system can reconstruct every accepted durable Fabric change in
logical commit order. It can also show high-level server timing and accepted
writer contention. It cannot reproduce every user interaction, rejected
conflict, optimistic client state, network message, database read, or packet.

Meeting the requested standard requires separately verifiable records:

1. A durable-state record that can reconstruct the contents of the space at
   any accepted commit.
2. A causal interaction record that captures every input, read, write,
   scheduling decision, network message, rejection, retry, and external result
   needed to re-execute Common Fabric behavior.
3. A database-internals record that preserves logical reads, SQL activity,
   pager activity, and file changes.
4. A physical network and host record that preserves packets, socket
   lifecycles, process events, database file activity, and capture-loss
   counters.

OpenTelemetry, application logs, and packet captures are useful indexes into
that record. None of them is a lossless record by itself. The forensic record
must use an append-only local journal that pauses new work or marks the run
invalid when it cannot persist an event. A recorder that silently drops data
cannot support a claim of complete replay.

A normal Estuary or Rapids virtual machine also cannot reproduce every CPU
instruction, browser-engine scheduling choice, kernel scheduling choice, or
physical event on a participant's computer. Literal whole-machine replay would
require a separate deterministic virtual-machine environment for every machine
in the interaction. The plan below reaches causal Common Fabric re-execution,
first-divergence checking, database-level evidence, and packet-level evidence
on controlled endpoints. It does not claim instruction-level or exact browser
engine replay on the current Google Compute Engine deployment.

## Capture boundary

One forensic run is identified by a new `captureId`. The run begins before the
first browser opens the lunch poll and ends only after the final database
snapshot, event journal, and packet capture have been verified.

This document defines four claim profiles:

1. **Accepted state** reconstructs accepted Fabric history.
2. **Application causal** records application inputs, Common Fabric runtime
   decisions, protocol messages, rejected attempts, and external results.
3. **Database internals** adds SQL, pager, write-ahead-log, and file evidence.
4. **Network and host** adds endpoint packets, sockets, processes, and service
   lifecycle evidence.

The requested **full forensic** run activates all four. Each profile is
verified separately. Packet or pager failure does not erase a valid
application-causal record, but the composite full-forensic claim then fails.

The required boundary includes:

- every participating browser tab and browser process;
- the shell main thread and its runtime Web Worker;
- all main-thread and worker messages;
- the runtime scheduler, replica, storage client, and render path;
- the signed memory WebSocket protocol;
- Tailscale Serve, Nginx, and every selected Toolshed process;
- the per-space memory database and every sibling SQLite cell database;
- the image-generation request, FAL response, image download, and cache;
- process, operating-system, and network evidence on the server;
- the initial deployment artifact and every relevant configuration value;
- a conformance report that lists the enforced boundary, source coverage,
  detected gaps, drop counters, and uncertainty.

The boundary must be enforceable. Use an isolated poll space and dedicated
participant browser profiles. Add a capture admission gate to memory
`session.open`. Every session that can touch the captured space must present
the `captureId` and a signed recorder proof. The proof is bound to the
connection challenge, user DID, recorder source identifier, allowed spaces,
recorder artifact digest, and expiration. A connection without a valid proof
is rejected and recorded as a boundary violation. Background services and
uninstrumented clients are either included or denied for the run.

Lunch poll reads profile data from other spaces. The application-causal profile
can treat recorded wish results as external inputs. The database-internals
profile must instead include the transitive set of participant profile, home,
and other spaces actually read. An unexpected cross-space read expands the
boundary before it is served or invalidates that profile.

A valid result is “profile-conformant with no detected gaps inside the enforced
boundary.” Sequence numbers and hash chains cannot prove that an interceptor
which never ran observed every event in the universe. The server admission
gate, dedicated clients, source inventory, and cross-source comparisons make
the narrower claim testable.

The record contains names, votes, profiles, image prompts, application values,
network bodies, and authorization material. It must be treated as sensitive
production data even when the lunch poll itself feels informal.

### Observer effect

Complete recording changes the system it observes. Durable event writes add
work and can alter the timing of a conflict. Packet capture, browser control,
database tracing, and screen capture also consume resources.

There is no instrumentation design that eliminates this effect. The recorder
must minimize it, measure it, and report it. Each source records queue depth,
bytes, write duration, blocked duration, CPU use, and dropped-event counters.
The Rapids rehearsal compares the same synthetic workload with capture disabled
and enabled. The manifest records the measured overhead.

Common Fabric replay can check the instrumented run's recorded decisions and
stop at the first divergence. Guided browser re-execution may still differ in
browser scheduling or pixels. Neither can prove what the uninstrumented run
would have done. These distinctions must remain visible in the explorer and
every exported report.

## Current interaction path

The browser shell creates a `RuntimeClient` in the main thread. The client
communicates with a runtime processor in a Web Worker. The worker owns the
runner, scheduler, replica, and storage session.

A durable lunch poll interaction currently follows this path:

1. The browser dispatches a Document Object Model event.
2. A handler runs in the worker and opens a transaction.
3. The runtime reads cells, applies optimistic local changes, settles reactive
   work, and renders the result.
4. The storage client sends a memory version 2 commit over a WebSocket session
   authenticated by a signed `session.open` exchange. Individual commits are
   not separately signed.
5. The server checks the sequence values the client read, authorization,
   preconditions, and operations.
6. An accepted commit is written to SQLite and receives a server sequence
   number.
7. Subscriber synchronization sends changed values to other runtimes, which
   integrate them and render again.

The lunch poll stores its shared state in Fabric, not in the pattern SQLite
builtin. Its shared state includes the question, options, votes, users,
participant profiles, administrator name, and visits. The user's name is
per-user state. Drafts and confirmation state are per-session state.

Generated option art calls `/api/ai/img`. Toolshed calls
`fal-ai/flux/schnell`, downloads the returned image, and caches it under the
configured cache directory. The pattern can then store a WebP data URL in an
option. Exact replay therefore needs both the AI response and the downloaded
image bytes.

The current conflict surfaces are not uniform:

- voting and option membership use deterministic keyed entities and
  merge-aware insertion;
- joining, visit changes, reset, and clear perform whole-array reads followed
  by whole-array writes;
- generated art crosses an asynchronous network and cache boundary;
- `#now/300` supplies coarsened time, while browser locale and time zone can
  change date-oriented views near midnight.

The rehearsal must exercise each shape. A successful concurrent-vote test does
not prove that the whole-array operations or time-dependent views replay.

### Deployment path

Rapids deploys automatically from `main` after the binary-attestation job in
`.github/workflows/deno.yml`. The job uses the `toolshed` GitHub environment
and asks the bastion to run:

```text
/opt/cf/deploy.sh rapids <git-sha> --skip-clusterduck
```

Estuary deploys only through the manual production workflow. The operator
selects a Git reference. The workflow resolves it to a commit, downloads
`gs://commontools-build-artifacts/workspace-artifacts/labs-<git-sha>.tar.gz`,
and asks the bastion to run:

```text
/opt/cf/deploy.sh <deployment-environment> <git-sha>
```

Both paths use the `BASTION_HOST` and `BASTION_SSH_PRIVATE_KEY` GitHub
environment secrets. Estuary also uses `GCP_SA_KEY` to download the selected
artifact and `DEPLOYMENT_ENVIRONMENT` to name the bastion target. The workflow
files establish these names. The capture preflight must verify current secret
existence, environment protection rules, and dispatch permission.

The current infrastructure definition has Tailscale Serve accept the tailnet
connection and forward it to local Nginx. Nginx selects one of twenty-one
Toolshed processes. Memory WebSocket routing is sticky by request URL. A
full-forensic server capture must therefore run across every process and
record Nginx's upstream selection. The live topology remains a required host
preflight check.

Nginx currently adds `X-Debug-URI`, `X-Debug-Backend`, and
`X-Served-From` response headers. A controlled browser can preserve these
useful routing clues. They are not stable causal identifiers and they do not
replace the server process record.

## What exists today

### Inventory

| Layer | Existing evidence | Persistence and default | What it proves | Missing evidence |
| --- | --- | --- | --- | --- |
| Deployment | The deployment workflow names the Git revision and uploads a versioned artifact. `/api/meta` reports the running Git revision and server DID. The VM role is configured to keep eight releases. | Durable in GitHub Actions, the artifact bucket, and the VM release directory. | Which source revision a server reports and which artifact the workflow selected. | A signed run manifest does not bind the browser bundle, server files, configuration, process versions, and database content hashes into one record. |
| HTTP request log | Toolshed's Pino middleware logs each HTTP request and response. It records method, complete URL, headers, status, and a generated request identifier. Authorization, cookie, proxy authorization, and set-cookie headers are redacted. | Enabled unless `DISABLE_LOG_REQ_RES` is set. Production writes JSON to journald. | HTTP timing and routing at the application boundary. | It records no bodies. Its generated request identifier is not returned to the caller or propagated into the memory protocol. Complete URLs can expose image prompts. |
| VM and proxy logs | The Google Ops Agent sends journald and Nginx access and error logs to Cloud Logging. | Journald is limited to 2 GB and fourteen days. Nginx keeps seven rotations. The Cloud Logging `_Default` bucket keeps data for thirty days. | Process messages, service lifecycle, proxy requests, and proxy errors. | These logs do not contain memory messages, rejected commit detail, browser state, or packet payloads. The thirty-day bucket is not an immutable forensic archive. |
| Server OpenTelemetry | Toolshed creates HTTP spans and memory spans named `memory.transact`, `memory.commit.persist`, `memory.subscribe`, `memory.subscriber.sync`, `memory.watch.refresh`, `memory.fanout`, and `memory.socket.setup`. | OpenTelemetry is off by default in source. It is enabled on both live targets. Export is batched and does not block the application when export fails. | Timing and attributes for transactions that enter an instrumented span. This includes space DID, user DID, session identifier, local sequence, accepted commit sequence, and a boolean conflict marker. | An unknown-session rejection returns before `memory.transact` starts. Several typed authorization and replacement denials return without marking the span as an error. The spans do not contain full reads, writes, protocol bodies, exact conflict paths, the winning write, or a retry chain. A process crash can lose a batch. |
| SigNoz | The VM collector forwards traces, metrics, and logs to the stage SigNoz installation. | Live core trace tables have a fifteen-day time-to-live. The derived `span_attributes` table has a two-day time-to-live. | Searchable cross-service traces and aggregate timing. | It is short-lived and can drop data. It is an observability system, not evidence storage. |
| SigNoz dashboards | The infrastructure repository contains runner and memory multiplayer, scheduler health, and pattern-performance dashboards. SigNoz also provides an interactive trace view. | Available while the underlying trace and metric rows remain. | Aggregate rates, durations, scheduler activity, storage activity, and navigation from a trace to its spans. | Panels are empty when the emitting browser or harness is not instrumented. Dashboards do not retain raw interactions or establish completeness. |
| Accepted memory commits | `commit.original` stores the accepted client commit. It includes confirmed and pending storage reads, operations, preconditions, scheduler observations when supplied, the code content identifier, branch, and local sequence. The separate `commit.session_id` column stores the server-derived session key. `commit.resolution` stores the assigned sequence and resolved pending reads. | Durable in the per-space SQLite database. | The accepted storage transaction, its declared storage-read basis, and its server-derived session key. | Rejected attempts, authorization failures, protocol errors, client-only reads, optimistic states, and wall-clock precision better than one second are absent. |
| Memory revisions | `revision` records branch, entity, scope key, sequence, operation index, operation, data, and owning commit sequence. | Durable in the per-space SQLite database. | Accepted entity history in logical order. | Pattern SQLite operations are intentionally not expanded into revisions. |
| Pattern SQLite builtin | SQLite operations are included in `commit.original` and execute inside the accepted memory transaction. Their data lives in sibling `cell-*.sqlite` files. | Durable on the server disk. | The accepted high-level SQLite operation. | The remote memory dump omits sibling databases. SQL reads, result rows, statement timing, write-ahead-log activity, and page-level file access are not recorded. |
| State inspector | `cf inspect` lists spaces and identities, reconstructs values at a sequence, finds hot entities and churn, shows writer timelines, renders graphs, compares states, and builds a self-contained HTML explorer. Reconstruction uses the same patch semantics as the memory engine and has parity tests. | Offline and read-only against a SQLite snapshot. | Accepted durable state, history, writer contention, and inferred stale-read anomalies. | Its conflict views cannot show rejected conflicts because the database never received them. It cannot show the browser, scheduler execution, rendered interface, network, or physical timing. Its contract says it explains state and does not reproduce execution. |
| Remote memory dump | The staging-only route uses `VACUUM INTO` and returns a crash-consistent per-space database after a signed Common Fabric request and DID allowlist check. | Off by default. It refuses production without an override. | A stable snapshot for offline accepted-state analysis. | It is not continuous. It omits rejected attempts, client evidence, packets, and sibling SQLite cell databases. |
| Memory write diagnostic | `CF_DEBUG_MEMORY_WRITES=1` prints operation identifiers, scope, value hashes, and paths. `CF_DEBUG_MEMORY_WRITE_VALUES=1` can also print values. | Off by default and written to process logs. | Parsed operations that reached a connection. | The connection number is process-local. It lacks stable user and session identity, reads, result, rejection, response, and retry lineage. Raw values are unsafe in ordinary logs. |
| Slow-query ring | The memory server keeps the last one hundred operations that exceed 100 milliseconds and exposes them through health diagnostics. | In process memory only. | Recent slow query and watch operations. | Fast operations, evicted entries, and everything lost on process exit are absent. |
| Browser OpenTelemetry | A shell local-storage switch enables a browser trace provider. Runtime storage pushes, storage pulls, preflight work, and longer action runs can become spans or metrics. The shell forwards them through `/api/telemetry/v1/traces`. | Opt-in, batched, trace-only, and not reliably active without a reload. The forwarding route is fire-and-forget. | Selected client timing. A storage-push start can be joined by space and local sequence. Session is present on only some completion records. | The current attributes do not provide one deterministic join for every rejected attempt. Most browser sessions do not emit telemetry. Detailed writes and runtime graph markers are not exported. A crash or unload can lose a batch. The endpoint can acknowledge data that the collector fails to accept. |
| Runtime telemetry bus | Markers cover scheduler runs, settlement, cell updates, invocations, event commits, preflight work, storage pushes and pulls, subscriptions, graph snapshots, dependency updates, and non-settling behavior. Event commit markers include read and write counts and a write list. | In process memory. The debugger retains one thousand markers and supports a manual JSON download. | Detailed recent runtime activity when the debugger was enabled. | It is not durable, exact values are often absent, graph markers are not exported to OpenTelemetry, and ring overflow or a crash destroys evidence. |
| Worker diagnostics | The worker keeps settlement statistics, up to two thousand action-run entries, four hundred trigger entries, and four hundred watched write-stack entries. Developer-console helpers expose the rings. | Opt-in and in memory only. | Action durations, declared and actual write addresses, trigger invalidation decisions, and selected stacks. | Values are summarized. Rings are bounded. They do not survive reload, crash, or a participant leaving. |
| Browser console tools | `commonfabric` helpers can read and subscribe to cells, dump the virtual Document Object Model, show renderers, count and time logger events, reset measurement baselines, expose flags, inspect worker telemetry, detect non-idempotent actions and cycles, and arm trigger, action, and write-stack traces. | Interactive and in memory. An operator must run the commands while the session is alive. | Current values, rendered-tree shape, recent scheduler causes, logger volume, and selected stacks. | Commands are manual. Most output is bounded or aggregate. The act of reading can add runtime work. Nothing is automatically attached to a user interaction or archived. |
| Browser integration failure probes | Pattern integration helpers retain a fill-phase ledger, bound-cell state, pending main-thread requests, worker request counts, bounded console output, completed message timing, runtime load summary, and churn counts. A scripted path can also request Chrome performance and trigger traces. | Test-only and normally printed after a failure or an explicit opt-in. | Whether a test stalled before input, in main-thread messaging, in worker processing, or during settlement. | The probes depend on test timeouts and bounded tails. They do not run for live users, preserve exact message bodies, or create a replayable timeline. |
| Lunch poll integration test | `lunch-poll-vote.test.ts` opens two browsers, votes concurrently, and checks that both votes converge. | Test-only. | One important multiplayer merge path. | It does not collect a replay bundle or prove rejected-conflict, reconnect, crash, external AI, database, or packet coverage. |
| Lunch poll diagnostic harness | `lunch-poll-diagnose.ts` runs a local matrix of multi-runtime joins and concurrent votes. It prints phase timing, graph and settlement summaries, action-write summaries, conflict and rejection counts, and convergence hashes as JSON. | Local diagnostic command whose output is saved only when its caller redirects it. | Repeatable scaling and convergence scenarios with more runtime detail than the browser integration test. | It does not target the live deployment. Conflict evidence is aggregate logger counts. It has no exact values, protocol journal, server evidence, database trace, browser render, or packets. |
| Deno CPU profiler | `cf-profile` runs a local Common Fabric command under the Deno inspector and writes a sampled CPU profile, mirrored console log, and metadata. Its lifecycle is signal and process-state driven rather than timeout driven. | Local operator tool. Output goes under `tmp/cf-profile` by default. | Where a local CLI or diagnostic command spent CPU time. | It does not attach to a deployed Toolshed or browser. A sampled CPU profile is not an execution record. |
| Traversal capture and replay | `CF_TRAVERSE_CAPTURE` records `SchemaObjectTraverser.traverse()` calls, selectors, links, context identities, documents read, the resulting read set, and schema-tracker contents. The test harness replays fixtures deterministically and compares result hashes and golden records. | Off by default. It writes a local JSON fixture on unload and every thirty seconds. It defaults to a twenty-thousand-invocation cap. | Detailed, deterministic replay of one traversal subsystem against a captured corpus. | Documents are first-value-wins, later writes are not represented, client object construction differs during replay, and the cap drops later calls. It is a benchmark and regression fixture rather than an interaction record. |
| Builtin replayability registry | The pattern builder classifies a small allowlist of pure builtin modules as replayable. Fetch, language-model, navigation, wish, server SQLite query, program execution, and other ambient or effectful builtins are explicitly non-replayable. Unknown names fail strict. | Static source checked by tests against registered builtins. | Which builtin results can be recomputed from their inputs and which need a recorded result. | It records no invocation, input, output, external response, or order from a real run. User-authored JavaScript can still use nondeterministic inputs outside the named builtin boundary. |
| AI image route | The route logs the prompt, prompt hash, cache decision, and FAL result. The cache keeps generated image bytes. | Application log and mutable cache. | Which prompt and cache path were used while retained. | There is no stable interaction identifier, complete request and response archive, provider-side request identity, or immutable image record. |
| Packet and socket capture | None is configured for the lunch poll. | Not present. | Nothing at packet level. | Browser packets, outer Tailscale packets, decrypted tailnet traffic, loopback proxy traffic, DNS, retransmits, socket owners, and packet-drop counters are absent. |

The source default for trace sampling is to keep every span. The deployed
sampler configuration is in vaulted environment data and must be verified by
the capture preflight. Even an always-on sampler would not make batched export
that lets a request continue after export failure a complete record.

### Memory database truth boundary

The accepted commit record is the strongest evidence that exists today.
`packages/memory/v2/engine.ts` stores:

- `commit`, with the original client transaction and server resolution;
- `revision`, with accepted entity operations;
- `head`, `snapshot`, and `branch`, with reconstruction state;
- `blob_store`, with durable binary values;
- optional persistent scheduler tables.

Only accepted commits enter these tables. `Engine.ConflictError` can carry an
entity, sequence, and conflicting sequence, but the current server trace only
sets `ct.conflict=true` and records the error message. A conflict that rejects
an attempt has no durable attempt row.

The best current join between a browser storage-push span and the server's
`memory.transact` span uses the attributes that happen to be present:

```
(space DID, session identifier, commit local sequence)
```

The storage-push start does not contain the session identifier. Some terminal
client markers do, but rejected attempts do not reliably expose one record
with all three fields. The tuple is therefore not a deterministic join for all
attempts. The accepted server commit sequence joins accepted work to the
memory database. The Pino HTTP request identifier is not part of this join.
Trace context on the long-lived WebSocket does not give every message a
distinct trace. The new recorder needs one stable attempt identifier on every
client and server record. It also needs the session identifier on every
terminal marker.

### Audit evidence

The live endpoint checks and access results used to establish this baseline
are frozen in the
[2026-07-27 instrumentation audit](../history/lunch-poll-forensic-instrumentation-audit-2026-07-27.md).
Run the capture controller's preflight again before relying on any credential,
route, retention period, host, or deployed revision.

### Related work that is not current instrumentation

The unmerged branch `upstream/runner/ws-d1-invocation-ids` threads a
caller-supplied event identifier into stream sends and exposes the durable
handling receipt address. That is useful design input for causal identifiers.
It is not on `upstream/main`, and this plan does not treat it as deployed.

The unmerged `fabric-bytes-probe` branch contains exploratory tests. It does
not add a production capture path.

## Questions the current evidence can answer

The current database and state inspector can answer:

- What was the accepted state at a particular server sequence?
- Which accepted transaction changed an entity?
- Which storage reads and operations were declared by an accepted commit?
- Which sessions and principals wrote heavily?
- Did accepted history show write contention or an inferred stale-read
  anomaly?
- Did all accepted histories converge to the final durable state?

The current evidence cannot answer:

- Which rejected transaction first observed a conflicting value?
- Which exact path, basis sequence, and winner caused a rejection?
- What did a browser render before and after optimistic settlement?
- Which local actions ran, rolled back, or retried for a user?
- Which computed-cell and renderer reads happened during an action?
- What exact WebSocket frames entered and left either endpoint?
- Whether an acknowledgement was delayed in the browser, proxy, server,
  database, or subscriber fan-out path?
- Which SQL statements and result rows were used by a SQLite-backed cell?
- Which TCP segments were retransmitted, reordered, or dropped?
- Which FAL response and downloaded bytes caused the stored image?
- Whether missing telemetry means no event happened or a batch was lost?

## Access and credential inventory

Secret values never belong in this repository or the general capture journal.
A workflow reference proves only that a secret name is expected. It does not
prove that the secret exists or that an operator can use it. The last
sanitized access check is in the
[historical audit](../history/lunch-poll-forensic-instrumentation-audit-2026-07-27.md).
The capture controller must re-run every access and capability preflight for
each run. Exact workstation security posture, private-key locations, identity
allowlists, and broad infrastructure permissions belong in a restricted
operator handoff.

### Credentials and approvals required

| Need | Rapids | Estuary | Required action |
| --- | --- | --- | --- |
| Signed memory snapshot | Staging dump route exists. | Production route correctly refuses service. | Add a dedicated forensic DID to Rapids' `MEMORY_DUMP_DIDS`. Do not share another operator's private key. Keep Estuary acquisition separate from the public request route. |
| Host and database acquisition | Direct host access or a controlled acquisition service is needed for coherent main and sibling database copies. | The controlled path is mandatory because the production dump route is disabled. | Verify both SSH host fingerprints through a trusted source. Provision a short-lived forensic SSH identity. Give it narrow snapshot, spool-export, and capture-health commands. Do not reuse the CI bastion deployment key or `BASTION_SSH_PRIVATE_KEY` for human access. |
| Deployment metadata | Workflow names are visible. | Workflow names are visible. | Use the repository's intended read-only or operator scope. Verify the expected environment secrets and deployment variable without displaying their values. Treat `GCP_SA_KEY`, `BASTION_HOST`, and `BASTION_SSH_PRIVATE_KEY` as automation credentials, not forensic operator credentials. |
| Trace query | Telemetry export is configured. | Telemetry export is configured. | Provision a scoped read-only SigNoz API credential for the explorer and archive exporter. Do not make a general ClickHouse credential part of the user-facing tool. |
| Host packet capture | Required. | Required. | Grant narrowly scoped capture capabilities to `dumpcap`, `tcpdump`, or an extended Berkeley Packet Filter collector. Install the selected tools through infrastructure code. |
| Browser packet and event capture | No managed recorder is deployed. | No managed recorder is deployed. | Use approved, controlled endpoints with dedicated clean browser profiles and a native Chrome DevTools Protocol controller. Obtain participant consent before recording. |
| Evidence archive | No dedicated archive exists. | No dedicated archive exists. | Create a versioned integrity store and a separately encrypted finite-retention payload store. Give recorders object-creation access. Give investigators separate read access. Retention-lock only the signed integrity material unless policy explicitly approves locking a payload class for a finite period. |
| External AI evidence | The deployed server has the FAL credential needed to call the service. | The deployed server has the FAL credential needed to call the service. | Add access to provider request history if the provider offers it. Never put the FAL secret in the general journal. If exact raw headers retain it, keep that evidence in the restricted secret compartment. Record the redacted request, provider request identifier, response, and image bytes locally. |
| Data handling | No capture-specific approval exists. | Production data requires stronger review. | Approve participants, isolated spaces, captured data classes, retention, allowed investigators, export rules, and deletion policy. Encrypt identity mappings separately from pseudonymous event data. Make sensitive payloads cryptographically erasable. |

The infrastructure role declares twenty-one Toolshed processes behind Nginx,
with `/data/memory` and `/data/cache` on a persistent disk. This declaration is
useful evidence, but the live topology, storage owner, snapshot mechanism, and
backup path must be checked through the dedicated forensic access path before
either target is approved.

### Server data that must be acquired

The automated recorder should copy these before the run is considered final:

- the exact active server release artifact, browser and worker artifacts,
  source maps, pattern source, non-secret configuration, release manifest,
  executable hashes, and redacted environment hash;
- the per-space database, every sibling cell database, retained
  write-ahead-log segment, and recorder-level database journal;
- the relevant generated-image cache objects;
- every per-process forensic spool and recorder health record;
- Nginx access and error records with upstream-process identity;
- journald records for every selected process and service;
- the trace and metric slice for the capture window;
- physical, tailnet, and loopback packet files with drop counters;
- socket and process evidence;
- the final `/api/meta` response and clock-calibration record.

Cloud Logging and SigNoz copies should be exported during finalization. Their
retention periods are too short for later acquisition to be dependable.

## Capture format

### Run manifest

The coordinator creates the `captureId` before starting any participant or
server recorder. The signed run manifest contains:

- capture schema version and recorder versions;
- start and end time, time source, clock offset, and clock uncertainty;
- server Git revision, artifact digest, signature, and reported server DID;
- exact server, browser, worker, source-map, and pattern source artifacts plus
  their public content digests;
- pattern content identifier, piece identifier, space alias, and branch;
- exact non-secret configuration and enabled feature flags;
- secret names and presence flags without values or value-derived digests;
- Deno, browser, operating-system, kernel, Nginx, Tailscale, SQLite, and
  recorder versions;
- host, process, worker, browser, profile, tab, runtime, and connection
  identifiers;
- locale, time zone, display metrics, device scale, color profile, graphics
  renderer, font inventory, browser storage settings, and network interface
  state;
- participant pseudonyms and a separately encrypted mapping for every user,
  principal, home-space, profile-space, session, and other
  participant-linked DID;
- initial database and sibling-database content hashes;
- packet interfaces, snap length, offload settings, and packet-drop counters;
- every source's first and final sequence, final hash-chain value, and clean
  close state;
- content hashes for every artifact in the completed bundle.

The configuration digest is computed after every secret field is replaced by
its stable configuration-name token. Private identity keys, tailnet keys, and
archive encryption keys are never captured. Cookies, bearer tokens, and
provider authorization headers that unavoidably appear in exact plaintext
network evidence go into a separately encrypted secret compartment. The
general event journal stores only a redacted view and a restricted content
reference.

A bare hash does not safely redact a low-entropy name, vote, or prompt. Use an
opaque random identifier for a sensitive content reference. Put its plaintext
integrity digest only inside the encrypted index. The public integrity record
hashes the authenticated ciphertext. Keep public artifact hashes separate from
sensitive value identifiers.

A home-space DID is also a user DID. Recursively replace participant-linked
DIDs in general event values, protocol values, certificates, database indexes,
and causal metadata with archive-scoped aliases. Preserve the exact original
values only in the restricted encrypted mapping and payload stores. The
redacted view must not rely on recognizing only a fixed set of top-level
fields.

### Event envelope

Every source writes a strictly increasing local sequence to a durable spool.
The common envelope contains:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Version of the event type and payload contract. |
| `captureId` | Identity shared by every record in one run. |
| `sourceId` and `sourceSequence` | Stable producer identity and gap-detectable local order. |
| `wallTimeUnixNs` | Coordinated wall-clock observation in nanoseconds. |
| `monotonicTimeNs` | Producer-local monotonic time. |
| `clockUncertaintyNs` | Maximum known uncertainty for cross-host ordering. |
| `hostId`, `processId`, `threadId`, `browserId`, `tabId`, `runtimeId` | Physical and runtime origin when applicable. |
| `spaceAlias`, `pieceId`, `userAlias`, `sessionAlias`, `connectionId` | Application and storage context. Raw participant-linked DIDs and session identifiers live in the separately encrypted identity mapping. |
| `requestId`, `attemptId`, `eventId`, `actionId`, `invocationId` | Causal work identifiers. |
| `localSeq`, `commitSeq`, `traceId`, `spanId` | Existing storage and trace joins when applicable. |
| `causalParents` | Earlier event records that made this event possible. |
| `eventType` | Stable machine-readable event name. |
| `payload` or `payloadRef` | Small canonical payload or a content-addressed raw blob. |
| `contentHash` | Integrity digest of the canonical event with this field omitted and `previousHash` included. |
| `previousHash` | Per-source hash chain that detects deletion, insertion, and reordering. |
| `sensitivity` | Data-handling class used by the viewer and export tools. |

Binary protocol payloads, images, screenshots, database pages, and large values
go in an encrypted blob store. Public artifacts use their ordinary content
digest as the object name. Sensitive blobs use opaque random object names and
plaintext digests that appear only inside the encrypted index. The event
envelope points to the raw bytes. Use canonical Concise Binary Object
Representation for event segments. This avoids changing byte values through
JSON conversion.

Each producer submits events to an encrypted local append-only journal before
the coordinator receives a copy. Encryption begins with the first local write.
The journal has an explicit overloaded state that stops new work until prior
events are durable. Disk-full, serialization, sequence-gap, and fsync failures
invalidate the affected profile. The implementation must not conceal those
failures with a timeout, blind retry loop, or sleep.

On the server, a recorder sidecar owns the files and outlives individual
Toolshed processes. Each process sends sequenced events over a local channel.
An instrumented operation does not perform its externally visible effect until
the sidecar has accepted its initial record. Terminal records follow the
effect.
The sidecar records process exit and seals the last observed hash chain even
when the process crashes. A crashed application process can therefore remain a
profile-conformant captured event when every required initial and terminal
record is present. A crashed sidecar invalidates every profile that depends on
its evidence.

### Clock and ordering

Wall clocks alone cannot order concurrent work. The record uses all of:

- the source-local sequence;
- the source monotonic clock;
- causal parents;
- browser `performance.timeOrigin` and `performance.now()` calibration;
- server and client clock offset and uncertainty;
- memory local sequence and accepted server sequence;
- TCP sequence information and packet timestamps.

Logical order wins when clocks disagree. The explorer must display uncertainty
instead of inventing a total wall-clock order.

## Instrumentation to add

### 1. Capture coordinator and correlation

Add a coordinator that creates the run, writes the manifest, receives recorder
health, and finalizes the bundle. Propagate `captureId` through the shell,
worker protocol, memory WebSocket setup, HTTP headers, Toolshed request context,
memory transactions, AI requests, logs, and OpenTelemetry resource attributes.

The coordinator creates an ephemeral capture authority for the run. Each
native browser sidecar holds its own non-exportable admission key and receives
a short-lived certificate from that authority. Extend the signed
`session.open` invocation so the user signature covers `captureId`,
`recorderSourceId`, the recorder certificate digest, and the server challenge.
The sidecar adds a second signature over the same fields, the user DID, allowed
spaces, recorder artifact digest, and expiration. The server verifies the
capture-authority certificate, both proofs, the active coordinator registry,
and current recorder health before admitting the session. It records the
verified fields and certificate serial without recording either private key.

Mint stable identifiers for browser, tab, runtime, connection, user event,
scheduler action, request, and external call. Preserve the existing space,
session, local-sequence, commit-sequence, trace, and span identifiers.

Carry capture identifiers in transport and recorder metadata. Do not put them
in lunch poll cells or use them to derive entity identities. Instrumentation
must not change the application's durable data model.

Add the HTTP request identifier to the response and request context. Do not use
the current private Pino identifier as an implicit correlation key.

### 2. Browser main-thread recorder

Use two distinct input boundaries.

The native controller owns physical input for a full-forensic run. It durably
records an approved pointer, keyboard, paste, resize, or navigation input
before delivering that input to the browser. This record describes controller
input. It is not a browser event.

After the browser dispatches an event, the page records the canonical Common
Fabric `SerializedDomEvent` before forwarding it to the worker. This is the
authoritative application-causal input. Record normalized target identity,
coordinates, key state, approved field value, selection, form state, and the
event's causal identifier. Also record relevant online, offline, visibility,
page lifecycle, history, application storage, error, rejection, and resource
failure events.

Run each participant in a dedicated, ephemeral browser profile with no prior
history, cookies, passwords, or unrelated extensions. Capture paste contents
only when the lunch poll receives them in an approved application field. Do
not monitor the system clipboard. Physical input recording is an additional
full-forensic source, not a substitute for the serialized application event.

Record after each render boundary:

- a stable render identifier;
- Document Object Model mutations or a deterministic patch from the prior
  checkpoint;
- a full periodic Document Object Model checkpoint;
- computed state and layout content hashes;
- a timestamped screen recording;
- a screenshot at interaction and error boundaries.

Record every main-thread and worker message in both directions before sending
and immediately after receiving. Browser worker messages use structured clone,
which does not define one canonical wire encoding for arbitrary objects.
Record the canonical, type-aware message value and transfer-list metadata.
Store exact bytes only for strings, byte arrays, and other byte-oriented
protocol values.

The current initialization message contains serialized identity key pairs,
including private signing material. The capture hook must project this message
through a schema-specific redactor before the generic recorder sees it.
Replace each `identity` and `spaceIdentity` value with an opaque capability
reference and its public DID. The generic message encoder must never receive
the serialized key pair. Client re-execution uses a replay signer that reports
the original public DID. It returns a captured signature only when the input
exactly matches the next captured signing input. A new or reordered signing
request is a divergence. The replay signer contains no private key.

Use the Chrome DevTools Protocol to record requests, responses, redirect and
cache decisions, reported WebSocket payloads and opcodes, service-worker
participation, and browser process metadata. Chrome DevTools Protocol does not
expose original WebSocket masking keys, fragmentation, or every wire header.
The existing browser OpenTelemetry provider remains a searchable timing view,
not the source of truth.

Page JavaScript cannot fsync an arbitrary local file. The full forensic profile
therefore requires a controlled browser launched with a native recorder
sidecar. If the durable channel disconnects, the controller blocks further
input. If an already-dispatched browser event cannot be persisted before it is
forwarded to the worker, the application-causal profile becomes invalid.
Direct input to an unmanaged browser cannot provide this ordering. An ordinary
participant browser with only the current debugger cannot meet the full
profile.

### 3. Worker and runtime recorder

Promote the existing telemetry and diagnostic events into a lossless journal.
Remove the fixed-size rings as the only copy of evidence during capture mode.

For every user event and scheduler action, record:

- the event value and durable event identifier;
- queue position, causal parent, and dispatch order;
- every reactive and storage read with address, value or content reference,
  basis sequence, and read kind;
- declared writes and actual writes with before and after values;
- graph dependency additions, removals, invalidations, and scheduling choices;
- optimistic application, settlement, render notification, rollback, retry,
  and terminal outcome;
- storage push, server response, pull, subscriber update, and local
  integration;
- exception type, stack, and affected action;
- the full runtime graph at regular checkpoints.

Capture every nondeterministic input that can affect behavior:

- event-bound time and `#now` wish results;
- `Date`, monotonic time, locale, and time-zone results used by application
  code;
- random and UUID results;
- fetch responses and transport errors;
- wish and model results;
- timer registration and firing;
- observable ordering between microtasks, task queues, messages, and animation
  frames.

Capture mode must route every behavior-affecting source through a fail-closed
registry. This includes the current `sandboxDateNow`, `sandboxRandom`, and
gated fetch functions. It also includes `#now`, runtime UUID and event
identifiers, storage session identifiers, scheduler clocks, backoff
randomness, timers, and any direct `Date`, `performance`, `Math.random`, or
`crypto` result that can change execution. Each gate records its call site,
call order, input, result, and causal parent. Timing-only observations are
recorded for the timeline but are labeled as non-replay inputs.

Add a source check that rejects behavior-affecting direct calls outside this
registry. At finalization, compare every gate's invocation counter with its
journal records. The profile conformance verifier rejects a run with an
unregistered source, a counter mismatch, or a missing result.

Use the current builtin replayability registry as a fail-closed checklist.
Every invocation of a builtin that is not proven replayable must have an input,
output or error, and causal-order record. The profile conformance verifier
rejects an application-causal bundle with an unrecorded non-replayable
invocation.

Do not capture cryptographic private-key material. Record each signing input,
materialized signed result, and public identity in the restricted payload
store so the identity-preserving replay signer can serve only captured
operations.

### 4. Memory protocol and rejection journal

At both client and server boundaries, record:

- connection open, authenticated identity, challenge, response, close code,
  and close reason;
- every inbound and outbound WebSocket memory message as a canonical,
  recursively aliased decoded value;
- exact encoded memory-message payload bytes in the restricted
  network-payload compartment;
- parsed message type, schema version, and stable attempt identifier;
- server receipt time, validation phases, and response send time;
- subscriber setup, watch changes, refresh, fan-out recipients, and exact sync
  bodies.

Create an append-only server attempt journal that is separate from accepted
commit history. The client mints an attempt identifier in the outer protocol
envelope before sending a request. The server journals the encoded message
payload and a server-receipt identifier before parsing it. A valid envelope
carries the client attempt identifier into every later server record. A
malformed envelope uses the server-receipt identifier and joins to the client
payload by connection, message order, and raw-payload digest. Every start,
response, rejection, disconnect, and terminal marker carries the applicable
attempt identifier. It also carries the session identifier or an explicit
`unauthenticated` value. Its terminal record distinguishes:

- accepted;
- conflict;
- failed precondition;
- authorization rejection;
- row-label rejection;
- malformed protocol;
- server error;
- disconnected before response;
- accepted but response delivery unknown.

Write the initial attempt record to the per-process forensic spool before
acting on the message. Write the terminal record after the outcome is known.
An initial record without a terminal record is then evidence of interruption,
not a vanished request. Do not add capture bookkeeping to the per-space
transaction database, because additional database locks would change the
behavior being observed.

For a conflict or precondition failure, record the exact read, entity, path,
scope, supplied basis, current basis, conflicting accepted commit, winning
session and principal, response payload, client retry decision, and eventual
terminal attempt. Values may use encrypted content references when direct
inline storage would be unsafe.

Accepted commits keep using the existing `commit` and `revision` tables. The
attempt journal joins to them by `captureId`, space, session, local sequence,
attempt identifier, and accepted commit sequence.

The current protocol messages can contain a reusable `sessionToken`. The
general journal replaces it with a run-scoped token alias. Exact encoded
message payloads are encrypted from their first write, kept under a stricter
access policy, and given a shorter approved retention than ordinary
application evidence. The coordinator closes every captured session and
revokes any still-usable captured authorization material at finalization. A
run that cannot prove that revocation cannot retain raw protocol payloads.

Add a capture-finalization control operation that is authenticated by the
ephemeral capture authority and is unavailable on the ordinary public memory
route. It closes capture admission, enumerates every run session on every
Toolshed process, writes a shared revocation tombstone for every resume token,
removes the sessions from each registry, and returns one signed receipt per
process generation. A tombstone stores a server-keyed token digest, capture
identifier, revocation time, and expiration. It remains available to every
Toolshed process and survives restarts for at least as long as the raw payload
retention.

Change session opening so a supplied `sessionToken` is always a resume request.
It succeeds only when the named resumable session exists and the token matches.
A missing session, mismatched token, or revocation tombstone returns a typed
token error. A fresh session must omit the token. This prevents a removed token
from being accepted as a fresh open.

The receipt contains only token aliases, tombstone digests, and count digests.
The verifier checks all receipts and tombstones. It also tries each original
token once through a restricted, controlled client and records only its alias
and typed failed-resume result. Both checks must pass before the raw payload
compartment can be retained.

Enforce the capture boundary during `session.open`. A session that can reach a
captured space must present the active `captureId`, the coordinator-issued
recorder certificate, and the sidecar's challenge-bound proof of possession.
The user's signed invocation binds the same capture metadata. Reject and
journal any uninstrumented session before it can read or write the space. The
conformance verifier checks both signature chains and compares admitted
sessions with the coordinator, browser, and server recorder inventories.

### 5. Database recorder

Capture database behavior at three levels.

**Logical memory level**

- Record every engine read, query, watch, write attempt, transaction boundary,
  accepted operation, rejected operation, and returned value.
- Preserve exact parameters and content-addressed results.
- Record the SQLite connection and transaction identity.

**SQL level**

- Record each prepared statement, bound parameter, result row, error, and
  transaction boundary for the main database and every sibling cell database.
- Record every result from SQLite time and random functions. This includes the
  schema's current `datetime('now')` defaults and any use of
  `CURRENT_TIMESTAMP`, `random()`, or `randomblob()`.
- Redact only through encrypted payload separation. A replay needs the original
  value, not a log-line summary.

**File level**

- Take verified, coordinated initial and final snapshots of the main database,
  every sibling `cell-*.sqlite` database, and every transitive profile or home
  space admitted to the database-internals boundary.
- Preserve write-ahead-log records before a checkpoint can recycle them.
- Record database open, close, read, write, sync, truncate, rename, and
  checkpoint operations through a capture-aware SQLite virtual file system.
- Include file offsets, byte counts, result codes, and content references for
  changed pages.
- Record every SQLite virtual-file-system time and randomness callback in call
  order. The replay virtual file system returns those captured values.
- Start the capture-aware virtual file system before any selected Toolshed
  process opens a database.
- Override the engine's current 256-mebibyte SQLite memory-map setting with
  `mmap_size=0` before the first access. Verify the effective setting on every
  connection. Pager instrumentation is required if memory mapping cannot be
  disabled.

The initial and final database sets need one coordinated quiescence barrier
across all selected Toolshed processes. The coordinator blocks new
transactions on existing sessions and stops new session admission. Every
process explicitly acknowledges that it has no active database transaction.
The coordinator then preserves write-ahead logs and copies every main and
sibling database while writes remain blocked. Sequential `VACUUM INTO` calls
without this barrier can combine files from different logical moments. A
storage-level snapshot is acceptable only after the same barrier and after its
crash-consistency semantics have been verified.

The virtual file system record is required for the literal claim of every
database file read and write. Logical and SQL records remain the authoritative
application explanation. Operating-system call tracing alone cannot explain
which application value a page represented.

### 6. Endpoint process and operating-system recorder

On both every controlled browser host and the server, record:

- service start, stop, crash, restart, signal, and core-dump metadata;
- executable digest, arguments, environment hash, user, group, and working
  directory;
- process, thread, file-descriptor, and socket lifecycle;
- CPU, memory, disk, network, and event-loop state at a fixed observed cadence;
- DNS request and response bytes;
- extended Berkeley Packet Filter socket state, retransmission, loss, and
  process ownership events.

The browser-host record includes the native controller, recorder sidecar,
browser process tree, worker processes, local proxy when used, DNS resolver,
network interfaces, sockets, and recorder-health transitions. Use a dedicated
capture endpoint that runs no unrelated participant applications. The
server-host record additionally includes systemd, Tailscale, Nginx, every
selected Toolshed process, the OpenTelemetry collector, database acquisition,
archive upload, deployment events, and Nginx's selected upstream process.

Instrument every server clock and random-value source used for a connection,
request, challenge, session, token, identifier, expiry, or database operation.
Record the call site, call order, input, and returned value. Capture mode must
route these sources and SQLite's time and randomness callbacks through one
fail-closed registry. Server replay supplies the recorded streams in the same
order. An unregistered call invalidates exact server replay.

The VM currently restarts Toolshed automatically. A restart must become an
explicit causal event in the capture rather than an unexplained gap.

### 7. Packet capture

Packet evidence needs multiple observation points because encryption hides the
application protocol:

1. Capture the browser machine's relevant network interface.
2. Capture the server's physical interface for outer Tailscale WireGuard
   traffic and ordinary egress.
3. Capture `tailscale0` for decrypted tailnet Internet Protocol traffic.
4. Capture loopback for Tailscale Serve, Nginx, Toolshed, the local
   OpenTelemetry collector, and other local hops.
5. Capture provider egress, including DNS and the encrypted FAL and image
   download connections.

The lunch poll's TCP and WebSocket traffic is inside the tailnet tunnel. The
physical interface can instead show encrypted WireGuard datagrams or relay
traffic. Both views are required to connect an application message to its inner
TCP segments and its outer transport.

Write rotating packet-capture next-generation (`pcapng`) segments with capture
interface metadata, kernel drop counters, user-space drop counters, filter
definition, snap length, and content hashes. Record network offload settings
because a host-side capture can observe a packet before the network card fills
its checksum or after the kernel has combined several wire segments. Disable
checksum, segmentation, and receive offload for the isolated capture
interfaces. If that is unsafe, use a mirrored physical capture point and mark
the host capture as a logical packet view. If exact endpoint comparison
matters, capture both endpoints. An endpoint cannot observe a packet that
disappears inside an intermediate router. Two endpoint captures can prove
which packets one endpoint sent and the other endpoint did not receive. They
do not record the private state of every router in between.

Packet capture does not reveal HTTPS or WebSocket Secure plaintext. The
application record and Chrome DevTools Protocol provide memory-message
payloads, not original wire framing. Exact WebSocket headers, masks,
fragmentation, and control frames require a plaintext capture below the
WebSocket implementation or Transport Layer Security key logs plus TCP and
WebSocket reassembly. The full-forensic profile requires one of those sources
at each encrypted browser endpoint. Store key logs in a separately encrypted
compartment. Do not extract or archive Tailscale private keys.

Outer Tailscale capture can include traffic unrelated to the lunch poll,
especially when a relay or shared peer path multiplexes flows. Use a dedicated
Rapids capture window and controlled participant machines. Production capture
on Estuary needs an explicit over-capture review or an isolated host. A
`captureId` can filter decrypted application evidence, but it cannot filter
encrypted outer packets after the fact without first retaining them.

### 8. External AI and cache recorder

Give every image request an external-call identifier. Record:

- the normalized prompt and request options;
- the request body after secret removal;
- cache lookup key and decision;
- provider request identifier, status, headers, and response body;
- image download request, response, and exact bytes;
- cache write, cache read, and stored option content hash;
- errors and cancellation.

Offline replay never calls FAL. It serves the recorded response and bytes at
the recorded causal point.

Do not retain a live provider credential merely to preserve an exact header.
Store its alias in the general record. If a restricted transport record
unavoidably exposes a long-lived provider or browser credential, rotate or
revoke that credential during finalization and archive the verification
receipt. Destroy that raw record when immediate rotation is unavailable.

### 9. Archive and integrity

Store the completed run as:

```text
<captureId>/
  capture.json
  manifest/
    deployment.json
    clocks.json
    participants.encrypted
  artifacts/
    server/
    browser/
    worker/
    source-maps/
    pattern/
    configuration/
  events/
    <sourceId>/<segment>.cbor
  blobs/
    public/<content-digest>
    opaque/<random-object-id>
  browser/
    dom/
    screenshots/
    devtools/
  database/
    initial/
    final/
    wal/
    vfs/
  network/
    browser/
    server-physical/
    server-tailnet/
    server-loopback/
  logs/
  indexes/
  conformance.json
  checksums.txt
  signature
```

Upload each closed segment to a versioned store while the run continues. Keep
the encrypted local copy until final verification. Sign the completed manifest
and checksum list.

Separate archive policy by data class:

- Retention-lock the signed manifest, public artifact digests, encrypted
  payload ciphertext digests, source sequence ranges, gap reports, checksums,
  and signatures. This integrity record proves what existed without exposing
  low-entropy plaintext digests or retaining the sensitive bytes forever.
- Keep application values, database contents, images, screenshots, packet
  payloads, and identity mappings in a separately encrypted store with an
  approved finite retention. Make its per-run encryption key destroyable.
- Keep raw authorization-bearing message payloads and Transport Layer Security
  key logs in a still narrower compartment with the shortest useful
  retention.
- Keep public release artifacts and source maps for as long as the replay
  support policy requires.

Do not apply an indefinite retention lock to sensitive payloads. A finite
payload lock is permitted only when policy names the data class and expiration
before capture begins. Deleting a payload must leave the signed integrity
record and a signed deletion receipt.

Cloud Logging and SigNoz receive indexes and summaries for convenient search.
The signed integrity record and the retained encrypted payloads are
authoritative for their respective claims.

The verifier and explorer open evidence read-only. Replay copies the initial
databases and required blobs into a scratch workspace before execution. No tool
opens an archived database for writing or adds derived indexes to a finalized
bundle.

## Tools to build

### Capture controller

Add a `cf forensic capture` operator command that:

- creates the run and manifest;
- preflights every required recorder and permission;
- verifies isolated spaces, dedicated browser profiles, and admission policy;
- verifies reserved local and archive capacity for event, database, screenshot,
  and packet data;
- starts database, packet, host, server, and browser recorders in dependency
  order. The selected Toolshed processes start only after the database recorder
  is active;
- displays recorder health and sequence progress;
- refuses to label a profile conformant when any required source has a gap;
- finalizes snapshots, packet files, hashes, signatures, and upload;
- produces `conformance.json`.

It must use explicit source state and acknowledgements. It must not decide that
a recorder is healthy because a fixed wait expired without an error.

### Profile conformance verifier

Add `cf forensic verify <bundle>` before building the viewer. It checks:

- signature and content hashes;
- recursive participant-linked DID leak checks over the general journal,
  manifest, indexes, and redacted exports;
- exact captured release, browser, worker, source-map, pattern, and non-secret
  configuration artifacts;
- the selected profile and its complete required-source inventory;
- source sequence gaps, duplicate events, and broken source hash chains;
- event-schema validity;
- clock calibration and declared uncertainty;
- packet and kernel drop counters when the network-and-host profile is
  selected;
- browser-host and server-host process, socket, DNS, recorder, and packet
  source inventories;
- browser and server recorder start and stop boundaries;
- both signature chains on every capture admission against the coordinator,
  client, recorder, and session inventories;
- boundary violations and unexpected cross-space reads;
- behavior-affecting client, server, and SQLite nondeterminism gate counters
  against their captured values;
- a stable client-attempt or server-receipt identifier on every protocol
  marker, plus a session identifier or explicit unauthenticated marker;
- one coordinated snapshot barrier and complete initial and final database sets
  for every selected and transitive space;
- replayed accepted commits against the final memory database;
- sibling SQLite database coverage;
- client outbound canonical protocol values against server inbound values;
- server outbound canonical protocol values against client inbound values;
- reconstructed WebSocket wire frames against plaintext TCP streams where the
  captured hop is below the WebSocket implementation;
- encrypted endpoint stream timing, direction, and sizes against packet
  evidence when Transport Layer Security session secrets were not captured;
- reconstructed WebSocket wire frames against encrypted endpoint streams only
  when the restricted Transport Layer Security key log is present;
- a plaintext-below-WebSocket source or Transport Layer Security key log for
  every encrypted browser endpoint in the full-forensic profile;
- shared token tombstones, signed session and credential revocation receipts,
  and controlled typed failed-resume results before retaining
  authorization-bearing payloads;
- every protocol request has a terminal outcome or an explicit disconnect;
- every external response has its referenced bytes;
- every blob reference exists;
- archive object count and size against the local spool.

The verifier emits one result for each selected profile. A result is either
“profile-conformant with no detected gaps inside the enforced boundary” or
“not conformant,” followed by the detected gaps and untested claims. The full
forensic result is conformant only when all four component profiles are
conformant. The tool never shortens this to an unqualified claim that the run
captured everything.

### Causal timeline explorer

Build a local web explorer over a verified bundle. Its main view has aligned
lanes for:

- each browser's raw interaction and rendered interface;
- main-thread and worker messages;
- scheduler events and actions;
- storage attempts and optimistic state;
- application WebSocket messages and reconstructed wire frames;
- Nginx and Toolshed handling;
- database transactions and file activity;
- subscriber fan-out;
- AI provider and cache activity;
- sockets and packets.

Selecting an item shows exact inputs, reads, writes, before and after values,
causal parents, source code location, trace spans, logs, database rows, and
packet ranges.

The explorer opens in a redacted mode. Decrypting application payloads,
identity mappings, raw authorization-bearing message payloads, or Transport
Layer Security key logs requires a separately authorized credential and
creates an audit record. Minimal-reproduction export applies the same policy
and never exports live credentials.

Required focused views are:

- a conflict explorer that shows loser, winner, read basis, changed path,
  response, retry chain, and final outcome;
- a transaction viewer that separates computed reads, storage reads, declared
  writes, actual writes, optimistic writes, and durable writes;
- a scheduler graph view that reuses current action, trigger, dependency, and
  write-stack diagnostics;
- a state-at-time and state-diff view that reuses state-inspector
  reconstruction;
- a rendered-interface replay with event stepping and screenshots;
- a SQL view with statements, parameters, rows, transaction boundaries, and
  owning action;
- a protocol view with decoded memory messages, exact encoded message payloads,
  and reconstructed wire framing when the required packet evidence exists;
- a packet link that opens the corresponding `pcapng` stream in Wireshark or
  `tshark` instead of rebuilding a packet analyzer;
- a comparison view for two runs;
- an export that produces the smallest self-contained reproduction around a
  selected conflict or divergence.

Keep `cf inspect` read-only and accepted-state-focused. Reuse its database
decoder, reconstruction oracle, graph model, and HTML techniques from a new
forensic package. Do not turn state inspector into an execution engine.

Reuse `lunch-poll-diagnose.ts` as the starting scenario driver for the Rapids
rehearsal. Extend its cases and make the capture controller own its output. Do
not treat its current aggregate logger counts as the conflict record.

### Client re-execution and server replay

These are different tools with different claims.

Add `cf forensic replay-client <bundle>`. It starts the captured shell and
worker artifacts in an isolated browser. Replay-only `identity` and
`spaceIdentity` facades report their original public DIDs. Their signing
methods serve only the captured input-and-signature sequence. Recorded sources
supply time, randomness, UUIDs, locale, time zone, wishes, external responses,
scheduling inputs, and server protocol outcomes. The controller drives the
recorded application events in causal order. The replay network namespace can
reach only the bundle's adapters. It cannot contact a live service.

This mode checks Common Fabric decisions. It is guided client re-execution,
not exact browser-engine replay. After each event it compares:

- runtime read and write sets;
- scheduler action and invalidation order;
- outbound protocol values and recorded server outcome;
- durable and optimistic state content hashes;
- rendered Document Object Model content hash;
- a screenshot when one exists.

Add `cf forensic replay-server <bundle>`. It starts the exact captured server
release and non-secret configuration in an isolated network. It copies the
coherent initial main and sibling databases for every captured space into a
scratch workspace. It supplies recorded server time, randomness, external
effects, session challenge inputs, session identifiers and tokens, and SQLite
time and randomness callbacks through explicit replay adapters. It then drives
the recorded `session.open` exchange and later client protocol requests
through the real server implementation. The captured signed exchange is
verified against its public identity. No private key is needed.

Some environment-bound authorization material may be impossible to validate
outside its original control plane. A separately named authorization-isolation
mode may inject the recorded principal at that boundary. Its report must mark
authorization as substituted. It cannot claim that authentication or
authorization replayed.

Server replay compares:

- parse and validation decisions;
- logical and SQL reads;
- accepted and rejected outcomes with their structured causes;
- assigned commit sequences and subscriber fan-out;
- response and synchronization values;
- final main and sibling database contents.

A combined comparison can feed server-replay responses into client
re-execution. A recorded-response adapter is never presented as server replay.
The exact server artifacts and coherent initial database set are mandatory for
the server command.

Reuse the current traversal replay harness's oracle pattern for deterministic
subsystem checks. Do not carry over its first-value-wins document corpus,
invocation cap, or unload-based persistence into the forensic recorder.

Both commands stop at the first unexplained divergence and show the two causal
histories. Guided browser differences are labeled separately from Common
Fabric decision differences. Continuing past a divergence is an explicit
investigator action and never changes the first-divergence report.

## Delivery plan

Every infrastructure change in these stages must land in the infrastructure
repository before it is applied to a live host.

### Stage 0: settle policy and access

- [ ] Approve the four claim profiles, participant consent, each data class's
      retention, and investigator access.
- [ ] Reserve isolated poll, profile, and home spaces for the run.
- [ ] Prepare dedicated, ephemeral participant browser profiles and controlled
      endpoints.
- [ ] Verify Rapids and Estuary SSH host fingerprints through a trusted source.
- [ ] Provision a short-lived forensic SSH identity and narrowly scoped
      capture commands. Do not reuse a deployment key.
- [ ] Add a dedicated forensic DID to the Rapids dump allowlist.
- [ ] Define Estuary's approved database and sibling-database acquisition path.
- [ ] Authenticate GitHub access and verify deployment environment metadata.
- [ ] Provision a read-only SigNoz API identity.
- [ ] Create the retention-locked integrity store and separately encrypted,
      finite-retention payload stores.
- [ ] Measure a worst-case rehearsal and reserve local and archive capacity.
- [ ] Identify Estuary's current host, backup source, and infrastructure owner.

### Stage 1: format, identifiers, and server attempt journal

- [ ] Define and test the manifest, event envelope, blob format, and
      profile-conformance contract.
- [ ] Alias every participant-linked DID in the general journal and keep the
      reversible mapping in the restricted identity compartment.
- [ ] Add `captureId` and stable causal identifiers across shell, worker,
      storage, Toolshed, logs, AI calls, and OpenTelemetry.
- [ ] Add the ephemeral capture authority, sidecar admission keys, signed
      `session.open` capture proofs, gate, and boundary-violation journal.
- [ ] Put a stable client-attempt or server-receipt identifier on every attempt
      record. Put a session identifier or explicit unauthenticated marker on
      every terminal record.
- [ ] Persist canonical protocol values, restricted encoded message payloads,
      and every terminal attempt.
- [ ] Add the capture-finalization session and token revocation operation,
      shared persistent tombstones, resume-only token semantics, signed
      per-process receipts, and controlled failed-resume verification.
- [ ] Persist structured conflict and precondition details.
- [ ] Build `cf forensic verify` before depending on new evidence.

### Stage 2: browser and runtime recording

- [ ] Add the native input controller and the serialized application-event,
      render, lifecycle, and worker-message recorder.
- [ ] Add type-aware worker-message capture with private-key-pair projection.
- [ ] Add identity-preserving `identity` and `spaceIdentity` replay facades
      that can serve only captured signatures and cannot reach live services.
- [ ] Add Chrome DevTools Protocol network and WebSocket recording.
- [ ] Persist all runtime telemetry, action, trigger, dependency, and
      write-stack events without ring truncation.
- [ ] Capture nondeterministic inputs and exact runtime values.
- [ ] Route every behavior-affecting clock, random, UUID, fetch, and scheduling
      source through the fail-closed capture registry.
- [ ] Add recorder overload handling and an explicit invalid-run state.

### Stage 3: database, host, and packet recording

- [ ] Add logical engine read and write records.
- [ ] Add SQL statement, parameter, result-row, and transaction records.
- [ ] Route server and SQLite time, randomness, challenge, identifier, session,
      and token sources through captured replay streams.
- [ ] Start a capture-aware SQLite virtual file system before any selected
      database opens and verify that memory mapping is disabled.
- [ ] Add the cross-process quiescence barrier and capture coherent initial and
      final main, sibling, and transitive-space database sets.
- [ ] Capture and verify write-ahead logs.
- [ ] Land infrastructure changes for packet tools, privileges, socket
      evidence, and evidence upload.
- [ ] Capture the native controller, browser process tree, browser-host
      sockets, DNS, recorder lifecycle, and health.
- [ ] Capture browser, server physical, tailnet, and loopback interfaces.
- [ ] Capture or reconstruct WebSocket wire framing below the encrypted browser
      endpoint.
- [ ] Export packet-drop, network-offload, process, socket, and service events.

### Stage 4: external calls, explorer, and replay

- [ ] Capture FAL calls, image downloads, cache decisions, and exact bytes.
- [ ] Rotate any long-lived credential exposed to restricted transport
      evidence and archive the verification receipt.
- [ ] Build the indexed causal timeline.
- [ ] Build conflict, transaction, scheduler, state, SQL, protocol, and packet
      views.
- [ ] Build guided client re-execution and real server replay as separate
      commands.
- [ ] Build first-divergence reporting and minimal reproduction export.
- [ ] Add run comparison.

### Stage 5: Rapids rehearsal

Run a controlled capture with at least two browsers and cover:

- [ ] concurrent votes on one option;
- [ ] concurrent option add and remove operations;
- [ ] whole-array join, visit, reset, and clear operations;
- [ ] a deliberately stale read and rejected conflict;
- [ ] an authorization or row-label rejection;
- [ ] generated art with a cache miss and cache hit;
- [ ] browser offline, reconnect, reload, and crash;
- [ ] one Toolshed process crash and subscriber recovery;
- [ ] a proxy connection close during a commit;
- [ ] enough activity to exceed every old in-memory diagnostic ring;
- [ ] initial and final database acquisition;
- [ ] packet capture with zero unexplained drops;
- [ ] measured behavior and resource use with capture disabled and enabled;
- [ ] successful client re-execution and server replay with matching Common
      Fabric decisions and durable state;
- [ ] a deliberately damaged bundle that the profile conformance verifier
      rejects;
- [ ] separate conformance results for all four profiles and the composite
      full-forensic claim.

Only after this rehearsal passes should the same capture profile be approved
for Estuary.

## Required gate before the next observed deployment

The present system does not pass this gate. A deployment described as fully
forensic must satisfy every item:

- The exact server, browser, worker, and pattern artifacts are hashed and in the
  archive. Their hashes are in the signed manifest.
- The captured poll space is isolated. Every transitive profile and home space
  is either captured or represented by an approved external-result record for
  the selected profile.
- Every browser participant runs the recorder from before navigation through
  final shutdown in a dedicated, ephemeral profile.
- Every `session.open` carries valid, challenge-bound user and sidecar
  signatures chained to the ephemeral capture authority.
- The memory admission gate rejects and journals every uninstrumented session.
- Server protocol and attempt journals are durable before requests are acted
  on.
- Every attempt and terminal marker has its stable attempt identifier and
  session identifier or explicit unauthenticated marker.
- Rejected conflicts and preconditions contain exact structured cause data.
- Main, sibling, and transitive-space databases have coordinated, verified
  initial and final snapshots.
- SQL and database file activity is captured for the full forensic profile.
- Every behavior-affecting browser, runtime, server, and SQLite time or random
  source is present in its fail-closed registry and journal.
- Browser-host and server-host process, socket, DNS, recorder, and health
  inventories are complete.
- Browser, outer server, tailnet, and loopback packet sources are active.
- Every encrypted browser endpoint has the evidence needed to reconstruct
  WebSocket wire framing.
- Packet and event drop counters are zero for the profile that requires them.
- Clock offsets and uncertainties are recorded.
- AI requests, results, downloads, and cache bytes are archived.
- Raw session-token-bearing message payloads are isolated, encrypted, and
  scheduled for short retention. Shared tombstones, signed per-process
  receipts, and typed failed-resume checks prove that captured sessions and
  authorization material were revoked at finalization.
- Any long-lived provider or browser credential exposed to a restricted raw
  record has a verified rotation receipt. Otherwise that raw record was
  destroyed.
- Every source journal is copied into the encrypted payload store and
  hash-verified. Its signed integrity record is retention-locked.
- `cf forensic verify` passes.
- The Rapids multiplayer, conflict, reconnect, crash, AI, client
  re-execution, and server replay rehearsal has already passed with the same
  recorder versions.
- An investigator can open one conflict in the explorer and follow it from the
  user's input through runtime reads, server rejection, packets, retry, durable
  commit, fan-out, and rendered result.

If a required recorder fails during the run, the coordinator must stop the
observed exercise or permanently mark each affected profile not conformant.
Continuing is acceptable for service availability. It is not acceptable
evidence for a full-forensic claim.

## Existing timing and retry mechanisms found during research

The current source contains timing-based behavior that can both cause
flakiness and hide causal evidence:

- `packages/patterns/integration/lunch-poll-vote.test.ts` polls with a
  sixty-second timeout and a 500-millisecond delay.
- the browser non-idempotence detector defaults to a fixed five-second
  observation window;
- generated-art coordination uses a thirty-second mutex timeout;
- traversal capture flushes every thirty seconds and drops invocations after a
  fixed default cap;
- storage uses thirty-second connection and conflict-read-repair timeouts;
- scheduler storage and convergence code has retry limits, exponential
  backoff, and initial-sync hold timeouts;
- memory subscriber fan-out waits for connection queues with a deadline and a
  minimum 500-millisecond timer;
- the VM role uses systemd restart delays and start timeouts;
- the Tailscale health task sleeps and restarts the service;
- proxy and health checks use several fixed timeouts.

These mechanisms are outside the instrumentation change, but they should not
remain invisible. Start a dedicated cleanup agent to replace them with
event-driven state transitions and explicit terminal failures. Review each
change independently because some production restart behavior may represent a
service policy rather than an implementation retry.

## Source map

The principal current implementation sources are:

- lunch poll behavior:
  `packages/patterns/lunch-poll/`,
  `packages/patterns/integration/lunch-poll-vote.test.ts`,
  `packages/patterns/tools/lunch-poll-diagnose.ts`;
- browser integration probes:
  `packages/patterns/integration/cfc-browser-helpers.ts`,
  `packages/integration/shell-utils.ts`;
- runtime events and OpenTelemetry bridge:
  `packages/runner/src/telemetry.ts`,
  `packages/runner/src/telemetry-otel-bridge.ts`,
  `packages/runner/src/storage/telemetry.ts`,
  `packages/runner/src/storage/v2.ts`;
- worker processing and diagnostics:
  `packages/runtime-client/backends/runtime-processor.ts`,
  `packages/runtime-client/runtime-client.ts`;
- shell debugger and browser tracing:
  `packages/shell/src/lib/debugger-controller.ts`,
  `packages/shell/src/lib/otel.ts`,
  `packages/shell/src/views/DebuggerView.ts`,
  `packages/shell/src/views/RootView.ts`;
- durable memory and server spans:
  `packages/memory/v2/engine.ts`,
  `packages/memory/v2/server.ts`;
- Toolshed tracing, logging, protocol, dump, and AI:
  `packages/toolshed/lib/otel.ts`,
  `packages/toolshed/middlewares/opentelemetry.ts`,
  `packages/toolshed/middlewares/pino-logger.ts`,
  `packages/toolshed/routes/storage/memory/`,
  `packages/toolshed/routes/ai/img/`;
- accepted-state analysis:
  `packages/state-inspector/`;
- local Deno CPU profiling:
  `packages/cli/support/profiling/`;
- traversal capture and replay:
  `packages/runner/src/traverse-recorder.ts`,
  `packages/runner/test/traverse-replay/`;
- static builtin replayability classification:
  `packages/runner/src/builder/builtin-replayability.ts`;
- Estuary and Rapids workflow:
  `.github/workflows/deno.yml`,
  `.github/workflows/deploy-production.yml`.

Point-in-time host and telemetry evidence was also checked against the separate
infrastructure repository, including `ansible/rapids-inventory.ini`,
`ansible/estuary-inventory.ini`, the `toolshed`, `nginx`, `tailscale`,
`ops-agent`, and `otel-collector` roles, and the SigNoz ClickHouse manifests.
