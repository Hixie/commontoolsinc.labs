/** Native session catalog and pull-based archive publication. */

import { createHasher, sha256 } from "@commonfabric/content-hash";
import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";
import {
  ARCHIVE_LIMITS,
  type ArchiveBinding,
  type ArchiveCommand,
  type ArchiveLimits,
  ArchivePinOwner,
  type ArchiveResult,
  requireArchiveLimits,
} from "@commonfabric/memory/v2/archive";
import type {
  AgentDriver,
  NormalizedMessage,
  SourceDescriptor,
} from "./types.ts";
import type { GitContext, GitContextObservation } from "./git-context.ts";
import { sessionKey } from "./session-contract.ts";
import {
  type CollectionLimits,
  collectionLimits,
  type CollectionObserver,
  type NativeProvenance,
  type SessionStream,
  type SessionStreamPart,
  type StreamSessionSummary,
} from "./session-stream.ts";

/** The Fabric root contains one generation pointer and bounded source health. */
export interface AgentArchiveCatalog {
  schema: "commonfabric.agent-connector.catalog.v2";
  ownerDid: string;
  archive: string;
  generation: string;
  generatedAt: string;
  sessionCount: number;
  checkoutCount: number;
  sources: ArchiveSourceResult[];
}

/** Bounded metadata for one complete native session in the archive catalog. */
export interface ArchivedSession {
  schema: "commonfabric.agent-connector.session.v2";
  sourceId: string;
  driver: SourceDescriptor["driver"];
  summary: StreamSessionSummary;
  format: SessionStream["format"];
  revision: string;
  nativeBytes: number;
  eventCount: number;
  messageCount: number;
  pageCount: number;
  contentHash: string;
  recentMessages: NormalizedMessage[];
  gitContext: ArchiveValueRange | null;
  gitObservedAt: string | null;
  gitWorktreeRootHash: string | null;
  gitObservationFailed: boolean;
}

/** Consecutive immutable pages containing one complete JSON value. */
export interface ArchiveValueRange {
  firstPage: number;
  pageCount: number;
  bytes: number;
  hash: string;
}

/** Bounded checkout previews with the complete Git observation in byte pages. */
export interface ArchivedCheckout {
  schema: "commonfabric.agent-connector.checkout.v2";
  gitRepo: string | null;
  gitBranch: string | null;
  gitWorktreeRoot: string | null;
  pageCount: number;
  gitContext: ArchiveValueRange;
}

/** A native byte page, preview page, or completed native substream digest. */
export type AgentArchivePageMetadata =
  | { kind: "native"; provenance: NativeProvenance; offset: number }
  | { kind: "messages" }
  | { kind: "git-context"; offset: number }
  | {
    kind: "native-end";
    provenance: NativeProvenance;
    bytes: number;
    hash: string;
  };

/** Source health bounds examples by count and encoded bytes and keeps the full error count. */
export interface ArchiveSourceResult {
  source: SourceDescriptor;
  sessionCount: number;
  complete: boolean;
  errorCount: number;
  errors: Array<{ nativeSessionId?: string; message: string }>;
}

/** Imperative storage operations that never add archive data to a replica. */
export interface AgentArchiveConnection {
  archiveLimits(): Promise<ArchiveLimits>;
  archive(
    command: ArchiveCommand,
    data?: Uint8Array,
    signal?: AbortSignal,
  ): Promise<ArchiveResult | Uint8Array>;
}

/** Collection inputs are consumed after the previous source has been published. */
export interface ArchiveCollectionOptions {
  scratchDirectory: string;
  limits?: Partial<CollectionLimits>;
  signal?: AbortSignal;
  observe?: CollectionObserver;
  nativeSessionId?: string;
  checkoutDirectories?: AsyncIterable<string> | Iterable<string>;
  gitContext?: GitContextObservation;
  onSource?: (result: ArchiveSourceResult) => void;
  onCommit?: () => void;
}

/** Reserved catalog source for discovered checkouts. */
export const CHECKOUT_ARCHIVE_SOURCE = "@checkouts";

const hash = (value: string | Uint8Array) =>
  encodeHex(sha256(
    typeof value === "string" ? new TextEncoder().encode(value) : value,
  ));
const encodedBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const SOURCE_ERRORS_BYTES = ARCHIVE_LIMITS.controlBytes / 32;

/** Truncates an example by its encoded JSON bytes, including string escapes. */
function metadataPreview(value: string, maximum: number): string {
  let result = "";
  let bytes = 2;
  for (const character of value) {
    bytes += encodedBytes(character) - 2;
    if (bytes + 3 > maximum) return `${result}…`;
    result += character;
  }
  return result;
}

