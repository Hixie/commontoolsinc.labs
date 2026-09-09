/**
 * Reads local agent history as bytes and bounded metadata projections. JSON
 * strings are tokenized in fragments, including strings larger than the heap.
 */

import { encodeHex } from "@std/encoding/hex";
import { basename, dirname, join } from "@std/path";

import { createHasher } from "@commonfabric/content-hash";

import type {
  CollectionLimits,
  CollectionObserver,
  NativeProvenance,
  SessionStream,
  SessionStreamPart,
  StreamSessionSummary,
} from "../session-stream.ts";
import type { NormalizedMessage } from "../types.ts";
import { type NativeJsonToken, NativeJsonTokenizer } from "./native-json.ts";

const PREVIEW_LENGTH = 500;

/** Maximum UTF-8 bytes in an operational working-directory path. */
const FILESYSTEM_PATH_BYTES = 4096;

const KEY_LENGTH = 64;
const PROJECTION_DEPTH = 8;
const SESSION_ID =
  /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i;

/** JSON representations whose small fields the native reader projects. */
export type NativeJsonFormat = SessionStream["format"] | "codex-item-json";

/** A source file discovered without following filesystem symlinks. */
export interface NativeSessionFile {
  /** Absolute source file path. */
  path: string;

  /** Provider session identifier from the filename. */
  id: string;

  /** Archive state of the containing source directory. */
  archived: boolean | null;
  /** Claude subagent identity, associated with the parent session in id. */
  subagentId?: string;
}

/** A native file stream with the identity and extent captured before reading. */
export interface NativeFileSessionStream extends SessionStream {
  /** Captured source file size in bytes. */
  byteLength: number;
}

