---
status: historical
created: 2026-09-08
archived: 2026-09-08
reason: "Completed isolated scheduling review and deterministic host lifecycle proofs."
---

# Periodic collection scheduling review

The reviewed host files were refreshed from the active implementation on base
`0d4dca379aef185d351a013f5bfecbf7918b84e2`. The review and all changes ran in an
isolated worktree. Changes were confined to host scheduling, health, their
tests, and documentation.

## Findings and scheduling decision

The previous CLI used a fixed interval anchored after startup. It did not wait
an interval after a collection completed. When a collection exceeded the
interval, the existing `CollectionRequestQueue` kept one active request and one
pending full request. Repeated ticks were coalesced. A pending request could
therefore begin immediately when the active request finished.

The existing queue already bounded pending full requests. The host's `#syncTail`
already serialized full collections. Health omitted an explicit collection
duration and the next periodic deadline.

A subsequent review with the real Fabric target reproduced command starvation.
The target held its Fabric mutation queue throughout native collection. The
command worker awaited publication of its in-flight receipt before invoking the
provider, so it could not invoke the provider until that collection completed.

The CLI now schedules from completion. It cancels the timer when a periodic or
signal-driven request begins. After the request settles, it starts the next
configured interval. A failed request follows the same schedule. If a SIGHUP
follow-up is pending, it runs first. The periodic timer is armed after that
follow-up finishes. Shutdown suppresses rearming and clears the deadline.

The relevant code is `schedulePeriodicCollection` and `cancelPeriodicCollection`
in [`cli.ts`](../../../../../../packages/connectors/agents/host/src/cli.ts).
`CollectionRequestQueue.hasPending` exposes its existing single pending slot so
the CLI does not arm a timer between the active and pending requests.

## Health

`sync.durationMs` reports elapsed time using a monotonic clock. Running
snapshots compute the elapsed duration when read. Completed and failed snapshots
retain their final duration. The regression changes the wall clock backward and
forward while verifying durations of 37 ms and 23 ms.

`nextCollectionAt` contains the next periodic deadline as an ISO timestamp. It
is null while a collection runs, when periodic scheduling is disabled, and
during shutdown. `AgentsHost.setNextCollectionAt` updates local health and
publishes the changed schedule. Its publication joins the existing health
publication queue. The fields and clock are in
[`host.ts`](../../../../../../packages/connectors/agents/host/src/host.ts).

## Deterministic proofs

The cadence proof configured a 10 ms interval and held a collection across 20
subsequent interval points. The active timer was canceled. Two SIGHUP signals
produced one follow-up. The maximum active collection count was one. The
follow-up finished at an injected time of 6000 ms. Exactly one new timer was
then armed for 6010 ms. There was no timer between the active request and its
pending follow-up. Shutdown canceled the final timer and cleared health's
deadline.

The host command proof held a full provider inventory read while admitting 21
more full requests. Only one became pending. A rename command executed and
requested its targeted refresh while the inventory remained held. Releasing the
inventory produced exactly one further full collection. The test uses the host's
fake target to observe command admission and refresh requests.

The real target now uses one serial queue for archive collection and targeted
refresh. A separate queue serializes bounded Fabric mutations. Only the final
catalog switch joins that queue. The regression in
`packages/connectors/agents/connector/test/archive-fabric.test.ts` holds a native
scan with an explicit promise barrier. A command publishes its in-flight and
terminal receipts while the scan remains held. The visible catalog still
identifies the previous complete generation. After releasing the scan, its
targeted refresh runs. The maximum active archive scan count is one.

The new cadence expectation failed against the previous timer because it
remained active during collection. The new duration expectation failed because
the field was absent. Both passed after the changes. The existing four queue
tests also passed, including pending coalescing, failure, and shutdown.

The final focused command was:

```sh
deno test -A \
  packages/connectors/agents/host/test/cli_test.ts \
  packages/connectors/agents/host/test/collection_request_queue_test.ts \
  packages/connectors/agents/host/test/host_test.ts
```

The runner reported `37 passed | 0 failed`. The changed TypeScript files passed
type, formatting, and lint checks. The new tests use injected clocks, timer
callbacks, and promise barriers. They contain no elapsed-time waits, timeout
bounds, or retry loops.

## Import files

- `packages/connectors/agents/host/src/cli.ts`
- `packages/connectors/agents/host/src/collection-request-queue.ts`
- `packages/connectors/agents/host/src/host.ts`
- `packages/connectors/agents/host/test/cli_test.ts`
- `packages/connectors/agents/host/test/host_test.ts`
- `packages/connectors/agents/host/README.md`

This report and its history index entry record the verification. The source
review's updated `start_test.ts` was preserved in the isolated worktree. It was
not changed by this scheduling review and is not part of this import list.