/** Fits derived previews into the record budget while native pages keep complete values. */
function sessionMetadata(metadata: ArchivedSession): string {
  const serialized = JSON.stringify(metadata);
  if (
    new TextEncoder().encode(serialized).length <= ARCHIVE_LIMITS.metadataBytes
  ) {
    return serialized;
  }
  const previewFields = new Set([
    "title",
    "cwd",
    "gitRepo",
    "gitBranch",
    "gitWorktreeRoot",
    "createdAt",
    "updatedAt",
    "id",
    "parentId",
    "kind",
    "textPreview",
  ]);
  let previews = 0;
  const base = JSON.stringify(metadata, (key, value) => {
    if (previewFields.has(key) && typeof value === "string") {
      previews++;
      return "";
    }
    return value;
  });
  const available = ARCHIVE_LIMITS.metadataBytes -
    new TextEncoder().encode(base).length;
  const budget = 2 + Math.floor(available / previews);
  if (previews === 0 || budget < 5) {
    throw new Error(
      "Native session identity exceeds the archive metadata budget",
    );
  }
  return JSON.stringify(
    metadata,
    (key, value) =>
      previewFields.has(key) && typeof value === "string"
        ? metadataPreview(value, budget)
        : value,
  );
}

function gitPreviews(
  context: GitContext,
): Pick<GitContext, "gitRepo" | "gitBranch" | "gitWorktreeRoot"> {
  const preview = (value: string | null) =>
    value === null ? null : metadataPreview(value, 512);
  return {
    gitRepo: preview(context.gitRepo),
    gitBranch: preview(context.gitBranch),
    gitWorktreeRoot: preview(context.gitWorktreeRoot),
  };
}

interface ArchivePageWriter {
  readonly count: number;
  write(bytes: Uint8Array, metadata: AgentArchivePageMetadata): Promise<void>;
}

interface CapturedGitObservation {
  range: ArchiveValueRange;
  preview: ReturnType<typeof gitPreviews>;
  observedAt: string | null;
  rootHash: string | null;
  failed: boolean;
  retained: boolean;
}

/** Publishes complete generations with bounded native buffers and metadata. */
export class AgentArchivePublisher {
  readonly #connection: AgentArchiveConnection;
  readonly #handle: string;
  readonly #ownerDid: string;
  readonly #publishCatalog: (catalog: AgentArchiveCatalog) => Promise<void>;
  readonly #pins = new Map<string, ArchivePinOwner>();
  #catalog: AgentArchiveCatalog | undefined;

  constructor(
    connection: AgentArchiveConnection,
    handle: string,
    ownerDid: string,
    publishCatalog: (catalog: AgentArchiveCatalog) => Promise<void>,
    catalog?: AgentArchiveCatalog,
  ) {
    this.#connection = connection;
    this.#handle = handle;
    this.#ownerDid = ownerDid;
    this.#publishCatalog = publishCatalog;
    this.#catalog = catalog;
  }

  /** Negotiates the transport before opening native sources. */
  async ready(): Promise<void> {
    requireArchiveLimits(await this.#connection.archiveLimits());
  }

  async #control(
    command: ArchiveCommand,
    signal?: AbortSignal,
  ): Promise<ArchiveResult> {
    const result = await this.#connection.archive(command, undefined, signal);
    if (result instanceof Uint8Array) {
      throw new Error("Archive returned native bytes for a control request");
    }
    return result;
  }

