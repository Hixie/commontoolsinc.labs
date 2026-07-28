---
status: historical
created: 2026-07-27
archived: 2026-07-27
reason: "Point-in-time audit of lunch poll instrumentation, deployed telemetry, and sanitized forensic-access status used to write the live capture and replay plan."
---

# Lunch poll forensic instrumentation audit

This is a frozen audit snapshot. It describes evidence gathered on
2026-07-27. It must not be treated as the current deployment state.

The live requirements and implementation plan are in
[Lunch poll forensic capture and replay](../plans/lunch-poll-forensic-capture-and-replay.md).

## Scope

The source audit used `upstream/main` at
`a52f37cfe12249e694f3aa1dc3d1e036551e6c00`. It covered the lunch poll,
browser shell, runtime worker, scheduler, memory client and server, SQLite
engine, Toolshed routes, deployment workflows, state inspector, diagnostics,
and instrumentation.

The live audit queried Rapids, Estuary, Cloud Logging, and the shared SigNoz
trace store. It also inspected the infrastructure definitions for Toolshed,
Nginx, Tailscale, the Google Ops Agent, the OpenTelemetry collector, and
SigNoz retention.

No secret value was copied into this audit or the live plan. Exact workstation
security posture, private-key locations, identity allowlists, and broad
infrastructure permissions were deliberately excluded.

## Endpoint results

| Check | Rapids | Estuary |
| --- | --- | --- |
| Environment | Staging | Production |
| Reported Git revision | `a52f37cfe12249e694f3aa1dc3d1e036551e6c00` | `3534ff0fc26c34f9a614fb8186d61a0865814c81` |
| Memory server spans | Current `memory.*` spans were present | Current `memory.*` spans were present |
| Browser storage spans | Sparse and discontinuous | Sparse and discontinuous |
| Unsigned remote memory dump | `401`, confirming that the route was mounted | `404`, because the production route was disabled |
| Signed remote memory dump with the audited operator identity | `403`, because the identity was not allowed | Not attempted because the route was disabled |

The trace queries found sustained server transaction telemetry on both
targets. They did not find continuous browser-side storage telemetry. The
deployed instrumentation could explain portions of server performance. It
could not reconstruct a complete interaction.

## Retention observed

| Evidence | Retention or limit |
| --- | --- |
| Core SigNoz traces | Fifteen days |
| Derived SigNoz `span_attributes` rows | Two days |
| Cloud Logging `_Default` bucket | Thirty days |
| Journald | Fourteen days and 2 GB |
| Nginx local rotations | Seven rotations |
| VM release directory | Eight releases in the infrastructure definition |

These systems were ordinary operational stores. None was a lossless or
retention-locked forensic archive.

## Sanitized access status

| Capability | Audit result | Gap at the time |
| --- | --- | --- |
| Cloud Logging | Read-only queries worked | Evidence still expired under ordinary log retention |
| SigNoz trace store | Read-only trace and aggregate queries worked | No scoped user-facing SigNoz API identity had been provisioned |
| Rapids memory dump | The route existed and required a signed allowed identity | The audited operator identity was denied |
| Estuary memory dump | The public route was disabled by design | A controlled host-side acquisition path was required |
| Host access | No trusted and authenticated forensic operator path was established | Host fingerprints and a dedicated short-lived identity were required |
| Deployment metadata | Workflow files and expected credential names were visible | Current environment state and protections were not verified |
| Host packet and socket capture | Server tools and privileges were not verified | Managed tooling and narrow capture capabilities were required |
| Evidence archive | No dedicated archive was found | Separate integrity and sensitive-payload stores were required |
| Managed browser recording | No managed recorder was deployed | Dedicated clean profiles and a native controller were required |

The infrastructure definition described twenty-one Toolshed processes behind
Nginx. It placed `/data/memory` and `/data/cache` on persistent storage. The
audit could not confirm that topology on each live host. The live host,
storage owner, snapshot mechanism, and backup path therefore remained
preflight requirements.

## Instrumentation findings

The strongest durable evidence was the accepted memory history:

- `commit.original` held an accepted client's logical transaction.
- `commit.resolution` held the server sequence and resolved pending reads.
- `commit.session_id` held the server-derived session key.
- `revision` held accepted entity operations in logical order.
- the state inspector could reconstruct and compare accepted states from a
  snapshot.

That evidence omitted rejected attempts, client-only reads, optimistic state,
rendering, exact network messages, and packets.

The other important findings were:

- Toolshed Pino logs recorded request and response metadata but no bodies.
- The Pino request identifier was not propagated into the memory protocol.
- Server OpenTelemetry recorded timing and selected transaction attributes.
- An unknown-session rejection occurred before the `memory.transact` span.
- Browser OpenTelemetry was opt-in, batched, and sparse.
- Runtime telemetry and diagnostic rings were detailed but bounded and
  volatile.
- The staging memory dump used `VACUUM INTO` for one main space database.
- That dump omitted sibling `cell-*.sqlite` databases.
- The lunch poll read participant profile and home spaces outside the poll
  space.
- The engine configured SQLite with a 256-mebibyte memory map.
- The generated-art path crossed Toolshed, FAL, an image download, and a
  mutable cache.
- No lunch-poll packet or socket capture was configured.
- No current tool combined browser events, runtime actions, rejected attempts,
  database internals, network traffic, and packets into one timeline.

## Access conclusion

The audit had enough read access to establish the operational logging and
trace baseline. It did not have a verified host acquisition path, an allowed
forensic memory-dump identity, managed server packet privileges, a dedicated
evidence archive, or a controlled browser recorder.

Deployment credentials referenced by automation were not suitable forensic
operator credentials. The live plan therefore requires individually
attributable, short-lived access and explicitly forbids reusing the CI bastion
deployment key for human acquisition.
