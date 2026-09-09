# Common Fabric agent connector

`@commonfabric/agents-connector` copies persisted coding-agent sessions into a
Common Fabric space. It also accepts commands for those sessions and publishes
durable receipts for each command.

The command-line host collects Claude and Codex sessions through the native v2
archive path. It reads local logs and Codex database values in fixed buffers,
stores exact source bytes in immutable archive pages, and publishes a bounded
catalog in Common Fabric. Session metadata and message previews are bounded;
complete Git observations occupy separate archive pages. The debug view reads
one catalog page and one byte page at a time.

Provider SDKs and protocols still execute commands. The eager `listSessions()`,
`readSession()`, `collectSource()`, and `publish()` library APIs retain their v1
session, chunk, and index cell formats. ACP implements those eager APIs and its
command protocol, but does not implement native streaming. The native host
rejects ACP collection; it has no eager fallback.

The package does not supervise its host process or choose product configuration.
A host supplies source configuration, starts and stops drivers, connects a
Common Fabric runtime, chooses the target space, schedules collection, and
decides how health is reported.

## Documentation

- [Architecture](docs/architecture.md) explains the components, data paths,
  state ownership, lifecycle, and concurrency model.
- [Bounded native archive](docs/bounded-archive.md) describes v2 source bytes,
  paged metadata, server configuration, publication, and migration from v1.
- [Interfaces and protocols](docs/interfaces.md) specifies every package
  boundary. It covers host orchestration, provider drivers, native provider
  protocols and file access, Fabric cells, command values, the local ledger, Git
  metadata, identity, hashing, and chunking.

## Public entry points

The package root exports the normalized and streaming types, collection helpers,
Fabric target, command worker, command ledger, stable graph helpers, identity
helpers, and schema constants. `@commonfabric/agents-connector/archive` exports
the native archive publisher and its catalog, record, and page metadata types.

Provider integrations use separate entry points:

- `@commonfabric/agents-connector/create-driver`
- `@commonfabric/agents-connector/drivers/acp`
- `@commonfabric/agents-connector/drivers/claude-agent-sdk`
- `@commonfabric/agents-connector/drivers/codex-app-server`

Importing the package root does not load provider SDKs or start provider
processes.

## Tests

Run the package tests from this directory:

```sh
deno task test
```