  async #pin(
    scope: { archive: string; generation: string },
    signal?: AbortSignal,
  ): Promise<string> {
    const owner = new ArchivePinOwner(
      scope,
      (command, signal) => this.#control(command, signal),
    );
    this.#pins.set(owner.pin, owner);
    await owner.acquire(signal);
    return owner.pin;
  }

  async #releasePin(pin: string): Promise<void> {
    const owner = this.#pins.get(pin);
    if (owner === undefined) return;
    await owner.close();
    this.#pins.delete(pin);
  }

  /** Releases owned pins before another publication can acquire resources. */
  async #releasePendingPins(): Promise<void> {
    await using cleanup = new AsyncDisposableStack();
    for (const pin of this.#pins.keys()) {
      cleanup.defer(() => this.#releasePin(pin));
    }
  }

  #pageWriter(
    scope: { archive: string; generation: string; record: string },
    options: ArchiveCollectionOptions,
  ): ArchivePageWriter {
    let index = 0;
    return {
      get count() {
        return index;
      },
      write: async (bytes, metadata) => {
        options.observe?.("planning");
        options.signal?.throwIfAborted();
        await this.#connection.archive(
          {
            op: "put",
            ...scope,
            index,
            hash: hash(bytes),
            bytes: bytes.length,
            metadata: JSON.stringify(metadata),
          },
          bytes,
          options.signal,
        );
        index++;
        options.observe?.("publication");
      },
    };
  }

  async #gitPages(
    context: GitContext,
    pages: ArchivePageWriter,
    limits: CollectionLimits,
  ): Promise<ArchiveValueRange> {
    const bytes = new TextEncoder().encode(JSON.stringify(context));
    const firstPage = pages.count;
    for (let offset = 0; offset < bytes.length; offset += limits.pageBytes) {
      await pages.write(bytes.subarray(offset, offset + limits.pageBytes), {
        kind: "git-context",
        offset,
      });
    }
    return {
      firstPage,
      pageCount: pages.count - firstPage,
      bytes: bytes.length,
      hash: hash(bytes),
    };
  }

  async #sessionGit(
    binding: ArchiveBinding,
    key: string,
    context: GitContext,
    pages: ArchivePageWriter,
    limits: CollectionLimits,
    options: ArchiveCollectionOptions,
  ): Promise<CapturedGitObservation> {
    const rootHash = context.gitWorktreeRoot === null
      ? null
      : hash(context.gitWorktreeRoot);
    const failed = context.gitObservationFailed === true ||
      (context.gitWorktreeRoot !== null && context.gitObservedAt === null);
    if (failed && binding.generation !== null) {
      const scope = { archive: binding.id, generation: binding.generation };
      const pin = await this.#pin(scope, options.signal);
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => this.#releasePin(pin));
      const record = (await this.#control(
        { op: "get", ...scope, pin, key },
        options.signal,
      )).records?.[0];
      const previous = record
        ? JSON.parse(record.metadata) as ArchivedSession
        : undefined;
      if (
        previous?.schema === "commonfabric.agent-connector.session.v2" &&
        previous.gitContext &&
        typeof previous.gitObservedAt === "string" &&
        previous.gitObservedAt.length > 0 &&
        (context.gitObservationFailed === true ||
          rootHash === previous.gitWorktreeRootHash)
      ) {
        const range = previous.gitContext;
        const end = range.firstPage + range.pageCount;
        if (
          !Number.isSafeInteger(range.firstPage) || range.firstPage < 0 ||
          !Number.isSafeInteger(range.pageCount) || range.pageCount < 1 ||
          !Number.isSafeInteger(previous.pageCount) ||
          !Number.isSafeInteger(end) || end > previous.pageCount ||
          !Number.isSafeInteger(range.bytes) || range.bytes < 1 ||
          !/^[a-f0-9]{64}$/.test(range.hash)
        ) {
          throw new Error(
            "Previous Git observation has an invalid page range",
          );
        }
        const firstPage = pages.count;
        const digest = createHasher();
        let index = range.firstPage;
        let offset = 0;
        while (index < end) {
          options.signal?.throwIfAborted();
          const directory = (await this.#control({
            op: "pages",
            ...scope,
            pin,
            key,
            ...(index > 0 ? { after: index - 1 } : {}),
            limit: Math.min(ARCHIVE_LIMITS.rows, end - index),
          }, options.signal)).pages!;
          if (directory.length === 0) {
            throw new Error("Previous Git observation is missing pages");
          }
          for (const page of directory) {
            const metadata = JSON.parse(
              page.metadata,
            ) as AgentArchivePageMetadata;
            if (
              page.index !== index || index >= end ||
              metadata.kind !== "git-context" || metadata.offset !== offset
            ) {
              throw new Error(
                "Previous Git observation pages are not contiguous",
              );
            }
            const bytes = await this.#connection.archive(
              { op: "read", ...scope, pin, key, index, hash: page.hash },
              undefined,
              options.signal,
            );
            if (
              !(bytes instanceof Uint8Array) || bytes.length !== page.bytes ||
              hash(bytes) !== page.hash
            ) throw new Error("Previous Git observation page is invalid");
            for (
              let position = 0;
              position < bytes.length;
              position += limits.pageBytes
            ) {
              await pages.write(
                bytes.subarray(position, position + limits.pageBytes),
                { kind: "git-context", offset: offset + position },
              );
            }
            digest.update(bytes);
            offset += bytes.length;
            index++;
          }
        }
        if (
          offset !== range.bytes || encodeHex(digest.digest()) !== range.hash
        ) {
          throw new Error(
            "Previous Git observation does not match its digest",
          );
        }
        return {
          range: {
            firstPage,
            pageCount: pages.count - firstPage,
            bytes: offset,
            hash: range.hash,
          },
          preview: {
            gitRepo: previous.summary.gitRepo ?? null,
            gitBranch: previous.summary.gitBranch ?? null,
            gitWorktreeRoot: previous.summary.gitWorktreeRoot ?? null,
          },
          observedAt: previous.gitObservedAt,
          rootHash: previous.gitWorktreeRootHash ?? null,
          failed: true,
          retained: true,
        };
      }
    }
    return {
      range: await this.#gitPages(context, pages, limits),
      preview: gitPreviews(context),
      observedAt: context.gitObservedAt === null
        ? null
        : metadataPreview(context.gitObservedAt, 128),
      rootHash,
      failed,
      retained: false,
    };
  }

  /** Each operation starts from the authoritative server generation. */
  async publish(
    drivers: Iterable<AgentDriver>,
    options: ArchiveCollectionOptions,
  ): Promise<number> {
    await this.ready();
    await this.#releasePendingPins();
    const limits = collectionLimits(options.limits);
    const { signal, observe } = options;
    signal?.throwIfAborted();
    const { binding } = await this.#control({
      op: "open",
      handle: this.#handle,
    }, signal);
    if (!binding || binding.owner !== this.#ownerDid) {
      throw new Error("Archive binding belongs to another owner");
    }
    await using cleanup = new AsyncDisposableStack();
    const visiblePin = this.#catalog
      ? await this.#pin({
        archive: binding.id,
        generation: this.#catalog.generation,
      }, signal)
      : undefined;
    if (visiblePin) cleanup.defer(() => this.#releasePin(visiblePin));
    if (binding.pendingGeneration) {
      await this.#control({
        op: "abort",
        archive: binding.id,
        generation: binding.pendingGeneration,
      }, signal);
    }
    if (binding.generation !== null) {
      await this.#control({
        op: "prune",
        archive: binding.id,
        generation: binding.generation,
      }, signal);
    }
    const generation = crypto.randomUUID();
    const scope = { archive: binding.id, generation };
    await this.#control(
      { op: "begin", ...scope, base: binding.generation },
      signal,
    );
    let published = false;
    cleanup.defer(async () => {
      if (!published) await this.#control({ op: "abort", ...scope });
    });
    const sources: ArchiveSourceResult[] = [];
    for (const driver of drivers) {
      if (sources.length === 16) {
        throw new Error("Archive collection exceeds 16 sources");
      }
      if (!driver.streamSessions) {
        throw new Error(
          `Driver has no bounded native collection: ${driver.source.driver}`,
        );
      }
      if (driver.source.id === CHECKOUT_ARCHIVE_SOURCE) {
        throw new Error("Source identity is reserved for checkouts");
      }
      const result: ArchiveSourceResult = {
        source: driver.source,
        sessionCount: 0,
        complete: true,
        errorCount: 0,
        errors: [],
      };
      let errorBytes = 2;
      const failed = (error: unknown, nativeSessionId?: string) => {
        result.complete = false;
        result.errorCount++;
        if (result.errors.length === 16) return;
        const example = {
          ...(nativeSessionId
            ? { nativeSessionId: metadataPreview(nativeSessionId, 256) }
            : {}),
          message: metadataPreview(
            error instanceof Error ? error.message : String(error),
            1000,
          ),
        };
        const bytes = encodedBytes(example) + 1;
        if (errorBytes + bytes <= SOURCE_ERRORS_BYTES) {
          result.errors.push(example);
          errorBytes += bytes;
        }
      };
      const iterator = driver.streamSessions({
        limits,
        signal,
        observe,
        nativeSessionId: options.nativeSessionId,
        scratchDirectory: join(
          options.scratchDirectory,
          hash(driver.source.id),
        ),
      })[Symbol.asyncIterator]();
      try {
        while (true) {
          signal?.throwIfAborted();
          let next: IteratorResult<SessionStream>;
          try {
            next = await iterator.next();
          } catch (error) {
            signal?.throwIfAborted();
            failed(error);
            break;
          }
          if (next.done) break;
          const error = await this.#session(
            binding,
            generation,
            driver.source,
            next.value,
            limits,
            options,
          );
          if (error !== undefined) {
            failed(error, next.value.summary.nativeSessionId);
          } else result.sessionCount++;
        }
      } finally {
        await iterator.return?.();
      }
      if (
        options.nativeSessionId !== undefined && result.sessionCount === 0 &&
        result.complete
      ) {
        failed(
          new Error("Native session was not found"),
          options.nativeSessionId,
        );
      }
      result.complete &&= options.nativeSessionId === undefined;
      await this.#control({
        op: "source",
        ...scope,
        source: driver.source.id,
        complete: result.complete,
      }, signal);
      sources.push(result);
      options.onSource?.(result);
    }
    if (
      !this.#catalog &&
      (options.nativeSessionId !== undefined ||
        sources.some((source) => !source.complete))
    ) {
      throw new Error(
        "Agent archive migration is incomplete: the first catalog requires a complete native scan. The previous catalog remains current.",
      );
    }
    if (
      options.nativeSessionId !== undefined &&
      sources.some((source) => source.errorCount > 0)
    ) {
      throw new Error(
        "Targeted native session refresh is incomplete. The previous catalog remains current.",
      );
    }
    if (options.checkoutDirectories !== undefined) {
      for await (const directory of options.checkoutDirectories) {
        signal?.throwIfAborted();
        const context = await options.gitContext?.resolveCheckout(
          directory,
          signal,
        );
        if (!context) continue;
        const record = crypto.randomUUID();
        await this.#control({
          op: "record",
          ...scope,
          record,
          key: `${CHECKOUT_ARCHIVE_SOURCE}/${hash(directory)}`,
          source: CHECKOUT_ARCHIVE_SOURCE,
        }, signal);
        const pages = this.#pageWriter({ ...scope, record }, options);
        const gitContext = await this.#gitPages(context, pages, limits);
        const metadata: ArchivedCheckout = {
          schema: "commonfabric.agent-connector.checkout.v2",
          ...gitPreviews(context),
          pageCount: pages.count,
          gitContext,
        };
        await this.#control({
          op: "complete-record",
          ...scope,
          record,
          metadata: JSON.stringify(metadata),
        }, signal);
      }
      await this.#control({
        op: "source",
        ...scope,
        source: CHECKOUT_ARCHIVE_SOURCE,
        complete: true,
      }, signal);
    }
    signal?.throwIfAborted();
    const catalogSources: ArchiveSourceResult[] =
      options.nativeSessionId === undefined ? sources : [...new Map([
        ...this.#catalog!.sources.map((source) =>
          [source.source.id, { ...source }] as const
        ),
        ...sources.map((source) => [source.source.id, source] as const),
      ]).values()];
    if (catalogSources.length > 16) {
      throw new Error("Archive collection exceeds 16 sources");
    }
    options.onCommit?.();
    const committed = await this.#control({ op: "publish", ...scope });
    published = true;
    const pin = await this.#pin(scope);
    let checkoutCount: number;
    {
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => this.#releasePin(pin));
      checkoutCount = (await this.#control({
        op: "count",
        ...scope,
        pin,
        source: CHECKOUT_ARCHIVE_SOURCE,
      })).count!;
      for (const source of catalogSources) {
        source.sessionCount = (await this.#control({
          op: "count",
          ...scope,
          pin,
          source: source.source.id,
        })).count!;
      }
    }
    const sessionCount = committed.count! - checkoutCount;
    const catalog: AgentArchiveCatalog = {
      schema: "commonfabric.agent-connector.catalog.v2",
      ownerDid: this.#ownerDid,
      ...scope,
      generatedAt: new Date().toISOString(),
      sessionCount,
      checkoutCount,
      sources: catalogSources,
    };
    observe?.("index");
    await this.#publishCatalog(catalog);
    this.#catalog = catalog;
    if (visiblePin) await this.#releasePin(visiblePin);
    await this.#control({ op: "prune", ...scope });
    return sessionCount;
  }

  async #session(
    binding: ArchiveBinding,
    generation: string,
    source: SourceDescriptor,
    session: SessionStream,
    limits: CollectionLimits,
    options: ArchiveCollectionOptions,
  ): Promise<unknown | undefined> {
    const { signal, observe } = options;
    const record = crypto.randomUUID();
    const key = sessionKey(source.id, session.summary.nativeSessionId);
    const scope = { archive: binding.id, generation, record };
    await this.#control(
      { op: "record", ...scope, key, source: source.id },
      signal,
    );
    let nativeBytes = 0;
    let eventCount = 0;
    let messageCount = 0;
    const recentMessages: NormalizedMessage[] = [];
    const contentHash = createHasher();
    let provenance: NativeProvenance | undefined;
    let provenanceText = "";
    let extent = 0;
    let extentHash = createHasher();
    const pages = this.#pageWriter(scope, options);
    const page = pages.write;
    const endExtent = async () => {
      if (provenance) {
        await page(new Uint8Array(0), {
          kind: "native-end",
          provenance,
          bytes: extent,
          hash: encodeHex(extentHash.digest()),
        });
      }
    };
    const iterator = session.parts[Symbol.asyncIterator]();
    let problem: unknown;
    try {
      while (true) {
        signal?.throwIfAborted();
        let next: IteratorResult<SessionStreamPart>;
        try {
          next = await iterator.next();
        } catch (error) {
          signal?.throwIfAborted();
          problem = error;
          break;
        }
        if (next.done) break;
        const part = next.value;
        const encodedProvenance = JSON.stringify(part.provenance);
        if (encodedProvenance !== provenanceText) {
          await endExtent();
          provenance = part.provenance;
          provenanceText = encodedProvenance;
          extent = 0;
          extentHash = createHasher();
          contentHash.update(new TextEncoder().encode(encodedProvenance));
        }
        if (part.offset !== extent) {
          throw new Error("Native source offsets are not contiguous");
        }
        extentHash.update(part.bytes);
        contentHash.update(part.bytes);
        extent += part.bytes.length;
        nativeBytes += part.bytes.length;
        eventCount += part.eventCount;
        for (
          let offset = 0;
          offset < part.bytes.length;
          offset += limits.pageBytes
        ) {
          await page(part.bytes.subarray(offset, offset + limits.pageBytes), {
            kind: "native",
            provenance: part.provenance,
            offset: part.offset + offset,
          });
        }
        let messages: string[] = [];
        let messageBytes = 2;
        for (const item of part.messages) {
          const serialized = JSON.stringify(item);
          const bytes = new TextEncoder().encode(serialized).length + 1;
          if (bytes + 2 > limits.pageBytes) {
            throw new Error("Native message preview exceeds the page budget");
          }
          if (
            messages.length &&
            (messageBytes + bytes > limits.pageBytes ||
              messages.length === limits.pageItems)
          ) {
            await page(new TextEncoder().encode(`[${messages.join(",")}]`), {
              kind: "messages",
            });
            messages = [];
            messageBytes = 2;
          }
          messages.push(serialized);
          messageBytes += bytes;
          recentMessages.push(item);
          if (recentMessages.length > 2) recentMessages.shift();
          messageCount++;
        }
        if (messages.length) {
          await page(new TextEncoder().encode(`[${messages.join(",")}]`), {
            kind: "messages",
          });
        }
        observe?.("stabilization");
      }
    } finally {
      await iterator.return?.();
    }
    if (problem !== undefined) {
      await this.#control({ op: "discard-record", ...scope }, signal);
      await this.#control({
        op: "retain",
        archive: binding.id,
        generation,
        key,
      }, signal);
      return problem;
    }
    await endExtent();
    const context = await options.gitContext?.resolve(
      session.summary.cwd,
      signal,
    );
    const observation = context
      ? await this.#sessionGit(binding, key, context, pages, limits, options)
      : undefined;
    if (observation) {
      if (observation.retained) {
        session.summary.gitRepo = observation.preview.gitRepo;
        session.summary.gitBranch = observation.preview.gitBranch;
      } else {
        session.summary.gitRepo ??= observation.preview.gitRepo;
        session.summary.gitBranch ??= observation.preview.gitBranch;
      }
      session.summary.gitWorktreeRoot = observation.preview.gitWorktreeRoot;
    }
    const metadata: ArchivedSession = {
      schema: "commonfabric.agent-connector.session.v2",
      sourceId: source.id,
      driver: source.driver,
      summary: session.summary,
      format: session.format,
      revision: session.revision,
      nativeBytes,
      eventCount,
      messageCount,
      pageCount: pages.count,
      contentHash: encodeHex(contentHash.digest()),
      recentMessages,
      gitContext: observation?.range ?? null,
      gitObservedAt: observation?.observedAt ?? null,
      gitWorktreeRootHash: observation?.rootHash ?? null,
      gitObservationFailed: observation?.failed ?? false,
    };
    await this.#control({
      op: "complete-record",
      ...scope,
      metadata: sessionMetadata(metadata),
    }, signal);
    return undefined;
  }
}
