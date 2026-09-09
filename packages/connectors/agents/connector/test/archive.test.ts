/** Verifies native publication, recovery, and exact reads across driver boundaries. */

// deno-lint-ignore no-external-import -- Native archive hashing uses the incremental platform implementation.
import { createHash } from "node:crypto";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { ArchiveStore } from "@commonfabric/memory/v2/archive-store";
import {
  ARCHIVE_LIMITS,
  type ArchiveCommand,
  ArchivePinOwner,
  type ArchiveResult,
} from "@commonfabric/memory/v2/archive";
import {
  type Client,
  connect,
  loopback,
  type SpaceSession,
} from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenAuth,
} from "../../../../memory/test/v2-auth-test-helpers.ts";
import {
  type AgentArchiveCatalog,
  type AgentArchivePageMetadata,
  AgentArchivePublisher,
  type ArchiveCollectionOptions,
  type ArchivedCheckout,
  type ArchivedSession,
  type ArchiveValueRange,
} from "../src/archive.ts";
import { ClaudeAgentSdkDriver } from "../src/drivers/claude-agent-sdk.ts";
import { CodexAppServerDriver } from "../src/drivers/codex-app-server.ts";
import type { GitContext } from "../src/git-context.ts";

const id = "00000000-0000-4000-8000-000000000001";
const owner = TEST_SESSION_OPEN_PRINCIPAL;
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