/** Enumerates a native history tree with one directory iterator per depth. */
export async function* nativeSessionFiles(
  root: string,
  archived: boolean | null,
  signal?: AbortSignal,
): AsyncGenerator<NativeSessionFile> {
  try {
    const info = await Deno.lstat(root);
    if (!info.isDirectory) {
      throw new Error("Native history root is not a directory");
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  let problem: unknown;
  yield* visit(root);
  if (problem) throw problem;

  async function* visit(directory: string): AsyncGenerator<NativeSessionFile> {
    try {
      for await (const entry of Deno.readDir(directory)) {
        signal?.throwIfAborted();
        const path = join(directory, entry.name);
        if (entry.isDirectory) {
          yield* visit(path);
        } else if (entry.isFile) {
          if (basename(directory) === "subagents") {
            const subagent = /^agent-(.+)\.jsonl$/.exec(entry.name);
            const parent = SESSION_ID.exec(
              `${basename(dirname(directory))}.jsonl`,
            );
            if (subagent && parent) {
              yield { path, id: parent[1], archived, subagentId: subagent[1] };
            }
          } else {
            const match = SESSION_ID.exec(entry.name);
            if (match) yield { path, id: match[1], archived };
          }
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      problem ??= error;
    }
  }
}

/** Keeps only fields used by session summaries and message previews. */
class LogProjection {
  #summary: StreamSessionSummary;
  #format: NativeJsonFormat;
  #path: string[] = [];
  #depth = 0;
  #key = "";
  #inKey = false;
  #value = "";
  #fields: Record<string, string> = {};
  #text = "";
  #index = 0;
  #customTitle?: string;
  #aiTitle?: string;
  #lastPrompt?: string;
  #summaryTitle?: string;
  #firstPrompt?: string;
  #relocatedCwd?: string;

  /** Constructs an instance which updates the supplied session summary. */
  constructor(summary: StreamSessionSummary, format: NativeJsonFormat) {
    this.#summary = summary;
    this.#format = format;
  }

  /** Consumes a token and returns a preview at a native record boundary. */
  accept(token: NativeJsonToken): { message?: NormalizedMessage } | undefined {
    switch (token.name) {
      case "startKey":
        this.#inKey = true;
        this.#key = "";
        break;
      case "endKey":
        this.#inKey = false;
        break;
      case "startObject":
      case "startArray":
        if (++this.#depth <= PROJECTION_DEPTH) this.#path.push(this.#key);
        this.#key = token.name === "startArray" ? "*" : "";
        break;
      case "endObject":
      case "endArray":
        if (this.#depth-- <= PROJECTION_DEPTH) this.#path.pop();
        this.#key = "*";
        if (this.#depth === 0) return this.#finishRecord();
        break;
      case "startString":
      case "startNumber":
        this.#value = "";
        break;
      case "stringChunk":
      case "numberChunk":
        if (this.#inKey) {
          this.#key += token.value.slice(0, KEY_LENGTH - this.#key.length);
        } else {
          const limit = this.#key === "cwd" || this.#key === "relocatedCwd"
            ? FILESYSTEM_PATH_BYTES + 1
            : PREVIEW_LENGTH;
          this.#value += token.value.slice(
            0,
            limit - this.#value.length,
          );
        }
        break;
      case "endString":
      case "endNumber":
        this.#capture(this.#value);
        break;
      case "trueValue":
      case "falseValue":
        this.#capture(String(token.value));
        break;
    }
    return undefined;
  }

  /** Retains selected scalar fields and one preview across content blocks. */
  #capture(value: string): void {
    if (this.#depth > PROJECTION_DEPTH) return;
    const path = [...this.#path.slice(1), this.#key].join(".");
    if (
      /^(id|uuid|type|sessionId|cwd|relocatedCwd|gitBranch|timestamp|customTitle|aiTitle|lastPrompt|summary|title|parentUuid|isSidechain|payload\.(id|type|role|cwd|timestamp|title)|message\.(id|role))$/
        .test(path)
    ) {
      const oversizedPath =
        (this.#key === "cwd" || this.#key === "relocatedCwd") &&
        new TextEncoder().encode(value).length > FILESYSTEM_PATH_BYTES;
      this.#fields[path] = oversizedPath ? "" : value;
    }
    if (
      /^((message|payload)\.)?(content(\.\*\.text)?|text|message)$/.test(path)
    ) {
      if (this.#text && this.#text.length < PREVIEW_LENGTH) this.#text += "\n";
      this.#text += value.slice(0, PREVIEW_LENGTH - this.#text.length);
    }
  }

  /** Finalizes one record without retaining its native contents. */
  #finishRecord(): { message?: NormalizedMessage } {
    const fields = this.#fields;
    const text = this.#text;
    this.#fields = {};
    this.#text = "";
    const rawIndex = this.#index++;
    const type = fields["payload.type"] ?? fields.type ?? "unknown";
    const role = fields["message.role"] ?? fields["payload.role"] ??
      fields.type;
    const createdAt = fields.timestamp ?? fields["payload.timestamp"] ?? null;
    const cwd = fields.cwd ?? fields["payload.cwd"];
    if (cwd !== undefined) this.#summary.cwd = cwd || null;
    this.#summary.createdAt ??= createdAt;
    if (createdAt && this.#format !== "claude-project-jsonl") {
      this.#summary.updatedAt = createdAt;
    }
    const title = fields.customTitle ?? fields.title ??
      fields["payload.title"] ?? fields.summary;
    if (title) this.#summary.title = title;
    if (!this.#summary.title && (role === "user" || type === "user_message")) {
      this.#summary.title = text || null;
    }
    if (this.#format === "claude-project-jsonl") {
      if (fields.customTitle !== undefined) {
        this.#customTitle = fields.customTitle;
      }
      if (fields.aiTitle !== undefined) this.#aiTitle = fields.aiTitle;
      if (fields.lastPrompt !== undefined) this.#lastPrompt = fields.lastPrompt;
      if (fields.summary !== undefined) this.#summaryTitle = fields.summary;
      if (role === "user" && text) this.#firstPrompt ??= text;
      if (fields.relocatedCwd !== undefined) {
        this.#relocatedCwd = fields.relocatedCwd;
      }
      if (fields.gitBranch) this.#summary.gitBranch = fields.gitBranch;
      this.#summary.title = this.#customTitle || this.#aiTitle ||
        this.#lastPrompt || this.#summaryTitle || this.#firstPrompt || null;
      if (this.#relocatedCwd !== undefined) {
        this.#summary.cwd = this.#relocatedCwd || null;
      }
    }
    const messageRole =
      role === "user" || type === "user_message" || type === "userMessage"
        ? "user"
        : role === "assistant" || type === "agent_message" ||
            type === "agentMessage"
        ? "assistant"
        : role === "system"
        ? "system"
        : type === "function_call" || type === "function_call_output" ||
            type === "commandExecution"
        ? "tool"
        : undefined;
    if (!messageRole) return {};
    // Codex's event messages repeat its persisted response items.
    if (
      this.#format === "codex-rollout-jsonl" && fields.type !== "response_item"
    ) return {};
    return {
      message: {
        id: fields.uuid ?? fields["message.id"] ?? fields["payload.id"] ??
          fields.id ?? `record-${rawIndex}`,
        ...(fields.parentUuid ? { parentId: fields.parentUuid } : {}),
        role: messageRole,
        kind: type,
        createdAt,
        textPreview: text || null,
        rawIndex,
      },
    };
  }
}

/** Opens a fixed source-file extent; appended bytes belong to a later scan. */
export async function openNativeSessionLog(
  source: NativeSessionFile,
  format: SessionStream["format"],
  limits: CollectionLimits,
  signal?: AbortSignal,
  observe?: CollectionObserver,
  scratchDirectory?: string,
): Promise<NativeFileSessionStream> {
  signal?.throwIfAborted();
  const stat = await Deno.lstat(source.path);
  if (!stat.isFile) throw new Error("Native session is not a regular file");
  const capturedHash = createHasher();
  {
    using capture = await Deno.open(source.path, { read: true });
    checkIdentity(await capture.stat());
    const buffer = new Uint8Array(limits.readBytes);
    let remaining = stat.size;
    while (remaining > 0) {
      signal?.throwIfAborted();
      const count = await capture.read(
        buffer.subarray(0, Math.min(remaining, buffer.length)),
      );
      if (!count) {
        throw new Error(`Native session was truncated: \`${source.id}\``);
      }
      capturedHash.update(buffer.subarray(0, count));
      remaining -= count;
    }
    const after = await capture.stat();
    checkIdentity(after);
    if (
      after.size === stat.size &&
      after.mtime?.getTime() !== stat.mtime?.getTime()
    ) {
      throw new Error(
        `Native session changed while capturing its revision: \`${source.id}\``,
      );
    }
  }
  const revisionHash = encodeHex(capturedHash.digest());
  const summary: StreamSessionSummary = {
    nativeSessionId: source.id,
    title: null,
    cwd: null,
    createdAt: null,
    updatedAt: stat.mtime?.toISOString() ?? null,
    archived: source.archived,
    active: null,
  };
  const provenance = {
    kind: format === "codex-rollout-jsonl"
      ? "codex-rollout"
      : source.subagentId
      ? "claude-subagent"
      : "claude-project",
    path: source.path,
    ...(source.subagentId ? { subagentId: source.subagentId } : {}),
  } as const;
  return {
    summary,
    format,
    revision: `${stat.size}:${revisionHash}`,
    byteLength: stat.size,
    parts: decodeNativeJson(
      readBytes(),
      provenance,
      summary,
      format,
      observe,
      signal,
      scratchDirectory,
    ),
  };

  async function* readBytes(): AsyncGenerator<Uint8Array> {
    using file = await Deno.open(source.path, { read: true });
    checkIdentity(await file.stat());
    const buffer = new Uint8Array(limits.readBytes);
    const hash = createHasher();
    let remaining = stat.size;
    while (remaining > 0) {
      signal?.throwIfAborted();
      const read = await file.read(
        buffer.subarray(0, Math.min(buffer.length, remaining)),
      );
      if (read === null) {
        throw new Error(`Native session was truncated: \`${source.id}\``);
      }
      remaining -= read;
      hash.update(buffer.subarray(0, read));
      yield buffer.subarray(0, read);
    }
    checkIdentity(await file.stat());
    checkIdentity(await Deno.lstat(source.path));
    if (encodeHex(hash.digest()) !== revisionHash) {
      throw new Error(`Native session was modified: \`${source.id}\``);
    }
  }

  function checkIdentity(current: Deno.FileInfo): void {
    if (
      !current.isFile || current.dev !== stat.dev || current.ino !== stat.ino
    ) {
      throw new Error(`Native session was replaced: \`${source.id}\``);
    }
    if (current.size < stat.size) {
      throw new Error(`Native session was truncated: \`${source.id}\``);
    }
    if (
      current.size === stat.size &&
      current.mtime?.getTime() !== stat.mtime?.getTime()
    ) {
      throw new Error(`Native session was modified: \`${source.id}\``);
    }
  }
}

/** Projects JSON scalars as fragments while preserving each original byte. */
export async function* decodeNativeJson(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  provenance: NativeProvenance,
  summary: StreamSessionSummary,
  format: NativeJsonFormat,
  observe?: CollectionObserver,
  signal?: AbortSignal,
  scratchDirectory?: string,
): AsyncGenerator<SessionStreamPart> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  using tokenize = new NativeJsonTokenizer(scratchDirectory);
  const projection = new LogProjection(summary, format);
  let offset = 0;
  for await (const bytes of input) {
    signal?.throwIfAborted();
    const part: SessionStreamPart = {
      provenance,
      offset,
      bytes,
      messages: [],
      eventCount: 0,
    };
    for (
      const token of tokenize.write(decoder.decode(bytes, { stream: true }))
    ) {
      observe?.("decoding");
      const record = projection.accept(token);
      if (record) part.eventCount++;
      if (record?.message) part.messages.push(record.message);
    }
    observe?.("normalization");
    signal?.throwIfAborted();
    offset += bytes.length;
    yield part;
  }
  const last: SessionStreamPart = {
    provenance,
    offset,
    bytes: new Uint8Array(),
    messages: [],
    eventCount: 0,
  };
  signal?.throwIfAborted();
  for (const token of tokenize.write(decoder.decode())) {
    const record = projection.accept(token);
    if (record) last.eventCount++;
    if (record?.message) last.messages.push(record.message);
  }
  tokenize.finish();
  yield last;
}
