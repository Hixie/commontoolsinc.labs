/**
 * Defines the pull-based collection boundary. Native history is a byte stream;
 * neither an event nor a session has to fit in a JavaScript value.
 */

import type { NormalizedMessage, SessionSummary } from "./types.ts";

/** Bounded native metadata, separate from the v1 provider-object summary. */
export type StreamSessionSummary = Omit<SessionSummary, "raw">;

/** Inputs shared by a native source scan and a targeted refresh. */
export interface NativeCollectionOptions {
  /** Fixed memory and page budgets for this scan. */
  limits: CollectionLimits;

  /** Private scratch directory exclusively locked for the scan. */
  scratchDirectory: string;

  /** Cancellation checked between bounded reads. */
  signal?: AbortSignal;

  /** Optional memory instrumentation at pipeline stages. */
  observe?: CollectionObserver;

  /** Restricts the result to one native session when refreshing a command. */
  nativeSessionId?: string;
}

/** Pipeline boundary reported to an optional collection observer. */
export type CollectionStage =
  | "enumeration"
  | "decoding"
  | "normalization"
  | "stabilization"
  | "planning"
  | "publication"
  | "index";

/** Observes a pipeline boundary without retaining the data passing through it. */
export type CollectionObserver = (stage: CollectionStage) => void;

/** Bounds shared by source readers and the publication pipeline. */
export interface CollectionLimits {
  /** Maximum bytes read and tokenized together. */
  readBytes: number;

  /** Maximum encoded bytes in a stored page. */
  pageBytes: number;

  /** Maximum rows in a stored page. */
  pageItems: number;
}

/** Default budgets for a collection, independent of the number of sessions. */
export const DEFAULT_COLLECTION_LIMITS: Readonly<CollectionLimits> = {
  readBytes: 64 * 1024,
  pageBytes: 64 * 1024,
  pageItems: 100,
};

/** Validates the budgets before a source or destination allocates buffers. */
export function collectionLimits(
  overrides: Partial<CollectionLimits> = {},
): CollectionLimits {
  const limits = { ...DEFAULT_COLLECTION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`\`${name}\` must be a positive safe integer`);
    }
  }
  if (
    limits.readBytes > 64 * 1024 || limits.pageBytes > 64 * 1024 ||
    limits.pageItems > 100
  ) {
    throw new Error("Collection budgets exceed the bounded archive limits");
  }
  return limits;
}

/** One bounded piece of native history and the records it completes. */
export interface SessionStreamPart {
  /** Native source of these bytes, independent of their archive location. */
  provenance: NativeProvenance;

  /** Byte offset within the native file or database column. */
  offset: number;

  /** Exact source bytes, owned by this part until the next pull. */
  bytes: Uint8Array;

  /** Previews of messages completed while decoding these bytes. */
  messages: NormalizedMessage[];

  /** Number of native records completed while decoding these bytes. */
  eventCount: number;
}

/** Source location retained alongside exact native bytes. */
export type NativeProvenance = {
  /** Kind of native source being captured. */
  kind:
    | "codex-rollout"
    | "claude-project"
    | "claude-subagent"
    | "codex-state"
    | "codex-history";

  /** Original file path. */
  path: string;

  /** Original database table, for SQLite values. */
  table?: string;

  /** Original database row identifier, for SQLite values. */
  row?: string;
  /** Native subagent identity for a Claude child transcript. */
  subagentId?: string;

  /** Original database column, for SQLite values. */
  column?: string;

  /** Original SQLite storage class. */
  type?: "null" | "integer" | "real" | "text" | "blob";
};

/** A session whose summary is finalized when its parts have been consumed. */
export interface SessionStream {
  /** Provider metadata, updated by the decoder as it reads native records. */
  summary: StreamSessionSummary;

  /** Native serialization used by the source. */
  format: "codex-rollout-jsonl" | "claude-project-jsonl";

  /** Source file revision captured before reading. */
  revision: string;

  /** History pulled only after the previous part has been handled. */
  parts: AsyncIterable<SessionStreamPart>;
}

/** Pull-based source operations used by the host's collection path. */
export interface SessionStreamSource {
  /** Enumerates sessions without retaining earlier paths or their history. */
  streamSessions(
    options: NativeCollectionOptions,
  ): AsyncIterable<SessionStream>;
}
