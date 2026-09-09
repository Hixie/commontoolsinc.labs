---
status: historical
created: 2026-09-08
archived: 2026-09-08
reason: "Completed isolated review and bounded regression proofs for archive transfer boundaries."
---

# Archive transfer boundary review

This review used the supplied archive implementation snapshot on base
`0d4dca379aef185d351a013f5bfecbf7918b84e2`. The supplied patch had SHA-256
`9ddb9d3320d2b9b779c0e19cb00d144a10140773e0622e0dc1b924588f682a8f`. All edits
and tests ran in an isolated review worktree. The review did not modify the
running toolshed or run a stress workload.

The final focused run passed eight suites containing 38 steps. The seven changed
TypeScript files also passed formatting and lint checks. The tests use real
ArchiveStore databases and Memory session admission through loopback transport.
They use explicit stream and authorization barriers. The browser client test
stubs fetch and the runtime connection. These results do not measure socket
buffering, browser behavior, or a memory plateau.

## Verified failures and fixes

### Disconnect after response headers retained the admission slot

`ArchiveHttp.handle` removed its request abort listener in its outer `finally`.
That block ran when the handler returned a Response. Its body could still be
unconsumed. A deterministic proof obtained two responses, aborted both request
signals after headers, and issued another operation for the same principal. The
third operation returned 429 instead of 200.

The fix keeps the listener until `ArchiveHttp.#settle` removes the transfer. The
existing conditions still hold admission while a handler or response pull is
pending. Both existing early-acknowledgement race tests passed after this
change. The relevant implementation is
[`archive-http.ts`](../../../../packages/memory/v2/archive-http.ts), including
`#settle`, request listener registration, and the handler's `finally`.

### Input cleanup retained reader locks and could replace the original error

`readArchiveBody` awaited `reader.cancel()` before releasing the reader lock.
When the input stream errored, cancellation rejected with the stream error. The
reader remained locked. A separate proof made the consumer and cancellation
throw distinct errors. Cancellation replaced the consumer's error and left the
reader locked.

The fix releases the lock in a `finally` around cancellation. It preserves a
single error and reports two distinct errors in an AggregateError whose cause is
the first error. The HTTP request-body wrapper also releases its original reader
when a read or cancellation fails. A focused proof verifies that an errored
Request body is unlocked after the handler returns its refusal. The relevant
functions are `readArchiveBody` in
[`archive.ts`](../../../../packages/memory/v2/archive.ts) and the request-body
wrapper in `ArchiveHttp.handle`.

### Acknowledgement failures replaced transfer failures in both clients

`SpaceSession.archive` and `CellHandle.archive` awaited acknowledgement in a
`finally` after their transfer. An acknowledgement rejection replaced a failed
HTTP transfer or direct page fetch. Independent tests reproduced this in the
Memory client and the browser-facing cell handle.

Both paths now use `withArchiveAcknowledgement` in `archive.ts`. It acknowledges
each settled transfer, retains both distinct errors, and keeps the transfer
error as AggregateError.cause. A failed acknowledgement after a successful
transfer still rejects the operation. The callers are
[`client.ts`](../../../../packages/memory/v2/client.ts) and
[`cell-handle.ts`](../../../../packages/runtime-client/src/cell-handle.ts).

### Unsupported fields, read digests, and HTTP ranges were accepted

`validateArchiveCommand` accepted unknown properties, including unsupported
`offset` and `length` properties. Its read operation accepted short, uppercase,
or nonhexadecimal digest strings. The HTTP endpoint accepted a native request
with a Range header and returned its complete response with status 200.

The validator now records the fields each operation validates and rejects any
other own enumerable field. Reads and puts use the same exact lowercase SHA-256
syntax check. The HTTP endpoint rejects Range and Content-Range with status 400.
Existing store checks still reject a well-formed digest, index, record key, or
generation that does not identify the pinned page.

Eight steps failed before their respective fixes: five initial boundary steps,
the HTTP range step, and one acknowledgement step in each client. They passed
after the fixes. The failure checks distinguished wrong returned statuses,
unexpectedly accepted commands, retained locks, and replacement error objects.

## Authority and lifecycle proofs

The added tests verified these behaviors:

- A service admitted with the delegated space-owner read binding could read an
  owner-authorized archive. Its open, begin, put, and delete commands were
  refused using its authenticated envelope principal.
- Revoking a writer's WRITE authority while its upload waited for a body left
  the published page directory and staging directory empty. The final operation
  returned a current-ACL refusal.
- Revoking disclosure policy after the first 16 KiB response frame prevented
  release of the remaining byte. This test controls the trusted authorization
  callback. A separate test revokes the actual Memory ACL between frames and
  verifies that session revocation aborts the response.
- Closing a Memory attachment aborted its response and invalidated its pin. A
  new attachment could not reuse that pin.
- Changing an existing handle's requested policy was refused. A valid pinned
  read still succeeded after attempts using the wrong digest, page index, record
  key, and generation.
- Only the configured exact HTTP origin was accepted for browser requests.
  Opaque origins, a default-port spelling, a trailing slash, user information,
  suffix lookalikes, and the wrong scheme were refused. Native requests with
  neither Origin nor Sec-Fetch-Site were accepted. An Origin-free request with
  Sec-Fetch-Site was refused. Preflight accepted only POST and the permitted
  authorization and content-type headers.
- Eight admitted responses across different principals blocked a ninth.
  Canceling one response permitted a new operation. The existing principal
  admission test still held two canceled operations until authorization
  finished.
- A total of 128 pins across 16 principals blocked another pin. Reopening the
  store invalidated old pins and permitted a fresh pin. Existing tests also
  verified eight pins per principal across sessions and the generation cap.

The existing focused storage and protocol tests additionally passed immutable
page retries, quotas, incomplete-generation recovery, orphan cleanup, expired
and replayed capabilities, current-policy deletion acknowledgements, and the
abort-and-reused-record race. No additional authorization bypass was reproduced
by these tests.

## Reusable proofs

New files:

- [`v2-archive-boundary.test.ts`](../../../../packages/memory/test/v2-archive-boundary.test.ts)
- [`v2-archive-authority.test.ts`](../../../../packages/memory/test/v2-archive-authority.test.ts)

The matching browser client regression is in
[`runtime-client/test/archive.test.ts`](../../../../packages/runtime-client/test/archive.test.ts).

The final focused command was:

```sh
deno test -A \
  packages/memory/test/v2-archive-boundary.test.ts \
  packages/memory/test/v2-archive-authority.test.ts \
  packages/memory/test/v2-archive-protocol.test.ts \
  packages/memory/test/v2-archive-store.test.ts \
  packages/memory/test/v2-archive-implementation.test.ts \
  packages/memory/test/v2-archive-response.test.ts \
  packages/memory/test/v2-archive-concurrency.test.ts \
  packages/runtime-client/test/archive.test.ts
```

The runner reported `8 passed (38 steps) | 0 failed` in three seconds.
