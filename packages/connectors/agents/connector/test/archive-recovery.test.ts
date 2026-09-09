/** Verifies catalog recovery, resource release, and complete native bytes. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Database } from "@db/sqlite";

import { ArchiveStore } from "@commonfabric/memory/v2/archive-store";
import {
  ARCHIVE_LIMITS,
  type ArchiveCommand,
  type ArchiveIdentity,
  ArchivePinOwner,
  archiveResponseHash,
  type ArchiveResult,
} from "@commonfabric/memory/v2/archive";
import { ArchiveHttp } from "../../../../memory/v2/archive-http.ts";

import {
  type AgentArchiveCatalog,
  type AgentArchivePageMetadata,
  AgentArchivePublisher,
  type ArchivedSession,
} from "../src/archive.ts";
import { ClaudeAgentSdkDriver } from "../src/drivers/claude-agent-sdk.ts";
import { CodexAppServerDriver } from "../src/drivers/codex-app-server.ts";
import { GitContextResolver } from "../src/git-context.ts";
import { sessionKey } from "../src/session-contract.ts";

const identity: ArchiveIdentity = {
  principal: "did:key:review-owner",
  actingPrincipal: "did:key:review-owner",
  space: "did:key:review-owner",
  sessionId: "review-session",
  connectionId: "review-connection",
};
const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";

describe("native archive recovery", () => {
  let root: string;
  let store: ArchiveStore;
  let http: ArchiveHttp;
  let publisher: AgentArchivePublisher;
  let driver: ClaudeAgentSdkDriver;
  let catalog: AgentArchiveCatalog | undefined;
  let catalogError: Error | undefined;
  let beforeTransfer:
    | ((command: ArchiveCommand) => void | Promise<void>)
    | undefined;
  let pinSequence = 0;
  const pinSequences = new Map<string, number>();
  let afterCommand: ((command: ArchiveCommand) => void) | undefined;

  async function archive(
    command: ArchiveCommand,
    data?: Uint8Array,
    signal?: AbortSignal,
  ): Promise<ArchiveResult | Uint8Array> {
    signal?.throwIfAborted();
    const sequence = command.op === "pin" ? ++pinSequence : undefined;
    if (command.op === "pin") pinSequences.set(command.pin!, sequence!);
    if (command.op === "release" || command.op === "pin-status") {
      command = { ...command, sequence: pinSequences.get(command.pin) };
    }
    const ticket = await http.issue(command, identity, sequence);
    let consumed = false;
    let result: ArchiveResult | Uint8Array;
    try {
      await beforeTransfer?.(command);
      const response = await http.handle(
        new Request("http://archive/transfer", {
          method: "POST",
          headers: {
            authorization: `Bearer ${ticket.token}`,
            "content-type": "application/octet-stream",
            "content-length": String(data?.length ?? 0),
          },
          body: data?.slice() ?? new Uint8Array(0),
          signal,
        }),
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!response.ok) throw new Error(new TextDecoder().decode(bytes));
      expect(bytes.length).toBe(Number(response.headers.get("content-length")));
      expect(archiveResponseHash(bytes)).toBe(
        response.headers.get("x-archive-content-sha256"),
      );
      result = command.op === "read"
        ? bytes
        : JSON.parse(new TextDecoder().decode(bytes));
      consumed = true;
    } finally {
      await http.acknowledge(
        ticket.token,
        identity,
        consumed,
        command.op === "pin"
          ? { archive: command.archive, pin: command.pin!, sequence: sequence! }
          : undefined,
      );
    }
    afterCommand?.(command);
    if (command.op === "release") pinSequences.delete(command.pin);
    return result;
  }

  async function control(command: ArchiveCommand): Promise<ArchiveResult> {
    if (command.op === "pin" && !command.pin) {
      const owner = new ArchivePinOwner(command, control);
      await owner.acquire();
      return { pin: owner.pin, generation: command.generation };
    }
    const result = await archive(command);
    if (result instanceof Uint8Array) {
      throw new Error("Expected catalog response");
    }
    return result;
  }

  function createPublisher(): AgentArchivePublisher {
    return new AgentArchivePublisher(
      { archiveLimits: () => Promise.resolve(ARCHIVE_LIMITS), archive },
      "catalog",
      identity.principal,
      (value) => {
        if (catalogError) throw catalogError;
        catalog = structuredClone(value);
        return Promise.resolve();
      },
      catalog,
    );
  }

  function resourceCounts() {
    using cleanup = new DisposableStack();
    const database = new Database(`${root}/archive/catalog.sqlite`, {
      readonly: true,
    });
    cleanup.defer(() => database.close());
    using query = database.prepare(`SELECT
      (SELECT count(*) FROM pins) AS pins,
      (SELECT count(*) FROM tickets) AS tickets,
      (SELECT count(*) FROM generations) AS generations,
      (SELECT count(*) FROM records) AS records,
      (SELECT count(*) FROM pages) AS pages`);
    return query.get() as {
      pins: number;
      tickets: number;
      generations: number;
      records: number;
      pages: number;
    };
  }

  function expectReleased(pins = 0): void {
    const counts = resourceCounts();
    expect(counts.pins).toBe(pins);
    expect(counts.tickets).toBe(0);
    expect(http.activeTransferCount).toBe(0);
  }

  beforeEach(async () => {
    root = await Deno.makeTempDir({
      dir: Deno.cwd(),
      prefix: ".archive-recovery-",
    });
    await Deno.mkdir(`${root}/claude/projects/test`, { recursive: true });
    store = await ArchiveStore.open({ root: `${root}/archive` });
    http = new ArchiveHttp(store, () =>
      Promise.resolve({
        writerPolicy: "review",
        cfcPolicy: "{}",
      }), []);
    catalog = undefined;
    catalogError = undefined;
    beforeTransfer = undefined;
    afterCommand = undefined;
    publisher = createPublisher();
    driver = new ClaudeAgentSdkDriver({
      id: "claude",
      driver: "claude-agent-sdk",
      enabled: true,
      configDir: `${root}/claude`,
    });
    await writeLog(firstId);
  });

  afterEach(async () => {
    await http.close();
    store[Symbol.dispose]();
    await Deno.remove(root, { recursive: true });
  });

  /** Writes one complete native transcript with a stable provider identity. */
  async function writeLog(id: string): Promise<void> {
    await Deno.writeTextFile(
      `${root}/claude/projects/test/${id}.jsonl`,
      JSON.stringify({
        type: "user",
        uuid: id,
        cwd: "/review-checkout",
        timestamp: "2026-09-08T00:00:00Z",
        message: { role: "user", content: "complete native bytes" },
      }) + "\n",
    );
  }

  it("publishes newly discovered native bytes after a failed Git observation", async () => {
    const scratchDirectory = `${root}/scratch`;
    expect(await publisher.publish([driver], { scratchDirectory })).toBe(1);
    await writeLog(secondId);
    const gitContext = new GitContextResolver(
      () => Promise.reject(new Error("Injected Git process failure")),
    ).beginObservation();
    expect(
      await publisher.publish([driver], {
        scratchDirectory,
        gitContext,
      }),
    ).toBe(2);
    expect(catalog?.sessionCount).toBe(2);
    const scope = {
      archive: catalog!.archive,
      generation: catalog!.generation,
    };
    const pin = (await control({ op: "pin", ...scope })).pin!;
    for (const id of [firstId, secondId]) {
      const record = (await control({
        op: "get",
        ...scope,
        pin,
        key: sessionKey(driver.source.id, id),
      })).records![0];
      const metadata = JSON.parse(record.metadata) as ArchivedSession;
      expect(metadata.gitObservationFailed).toBe(true);
      expect(metadata.gitObservedAt).toBeNull();
      expect(metadata.gitContext).not.toBeNull();
      expect(metadata.nativeBytes).toBeGreaterThan(0);
      expect(record.partial).toBe(false);
    }
    await control({ op: "release", archive: scope.archive, pin });
    expectReleased();
  });

  for (const restart of [false, true]) {
    it(
      `recovers after more catalog failures than generation capacity ${
        restart ? "after restarting the host and store" : "in the same process"
      }`,
      async () => {
        const options = { scratchDirectory: `${root}/scratch` };
        expect(await publisher.publish([driver], options)).toBe(1);
        const readerScope = {
          archive: catalog!.archive,
          generation: catalog!.generation,
        };
        const readerPin = (await control({ op: "pin", ...readerScope })).pin!;
        expect(await publisher.publish([driver], options)).toBe(1);
        const visibleScope = {
          archive: catalog!.archive,
          generation: catalog!.generation,
        };
        const key = sessionKey(driver.source.id, firstId);
        catalogError = new Error("Injected catalog publication failure");
        for (let index = 0; index < ARCHIVE_LIMITS.generations + 3; index++) {
          await expect(publisher.publish([driver], options)).rejects.toBe(
            catalogError,
          );
          expect(catalog!.generation).toBe(visibleScope.generation);
          const visiblePin = (await control({ op: "pin", ...visibleScope }))
            .pin!;
          for (
            const scope of [
              { ...readerScope, pin: readerPin },
              { ...visibleScope, pin: visiblePin },
            ]
          ) {
            const page =
              (await control({ op: "pages", ...scope, key })).pages![0];
            expect(
              await archive({
                op: "read",
                ...scope,
                key,
                index: page.index,
                hash: page.hash,
              }),
            ).toEqual(
              await Deno.readFile(
                `${root}/claude/projects/test/${firstId}.jsonl`,
              ),
            );
          }
          await control({
            op: "release",
            archive: visibleScope.archive,
            pin: visiblePin,
          });
          expectReleased(1);
          const counts = resourceCounts();
          expect(counts.generations).toBeLessThanOrEqual(4);
          expect(counts.records).toBeLessThanOrEqual(4);
          expect(counts.pages).toBeLessThanOrEqual(12);
        }
        await control({
          op: "release",
          archive: readerScope.archive,
          pin: readerPin,
        });
        expectReleased();
        if (restart) {
          await http.close();
          store[Symbol.dispose]();
          store = await ArchiveStore.open({ root: `${root}/archive` });
          http = new ArchiveHttp(store, () =>
            Promise.resolve({
              writerPolicy: "review",
              cfcPolicy: "{}",
            }), []);
          publisher = createPublisher();
          expectReleased();
        }
        catalogError = undefined;
        expect(await publisher.publish([driver], options)).toBe(1);
        expect(catalog!.generation).not.toBe(visibleScope.generation);
        expectReleased();
        const recovered = resourceCounts();
        expect(recovered.generations).toBe(1);
        expect(recovered.records).toBe(1);
        expect(await publisher.publish([driver], options)).toBe(1);
        expect(resourceCounts()).toEqual(recovered);
        expectReleased();
      },
    );
  }

  for (const operation of ["abort", "release"] as const) {
    it(`preserves the publication error when the ${operation} response fails after its effect`, async () => {
      const options = { scratchDirectory: `${root}/scratch` };
      await publisher.publish([driver], options);
      const visibleGeneration = catalog!.generation;
      const primary = new Error("Injected publication failure");
      const cleanupError = new Error("Injected cleanup response failure");
      const fail = () => {
        afterCommand = (command) => {
          if (command.op === operation) throw cleanupError;
        };
        throw primary;
      };
      if (operation === "release") catalogError = primary;
      try {
        await publisher.publish([driver], {
          ...options,
          ...(operation === "abort" ? { onSource: fail } : {
            observe: (phase) => {
              if (phase === "index") {
                afterCommand = (command) => {
                  if (command.op === operation) throw cleanupError;
                };
              }
            },
          }),
        });
        throw new Error("Expected publication failure");
      } catch (error) {
        expect(error).toBeInstanceOf(SuppressedError);
        expect((error as SuppressedError).error).toBe(cleanupError);
        expect((error as SuppressedError).suppressed).toBe(primary);
      }
      afterCommand = undefined;
      expect(catalog!.generation).toBe(visibleGeneration);
      expectReleased();
      catalogError = undefined;
      expect(await publisher.publish([driver], options)).toBe(1);
      expect(resourceCounts().generations).toBe(1);
      expectReleased();
    });
  }

  it("releases its pin during unwind after an explicit release fails before effect", async () => {
    const options = { scratchDirectory: `${root}/scratch` };
    await publisher.publish([driver], options);
    const previousGeneration = catalog!.generation;
    const failedRelease = new Error(
      "Injected failure before the release transfer",
    );
    const releaseReached = Promise.withResolvers<string>();
    const failRelease = Promise.withResolvers<void>();
    let heldPin: string | undefined;
    let attempts = 0;
    let appliedReleases = 0;
    const publication = publisher.publish([driver], {
      ...options,
      observe: (phase) => {
        if (phase === "index") {
          beforeTransfer = async (command) => {
            if (command.op !== "release") return;
            heldPin ??= command.pin;
            if (command.pin !== heldPin) return;
            if (++attempts === 1) {
              releaseReached.resolve(heldPin);
              await failRelease.promise;
              throw failedRelease;
            }
          };
          afterCommand = (command) => {
            if (command.op === "release" && command.pin === heldPin) {
              appliedReleases++;
            }
          };
        }
      },
    });
    try {
      const pin = await Promise.race([
        releaseReached.promise,
        publication.then(() => {
          throw new Error("Publication finished before reaching the release");
        }),
      ]);
      expect(catalog!.generation).not.toBe(previousGeneration);
      expect(attempts).toBe(1);
      expect(appliedReleases).toBe(0);
      expect(resourceCounts().pins).toBe(1);
      expect(resourceCounts().tickets).toBe(1);
      expect(http.activeTransferCount).toBe(0);
      await control({
        op: "prune",
        archive: catalog!.archive,
        generation: catalog!.generation,
      });
      const scope = {
        archive: catalog!.archive,
        generation: previousGeneration,
        pin,
      };
      const key = sessionKey(driver.source.id, firstId);
      const page = (await control({ op: "pages", ...scope, key })).pages![0];
      expect(
        await archive({
          op: "read",
          ...scope,
          key,
          index: page.index,
          hash: page.hash,
        }),
      ).toEqual(
        await Deno.readFile(
          `${root}/claude/projects/test/${firstId}.jsonl`,
        ),
      );
      expect(resourceCounts().generations).toBe(2);
      expect(resourceCounts().pins).toBe(1);
      expect(resourceCounts().tickets).toBe(1);
    } finally {
      failRelease.resolve();
      await publication.catch(() => {});
    }
    await expect(publication).rejects.toBe(failedRelease);
    expect(catalog!.generation).not.toBe(previousGeneration);
    expect(attempts).toBe(2);
    expect(appliedReleases).toBe(1);
    expectReleased();
    expect(await publisher.publish([driver], options)).toBe(1);
    expect(attempts).toBe(2);
    expect(appliedReleases).toBe(1);
    expect(resourceCounts().generations).toBe(1);
    expectReleased();
  });

  it("keeps ownership after final cleanup fails and releases it before another publication", async () => {
    const options = { scratchDirectory: `${root}/scratch` };
    await publisher.publish([driver], options);
    const visibleGeneration = catalog!.generation;
    catalogError = new Error("Injected catalog failure");
    const failedRelease = new Error(
      "Injected failure before the release transfer",
    );
    try {
      await publisher.publish([driver], {
        ...options,
        observe: (phase) => {
          if (phase === "index") {
            beforeTransfer = (command) => {
              if (command.op === "release") throw failedRelease;
            };
          }
        },
      });
      throw new Error("Expected publication failure");
    } catch (error) {
      expect(error).toBeInstanceOf(SuppressedError);
      expect((error as SuppressedError).error).toBe(failedRelease);
      expect((error as SuppressedError).suppressed).toBe(catalogError);
    }
    expect(catalog!.generation).toBe(visibleGeneration);
    expectReleased(1);
    const retained = resourceCounts();
    await expect(publisher.publish([driver], options)).rejects.toBe(
      failedRelease,
    );
    expect(resourceCounts()).toEqual(retained);
    expectReleased(1);
    beforeTransfer = undefined;
    catalogError = undefined;
    expect(await publisher.publish([driver], options)).toBe(1);
    expect(resourceCounts().generations).toBe(1);
    expectReleased();
  });

  it("archives valid native SQLite bytes with JSON-escaped summary fields", async () => {
    const codexHome = `${root}/codex`;
    await Deno.mkdir(codexHome);
    const cwd = Array.from({ length: 14 }, () => `/${"\u0001".repeat(200)}`)
      .join("");
    {
      using cleanup = new DisposableStack();
      const database = new Database(`${codexHome}/state_1.sqlite`);
      cleanup.defer(() => database.close());
      database.exec("CREATE TABLE threads(id TEXT, cwd TEXT, title TEXT)");
      using insert = database.prepare("INSERT INTO threads VALUES (?,?,?)");
      expect(new TextEncoder().encode(cwd).length).toBeLessThan(4096);
      insert.run(firstId, cwd, "complete native session");
    }
    const codex = new CodexAppServerDriver({
      id: "codex",
      driver: "codex-app-server",
      enabled: true,
      codexHome,
    });
    expect(
      await publisher.publish([codex], {
        scratchDirectory: `${root}/scratch`,
      }),
    ).toBe(1);
    const scope = {
      archive: catalog!.archive,
      generation: catalog!.generation,
    };
    const pin = (await control({ op: "pin", ...scope })).pin!;
    const key = sessionKey(codex.source.id, firstId);
    const record =
      (await control({ op: "get", ...scope, pin, key })).records![0];
    expect(new TextEncoder().encode(record.metadata).length)
      .toBeLessThanOrEqual(
        ARCHIVE_LIMITS.metadataBytes,
      );
    const metadata = JSON.parse(record.metadata) as ArchivedSession;
    expect(metadata.summary.nativeSessionId).toBe(firstId);
    expect(metadata.summary.cwd).not.toBe(cwd);
    const pages = (await control({ op: "pages", ...scope, pin, key })).pages!;
    const native = pages.filter((page) => {
      const metadata = JSON.parse(page.metadata) as AgentArchivePageMetadata;
      return metadata.kind === "native" &&
        metadata.provenance.kind === "codex-state" &&
        metadata.provenance.column === "cwd";
    });
    expect(native.length).toBe(1);
    expect(
      await archive({
        op: "read",
        ...scope,
        pin,
        key,
        index: native[0].index,
        hash: native[0].hash,
      }),
    ).toEqual(new TextEncoder().encode(cwd));
    await control({ op: "release", archive: scope.archive, pin });
    expectReleased();
  });
});
