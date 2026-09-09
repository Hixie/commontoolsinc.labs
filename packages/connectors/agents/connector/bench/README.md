# Native host memory measurements

These programs run the production agent host, provider drivers, Toolshed routes,
and authenticated archive client in separate processes. Run them explicitly;
they are not part of the unit-test suite.

`host-memory.ts` creates private Claude and Codex source directories. Each file
contains a valid JSON record with a large escaped string. Generation writes one
fixed block at a time and records expected sizes and SHA-256 hashes in a
streamed JSONL file. `--unique-blocks` puts a different fixed-width tag in every
block, so the volume case also exercises distinct archive files.

```sh
deno run -A packages/connectors/agents/connector/bench/host-memory.ts \
  --directory /tmp/agents-memory-example \
  --sessions 16 --bytes 65536 \
  --read-bytes 65536 --page-bytes 65536 \
  --codex-bin /absolute/path/to/codex
```

The default sequence collects, independently reads the published data, refreshes
unchanged sources, appends a record, interrupts an upload, and restarts both the
host and Toolshed. `--delete` adds a deletion before the interruption.
`--initial-only` stops after the initial collection and readback.
`--no-readback` omits the independent reader. `--fixtures-only` generates inputs
without starting services. `--recover` resumes an existing directory using its
saved configuration and original fixtures. The source read and page budgets are
stored in `profile.json`. Explicit read and page arguments override those saved
budgets during recovery.

Only synthetic inputs in the requested directory are modified. The real Codex
App Server receives that directory's private `CODEX_HOME`. It may create its own
runtime files there; those are separate from the generated source files. No
provider prompt is sent.

The independent reader streams the expected records and checks catalog counts,
native identities, event and message counts, extent lengths, and native digests.
It reconstructs the first Claude and Codex files and every file larger than one
page through authenticated byte-page reads. It compares their SHA-256 digests
with bounded reads of the original files. Each reader streams its verified
hashes, counts, and deletion results into a separate JSONL manifest. It holds
one returned directory page, one byte page, and one 64 KiB verification buffer.
The runtime and HTTP implementation have additional fixed allocations.

The supervisor enforces these ceilings:

| Resource                        | Ceiling |
| ------------------------------- | ------: |
| Generated source files          |  10,000 |
| Generated source bytes          |  12 GiB |
| Archive directory               |  16 GiB |
| Complete benchmark directory    |  32 GiB |
| Any benchmark process RSS       |   3 GiB |
| Aggregate benchmark process RSS |   5 GiB |

Collection and readback use one transfer at a time. The supervisor samples the
process tree and disk use once per second. A limit stops the process tree and
writes `safety-stop.json`; reaching a limit is a failed run. The interval is a
safety mechanism, not a completion condition. Normal progress awaits protocol
replies, stream completion, runtime idle, or process exit.

Stage JSONL records contain RSS, V8 heap use and reservation, external memory,
and available native allocator counters. They include samples before and after
explicit garbage collection. The child processes also enable V8 GC tracing;
current V8 versions emit JSON records containing heap sizes before and after a
collection. On macOS, each child has an independent `/usr/bin/time -l` report.
Those reports give a process-wide kernel RSS maximum. A maximum from the stage
samples is a sampled maximum and must be reported separately from retained
post-GC values. ArrayBuffer and native counters that are unavailable must not be
reported as measured zeros.

Orderly host and Toolshed shutdown also inspects the process's open files.
Native, scratch, and archive handles must all be closed. The probe uses
`/proc/self/fd` on Linux and `lsof` on other supported systems. Toolshed closes
the benchmark's own read-only inspection connection before this check. Each
child exit record verifies that the process and its owned descendants have
exited.

`results-<run>.json` preserves each orchestration run. `results.json` is the
latest run. Child JSONL, stdout, stderr, RSS, and safety logs remain in the
directory. Record validated measurements in repository documentation before
removing the private fixtures, archive, database, and browser profiles.

## Browser and saved-document measurements

Build the production shell into a private directory:

```sh
deno run -A packages/connectors/agents/connector/bench/host-memory-build-shell.ts \
  /tmp/agents-memory-shell
```

Set the existing benchmark's `shellRoot` to that directory. Reopen a saved piece
with one private Toolshed and one headless browser:

```sh
deno run -A packages/connectors/agents/connector/bench/host-memory-visit.ts \
  --directory /tmp/agents-memory-example --name browser-check \
  --piece fid1:the-saved-piece-id
```

`--legacy` selects `legacyPieceId` from the saved configuration. In this mode
the server records old-root queries, reads, and writes without blocking them.
During host collection the same hooks reject old-root access. This distinction
lets an actual frozen artifact run through its original code. It does not
substitute a test-induced refusal for a safe saved URL.

Set `browserIdentityPath` in the saved configuration to authenticate the browser
with a different identity from Toolshed. Toolshed continues to use
`identityPath`. A saved-artifact visit can therefore use the artifact owner's
existing key in the browser and a generated key for the private server. The
browser defaults to `identityPath` when `browserIdentityPath` is absent.

The browser verifies `--headless=new` before opening the piece. It sets the
identity in memory and awaits the shell's initialization and runtime tasks.
Chrome's developer-tools protocol supplies page and worker heap measurements and
the browser's process IDs for RSS accounting. The normal registered-view
sequence exercises catalog, session, and byte-page navigation.

Use `--readback` instead of a piece ID to run only the independent authenticated
reader against an existing private archive. This does not start a provider or
the host.