describe("native archive publication", () => {
  let root: string;
  let server: Server;
  let client: Client;
  let session: SpaceSession;
  let publisher: AgentArchivePublisher;
  let catalog: AgentArchiveCatalog;
  let claude: ClaudeAgentSdkDriver;
  let codex: CodexAppServerDriver;
  let publications: number;

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "agents-archive-test-" });
    await Deno.mkdir(`${root}/claude/projects/project`, { recursive: true });
    await Deno.mkdir(`${root}/codex/sessions`, { recursive: true });
    server = new Server({
      store: new URL("memory://agents-archive-test"),
      authorizeSessionOpen: () => owner,
      sessionOpenAuth: testSessionOpenAuth,
      acl: { mode: "off" },
      archive: {
        store: await ArchiveStore.open({ root: `${root}/archive` }),
        allowedOrigins: [],
        authorization: {
          create() {
            return { writerPolicy: "agents", cfcPolicy: "{}" };
          },
          authorize(binding, identity) {
            return binding.owner === identity.principal;
          },
        },
      },
    });
    client = await connect({ transport: loopback(server) });
    session = await client.mount(
      owner,
      {},
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
          principal: owner,
        },
        authorization: {},
      }),
    );
    publications = 0;
    publisher = new AgentArchivePublisher(
      {
        archiveLimits: () => Promise.resolve(session.archiveLimits()),
        archive: (...args) => session.archive(...args),
      },
      "native-catalog",
      owner,
      (value) => {
        catalog = structuredClone(value);
        publications++;
        return Promise.resolve();
      },
    );
    claude = new ClaudeAgentSdkDriver({
      id: "claude",
      driver: "claude-agent-sdk",
      enabled: true,
      configDir: `${root}/claude`,
    });
    codex = new CodexAppServerDriver({
      id: "codex",
      driver: "codex-app-server",
      enabled: true,
      codexHome: `${root}/codex`,
    });
    for (const driver of [claude, codex]) {
      driver.listSessions = () => {
        throw new Error("Eager session listing was invoked");
      };
      driver.readSession = () => {
        throw new Error("Eager session hydration was invoked");
      };
    }
  });
  afterEach(async () => {
    await client?.close();
    await server?.close();
    await Deno.remove(root, { recursive: true });
  });

  async function control(command: ArchiveCommand): Promise<ArchiveResult> {
    if (command.op === "pin" && !command.pin) {
      const owner = new ArchivePinOwner(command, control);
      await owner.acquire();
      return { pin: owner.pin, generation: command.generation };
    }
    const result = await session.archive(command);
    if (result instanceof Uint8Array) {
      throw new Error("Expected catalog response");
    }
    return result;
  }

  async function gitValue(
    scope: { archive: string; generation: string; pin: string },
    key: string,
    range: ArchiveValueRange,
    maximumPageBytes = ARCHIVE_LIMITS.pageBytes,
  ): Promise<GitContext> {
    const bytes = new Uint8Array(range.bytes);
    let offset = 0;
    let index = range.firstPage;
    while (index < range.firstPage + range.pageCount) {
      const pages = (await control({
        op: "pages",
        ...scope,
        key,
        ...(index > 0 ? { after: index - 1 } : {}),
        limit: Math.min(16, range.firstPage + range.pageCount - index),
      })).pages!;
      expect(pages.length).toBeGreaterThan(0);
      for (const page of pages) {
        expect(page.index).toBe(index++);
        expect(page.bytes).toBeLessThanOrEqual(maximumPageBytes);
        expect(JSON.parse(page.metadata)).toEqual({
          kind: "git-context",
          offset,
        });
        const part = await session.archive({
          op: "read",
          ...scope,
          key,
          index: page.index,
          hash: page.hash,
        });
        if (!(part instanceof Uint8Array)) {
          throw new Error("Expected exact Git observation bytes");
        }
        expect(digest(part)).toBe(page.hash);
        bytes.set(part, offset);
        offset += part.length;
      }
    }
    expect(offset).toBe(range.bytes);
    expect(digest(bytes)).toBe(range.hash);
    return JSON.parse(new TextDecoder().decode(bytes)) as GitContext;
  }

  it("streams both real driver classes and preserves exact page and substream hashes", async () => {
    const text = '"\\🐈'.repeat(5000);
    const claudeBytes = new TextEncoder().encode(
      JSON.stringify({
        type: "user",
        uuid: "message",
        message: { content: text },
      }) + "\n",
    );
    const codexBytes = new TextEncoder().encode(
      JSON.stringify({
        type: "response_item",
        payload: {
          id: "native-id",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "codex" }],
        },
      }) + "\n",
    );
    await Deno.writeFile(
      `${root}/claude/projects/project/${id}.jsonl`,
      claudeBytes,
    );
    await Deno.writeFile(`${root}/codex/sessions/${id}.jsonl`, codexBytes);
    expect(
      await publisher.publish([claude, codex], {
        scratchDirectory: `${root}/scratch`,
        limits: { readBytes: 4096, pageBytes: 4096 },
      }),
    ).toBe(2);
    expect(publications).toBe(1);
    expect(catalog.sources.map((source) => source.complete)).toEqual([
      true,
      true,
    ]);
    const scope = {
      archive: catalog.archive,
      generation: catalog.generation,
      pin: (await control({
        op: "pin",
        archive: catalog.archive,
        generation: catalog.generation,
      })).pin!,
    };
    try {
      for (
        const [source, original] of [["claude", claudeBytes], [
          "codex",
          codexBytes,
        ]] as const
      ) {
        const key = `${source}/${id}`;
        const record =
          (await control({ op: "get", ...scope, key })).records![0];
        const metadata = JSON.parse(record.metadata) as ArchivedSession;
        expect(metadata.nativeBytes).toBe(original.length);
        expect(metadata.eventCount).toBe(1);
        expect(metadata.messageCount).toBe(1);
        const hash = createHash("sha256");
        let count = 0;
        let after: number | undefined;
        while (true) {
          const pages = (await control({
            op: "pages",
            ...scope,
            key,
            ...(after === undefined ? {} : { after }),
          })).pages!;
          if (pages.length === 0) break;
          for (const page of pages) {
            expect(page.bytes).toBeLessThanOrEqual(4096);
            const bytes = await session.archive({
              op: "read",
              ...scope,
              key,
              index: page.index,
              hash: page.hash,
            });
            if (!(bytes instanceof Uint8Array)) {
              throw new Error("Expected native bytes");
            }
            expect(digest(bytes)).toBe(page.hash);
            const description = JSON.parse(
              page.metadata,
            ) as AgentArchivePageMetadata;
            if (description.kind === "native") {
              hash.update(bytes);
              count += bytes.length;
            }
            if (description.kind === "native-end") {
              expect(description.hash).toBe(digest(original));
              expect(description.bytes).toBe(original.length);
            }
          }
          after = pages.at(-1)!.index;
        }
        expect(hash.digest("hex")).toBe(digest(original));
        expect(count).toBe(original.length);
      }
    } finally {
      await control({ op: "release", archive: scope.archive, pin: scope.pin });
    }
    expect((await session.listEntityIds())?.ids).toEqual([]);
    expect(JSON.stringify(catalog)).not.toContain(text.slice(0, 500));
  });

  it("retains a complete session after a partial read and removes it after complete missing-file discovery", async () => {
    const path = `${root}/claude/projects/project/${id}.jsonl`;
    await Deno.writeTextFile(
      path,
      '{"type":"user","message":{"content":"complete"}}\n',
    );
    const options = { scratchDirectory: `${root}/scratch` };
    expect(await publisher.publish([claude], options)).toBe(1);
    await Deno.writeTextFile(path, '{"type":"user","message":');
    expect(await publisher.publish([claude], options)).toBe(1);
    expect(catalog.sources[0].complete).toBe(false);
    const scope = {
      archive: catalog.archive,
      generation: catalog.generation,
      pin: (await control({
        op: "pin",
        archive: catalog.archive,
        generation: catalog.generation,
      })).pin!,
    };
    const record =
      (await control({ op: "get", ...scope, key: `claude/${id}` })).records![0];
    expect(record.partial).toBe(true);
    expect((JSON.parse(record.metadata) as ArchivedSession).summary.title).toBe(
      "complete",
    );
    await control({ op: "release", archive: scope.archive, pin: scope.pin });
    await Deno.remove(path);
    expect(await publisher.publish([claude], options)).toBe(0);
    expect(catalog.sources[0].complete).toBe(true);
  });

  it("aborts an interrupted generation before changing the visible pointer and permits the next collection", async () => {
    await Deno.writeTextFile(
      `${root}/claude/projects/project/${id}.jsonl`,
      '{"type":"user","message":{"content":"complete"}}\n',
    );
    const controller = new AbortController();
    await expect(
      publisher.publish([claude], {
        scratchDirectory: `${root}/scratch`,
        signal: controller.signal,
        observe(stage) {
          if (stage === "publication") {
            controller.abort(new Error("Collection interrupted"));
          }
        },
      }),
    ).rejects.toThrow("Collection interrupted");
    expect(publications).toBe(0);
    const binding = (await control({ op: "open", handle: "native-catalog" }))
      .binding!;
    expect(binding.generation).toBeNull();
    expect(binding.pendingGeneration).toBeNull();
    expect(
      await publisher.publish([claude], {
        scratchDirectory: `${root}/scratch`,
      }),
    ).toBe(1);
    expect(publications).toBe(1);
  });

  it("keeps the previous catalog current after a partial first scan and publishes every source on recovery", async () => {
    await Deno.writeTextFile(
      `${root}/claude/projects/project/${id}.jsonl`,
      '{"type":"user","message":',
    );
    await Deno.writeTextFile(
      `${root}/codex/sessions/${id}.jsonl`,
      '{"type":"session_meta","payload":{"id":"00000000-0000-4000-8000-000000000001"}}\n',
    );
    const options = { scratchDirectory: `${root}/scratch` };
    await expect(publisher.publish([claude, codex], options)).rejects.toThrow(
      "migration is incomplete",
    );
    expect(publications).toBe(0);
    const binding = (await control({ op: "open", handle: "native-catalog" }))
      .binding!;
    expect(binding.generation).toBeNull();
    expect(binding.pendingGeneration).toBeNull();
    await Deno.writeTextFile(
      `${root}/claude/projects/project/${id}.jsonl`,
      '{"type":"user","message":{"content":"recovered"}}\n',
    );
    expect(await publisher.publish([claude, codex], options)).toBe(2);
    expect(publications).toBe(1);
    expect(catalog.sources.map(({ source, complete }) => [source.id, complete]))
      .toEqual([["claude", true], ["codex", true]]);
  });

  it("preserves the observed checkout head, remotes, and time in session metadata", async () => {
    const context: GitContext = {
      gitRepo: "https://example.test/repository.git",
      gitBranch: "main",
      gitWorktreeRoot: "/synthetic/checkout",
      gitHeadSha: "a".repeat(40),
      gitRemotes: [{
        name: "origin",
        urls: ["https://example.test/repository.git"],
      }],
      gitObservedAt: "2026-09-08T12:00:00.000Z",
    };
    await Deno.writeTextFile(
      `${root}/claude/projects/project/${id}.jsonl`,
      '{"type":"user","message":{"content":"complete"}}\n',
    );
    await publisher.publish([claude], {
      scratchDirectory: `${root}/scratch`,
      gitContext: {
        resolve: () => Promise.resolve(context),
        resolveCheckout: () => Promise.resolve(context),
        validateCheckout: () => Promise.resolve(true),
        enrich: (snapshot) => Promise.resolve(snapshot),
      },
    });
    const scope = {
      archive: catalog.archive,
      generation: catalog.generation,
      pin: (await control({
        op: "pin",
        archive: catalog.archive,
        generation: catalog.generation,
      })).pin!,
    };
    try {
      const record =
        (await control({ op: "get", ...scope, key: `claude/${id}` }))
          .records![0];
      const metadata = JSON.parse(record.metadata) as ArchivedSession;
      expect(await gitValue(scope, record.key, metadata.gitContext!)).toEqual(
        context,
      );
    } finally {
      await control({ op: "release", archive: scope.archive, pin: scope.pin });
    }
  });

  it("pages complete Git observations for sessions and checkouts without changing the native hash", async () => {
    const context: GitContext = {
      gitRepo: "https://example.test/repository.git",
      gitBranch: "main",
      gitWorktreeRoot: "/synthetic/checkout",
      gitHeadSha: "b".repeat(40),
      gitRemotes: Array.from(
        { length: 50 },
        (_, index) => ({
          name: `remote-${index}`,
          urls: [`https://example.test/${"long-path/".repeat(40)}${index}.git`],
        }),
      ),
      gitObservedAt: "2026-09-08T12:00:00.000Z",
    };
    expect(new TextEncoder().encode(JSON.stringify(context)).length)
      .toBeGreaterThan(ARCHIVE_LIMITS.metadataBytes);
    await Deno.writeTextFile(
      `${root}/claude/projects/project/${id}.jsonl`,
      '{"type":"user","message":{"content":"complete"}}\n',
    );
    const options: ArchiveCollectionOptions = {
      scratchDirectory: `${root}/scratch`,
      limits: { pageBytes: 1024 },
      checkoutDirectories: [context.gitWorktreeRoot!],
      gitContext: {
        resolve: () => Promise.resolve(context),
        resolveCheckout: () => Promise.resolve(context),
        validateCheckout: () => Promise.resolve(true),
        enrich: (snapshot) => Promise.resolve(snapshot),
      },
    };
    let nativeHash: string | undefined;
    let gitHash: string | undefined;
    for (let observation = 0; observation < 2; observation++) {
      context.gitObservedAt = `2026-09-08T12:00:0${observation}.000Z`;
      expect(await publisher.publish([claude], options)).toBe(1);
      expect(catalog.sessionCount).toBe(1);
      expect(catalog.checkoutCount).toBe(1);
      const scope = {
        archive: catalog.archive,
        generation: catalog.generation,
        pin: (await control({
          op: "pin",
          archive: catalog.archive,
          generation: catalog.generation,
        })).pin!,
      };
      try {
        const records = (await control({ op: "list", ...scope })).records!;
        expect(records).toHaveLength(2);
        for (const record of records) {
          expect(new TextEncoder().encode(record.metadata).length)
            .toBeLessThanOrEqual(ARCHIVE_LIMITS.metadataBytes);
          const metadata = JSON.parse(record.metadata) as
            | ArchivedSession
            | ArchivedCheckout;
          const range = metadata.gitContext!;
          expect(range.pageCount).toBeGreaterThan(16);
          expect(range.hash).toBe(
            digest(new TextEncoder().encode(JSON.stringify(context))),
          );
          expect(metadata.pageCount).toBe(range.firstPage + range.pageCount);
          expect(await gitValue(scope, record.key, range, 1024)).toEqual(
            context,
          );
          if (metadata.schema === "commonfabric.agent-connector.session.v2") {
            if (nativeHash !== undefined) {
              expect(metadata.contentHash).toBe(nativeHash);
              expect(range.hash).not.toBe(gitHash);
            }
            nativeHash = metadata.contentHash;
            gitHash = range.hash;
          } else expect(range.firstPage).toBe(0);
        }
      } finally {
        await control({
          op: "release",
          archive: scope.archive,
          pin: scope.pin,
        });
      }
    }
  });

  it("keeps source inventory and retained counts after a targeted refresh", async () => {
    for (const nativeId of [id, "00000000-0000-4000-8000-000000000002"]) {
      await Deno.writeTextFile(
        `${root}/claude/projects/project/${nativeId}.jsonl`,
        '{"type":"user","message":{"content":"complete"}}\n',
      );
    }
    await Deno.writeTextFile(
      `${root}/codex/sessions/${id}.jsonl`,
      '{"type":"session_meta","payload":{}}\n',
    );
    const options = { scratchDirectory: `${root}/scratch` };
    expect(await publisher.publish([claude, codex], options)).toBe(3);
    expect(
      await publisher.publish([claude], { ...options, nativeSessionId: id }),
    ).toBe(3);
    expect(
      catalog.sources.map((
        { source, sessionCount, complete },
      ) => [source.id, sessionCount, complete]),
    ).toEqual([["claude", 2, false], ["codex", 1, true]]);
  });

  it("keeps changed native bytes while copying the last complete Git range", async () => {
    const complete: GitContext = {
      gitRepo: "https://example.test/repository.git",
      gitBranch: "main",
      gitWorktreeRoot: "/synthetic/checkout",
      gitHeadSha: "c".repeat(40),
      gitRemotes: Array.from(
        { length: 30 },
        (_, index) => ({
          name: `remote-${index}`,
          urls: [`https://example.test/${"long-path/".repeat(20)}${index}.git`],
        }),
      ),
      gitObservedAt: "2026-09-08T12:00:00.000Z",
    };
    const failed: GitContext = {
      gitRepo: null,
      gitBranch: null,
      gitWorktreeRoot: null,
      gitHeadSha: null,
      gitRemotes: [],
      gitObservedAt: null,
      gitObservationFailed: true,
    };
    let context = failed;
    const path = `${root}/claude/projects/project/${id}.jsonl`;
    await Deno.writeTextFile(
      path,
      '{"type":"user","cwd":"/synthetic/checkout","message":{"content":"first"}}\n',
    );
    const options: ArchiveCollectionOptions = {
      scratchDirectory: `${root}/scratch`,
      limits: { pageBytes: 4096 },
      gitContext: {
        resolve: () => Promise.resolve(context),
        resolveCheckout: () => Promise.resolve(context),
        validateCheckout: () => Promise.resolve(true),
        enrich: (snapshot) => Promise.resolve(snapshot),
      },
    };
    await publisher.publish([claude], options);
    let scope = {
      archive: catalog.archive,
      generation: catalog.generation,
      pin: (await control({
        op: "pin",
        archive: catalog.archive,
        generation: catalog.generation,
      })).pin!,
    };
    try {
      const record =
        (await control({ op: "get", ...scope, key: `claude/${id}` }))
          .records![0];
      const initial = JSON.parse(record.metadata);
      expect(initial.gitObservationFailed).toBe(true);
      expect(await gitValue(scope, record.key, initial.gitContext)).toEqual(
        failed,
      );
    } finally {
      await control({ op: "release", archive: scope.archive, pin: scope.pin });
    }
    context = complete;
    await publisher.publish([claude], options);
    const completeGeneration = catalog.generation;
    scope = {
      archive: catalog.archive,
      generation: catalog.generation,
      pin: (await control({
        op: "pin",
        archive: catalog.archive,
        generation: catalog.generation,
      })).pin!,
    };
    let prior: ArchivedSession;
    try {
      prior = JSON.parse(
        (await control({ op: "get", ...scope, key: `claude/${id}` }))
          .records![0].metadata,
      ) as ArchivedSession;
    } finally {
      await control({ op: "release", archive: scope.archive, pin: scope.pin });
    }
    const currentBytes = new TextEncoder().encode(
      JSON.stringify({
        type: "user",
        cwd: "/synthetic/checkout",
        message: { content: "updated ".repeat(600) },
      }) + "\n",
    );
    await Deno.writeFile(path, currentBytes);
    context = failed;
    const controller = new AbortController();
    {
      const read = session.archive.bind(session);
      using interrupted = stub(session, "archive", async (...args) => {
        const result = await read(...args);
        if (
          args[0].op === "read" && args[0].generation === completeGeneration
        ) controller.abort(new Error("Git range copy interrupted"));
        return result;
      });
      await expect(
        publisher.publish([claude], { ...options, signal: controller.signal }),
      ).rejects.toThrow("Git range copy interrupted");
      expect(interrupted.calls.some(({ args }) => args[0].op === "read")).toBe(
        true,
      );
    }
    expect(catalog.generation).toBe(completeGeneration);
    const pins: string[] = [];
    try {
      for (let index = 0; index < ARCHIVE_LIMITS.principalPins; index++) {
        pins.push(
          (await control({
            op: "pin",
            archive: catalog.archive,
            generation: completeGeneration,
          })).pin!,
        );
      }
    } finally {
      for (const pin of pins) {
        await control({ op: "release", archive: catalog.archive, pin });
      }
    }
    await publisher.publish([claude], {
      ...options,
      limits: { pageBytes: 1024 },
    });
    scope = {
      archive: catalog.archive,
      generation: catalog.generation,
      pin: (await control({
        op: "pin",
        archive: catalog.archive,
        generation: catalog.generation,
      })).pin!,
    };
    try {
      const record =
        (await control({ op: "get", ...scope, key: `claude/${id}` }))
          .records![0];
      const current = JSON.parse(record.metadata);
      expect(record.partial).toBe(false);
      expect(current.gitObservationFailed).toBe(true);
      expect(current.gitObservedAt).toBe(complete.gitObservedAt);
      expect(current.summary.gitWorktreeRoot).toBe(complete.gitWorktreeRoot);
      expect(current.nativeBytes).toBe(currentBytes.length);
      expect(current.contentHash).not.toBe(prior.contentHash);
      expect(current.gitContext.hash).toBe(prior.gitContext!.hash);
      expect(current.gitContext.firstPage).not.toBe(
        prior.gitContext!.firstPage,
      );
      expect(current.gitContext.pageCount).toBeGreaterThan(
        prior.gitContext!.pageCount,
      );
      expect(await gitValue(scope, record.key, current.gitContext, 1024))
        .toEqual(complete);
    } finally {
      await control({ op: "release", archive: scope.archive, pin: scope.pin });
    }
    await expect(
      control({
        op: "pin",
        archive: catalog.archive,
        generation: completeGeneration,
      }),
    ).rejects.toThrow("Archive generation is unavailable");
  });

  it("rejects an initial targeted scan before either catalog pointer changes", async () => {
    await Deno.writeTextFile(
      `${root}/claude/projects/project/${id}.jsonl`,
      '{"type":"user","message":{"content":"complete"}}\n',
    );
    await expect(
      publisher.publish([claude], {
        scratchDirectory: `${root}/scratch`,
        nativeSessionId: id,
      }),
    ).rejects.toThrow("migration is incomplete");
    expect(publications).toBe(0);
    const binding = (await control({ op: "open", handle: "native-catalog" }))
      .binding!;
    expect(binding.generation).toBeNull();
    expect(binding.pendingGeneration).toBeNull();
  });

  it("reports a failed targeted refresh without changing the complete catalog", async () => {
    const path = `${root}/claude/projects/project/${id}.jsonl`;
    await Deno.writeTextFile(
      path,
      '{"type":"user","message":{"content":"complete"}}\n',
    );
    const options = { scratchDirectory: `${root}/scratch` };
    await publisher.publish([claude], options);
    const generation = catalog.generation;
    await Deno.writeTextFile(path, '{"type":"user","message":');
    await expect(
      publisher.publish([claude], { ...options, nativeSessionId: id }),
    ).rejects.toThrow("Targeted native session refresh is incomplete");
    expect(publications).toBe(1);
    expect(catalog.generation).toBe(generation);
    const binding = (await control({ op: "open", handle: "native-catalog" }))
      .binding!;
    expect(binding.generation).toBe(generation);
    expect(binding.pendingGeneration).toBeNull();
  });

  it("keeps sixteen sources with escaped error examples inside the control byte budget", async () => {
    let failing = false;
    const drivers = Array.from({ length: 16 }, (_, index) => {
      const driver = new ClaudeAgentSdkDriver({
        id: "s".repeat(125) + String(index).padStart(3, "0"),
        driver: "claude-agent-sdk",
        enabled: true,
        configDir: `${root}/claude`,
      });
      driver.streamSessions = async function* () {
        await Promise.resolve();
        if (!failing) return;
        for (let item = 0; item < 16; item++) {
          yield {
            summary: {
              nativeSessionId: `session-${item}`.padEnd(127, "x"),
              title: null,
              cwd: null,
              createdAt: null,
              updatedAt: null,
              archived: null,
              active: null,
            },
            format: "claude-project-jsonl",
            revision: "synthetic",
            parts: {
              [Symbol.asyncIterator]() {
                return {
                  next: () =>
                    Promise.reject(
                      new Error("\u0000".repeat(item % 2 === 0 ? 1000 : 100)),
                    ),
                };
              },
            },
          };
        }
      };
      return driver;
    });
    const options = { scratchDirectory: `${root}/scratch` };
    await publisher.publish(drivers, options);
    failing = true;
    await publisher.publish(drivers, options);
    expect(catalog.sources).toHaveLength(16);
    expect(
      catalog.sources.every((source) =>
        source.errorCount === 16 && !source.complete
      ),
    ).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(catalog)).length)
      .toBeLessThanOrEqual(ARCHIVE_LIMITS.controlBytes);
    expect(
      new TextEncoder().encode(JSON.stringify(JSON.stringify(catalog))).length,
    ).toBeLessThanOrEqual(ARCHIVE_LIMITS.controlBytes);
  });
});
