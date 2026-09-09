/** Enumerates and streams native agent sources without provider hydration. */

// deno-lint-ignore no-external-import
import { homedir } from "node:os";
import { join } from "@std/path";

import type { AgentSourceConfig } from "../types.ts";
import type {
  NativeCollectionOptions,
  NativeProvenance,
  SessionStream,
  SessionStreamPart,
  StreamSessionSummary,
} from "../session-stream.ts";
import {
  NativeInventory,
  type NativeInventorySession,
} from "./native-inventory.ts";
import {
  decodeNativeJson,
  type NativeFileSessionStream,
  nativeSessionFiles,
  openNativeSessionLog,
} from "./native-session-log.ts";
import { NativeSqliteSnapshot } from "./sqlite-snapshot.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TABLES = {
  state: {
    threads: "id",
    thread_dynamic_tools: "thread_id",
    thread_artifacts: "thread_id",
    thread_spawn_edges: "child_thread_id",
  },
  history: {
    thread_items: "thread_id",
    thread_realtime_items: "thread_id",
    thread_turns: "thread_id",
    thread_history_projection_state: "thread_id",
  },
} as const;

type DatabaseKind = keyof typeof TABLES;
interface SourceDatabase {
  path: string;
  snapshot: NativeSqliteSnapshot;
}

/** Resolves the source's configured native home without changing process env. */
function sourceHome(config: AgentSourceConfig): string {
  if (config.driver === "claude-agent-sdk") {
    return config.configDir ?? config.env?.CLAUDE_CONFIG_DIR ??
      Deno.env.get("CLAUDE_CONFIG_DIR") ?? join(homedir(), ".claude");
  }
  return config.codexHome ?? config.env?.CODEX_HOME ??
    Deno.env.get("CODEX_HOME") ?? join(homedir(), ".codex");
}

/** Selects the newest native schema version without retaining directory rows. */
async function databasePaths(
  home: string,
): Promise<Partial<Record<DatabaseKind, string>>> {
  const paths: Partial<Record<DatabaseKind, string>> = {};
  const versions = { state: -1, history: -1 };
  for await (const entry of Deno.readDir(home)) {
    if (!entry.isFile) continue;
    const match = /^(state|thread_history)_(\d+)\.sqlite$/.exec(entry.name);
    if (!match) continue;
    const kind = match[1] === "state" ? "state" : "history";
    const version = Number(match[2]);
    if (Number.isSafeInteger(version) && version > versions[kind]) {
      versions[kind] = version;
      paths[kind] = join(home, entry.name);
    }
  }
  return paths;
}

/** Captures a bounded native TEXT field while its full bytes remain streamable. */
function textField(
  database: NativeSqliteSnapshot,
  table: string,
  row: number | bigint,
  column: string,
  options: { bytes?: number; complete?: boolean } = {},
): string | null | undefined {
  if (!database.hasColumn(table, column)) return undefined;
  const type = database.column(table, row, column).type;
  if (type === "null") return undefined;
  if (type !== "text") {
    throw new Error(
      `Native metadata field is not TEXT: \`${table}.${column}\``,
    );
  }
  const bytes = options.bytes ?? 2000;
  if (options.complete) {
    for (const part of database.bytes(table, row, column, bytes + 1)) {
      if (part.length > bytes) return null;
      return new TextDecoder("utf-8", { fatal: true }).decode(part);
    }
    return "";
  }
  return database.textPrefix(table, row, column, bytes);
}

/** Captures a numeric native value without converting a TEXT column to a scalar. */
function numberField(
  database: NativeSqliteSnapshot,
  table: string,
  row: number | bigint,
  column: string,
): number | null {
  if (!database.hasColumn(table, column)) return null;
  const value = database.scalar(
    table,
    row,
    database.column(table, row, column),
  );
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(
      `Native metadata integer exceeds precision: \`${table}.${column}\``,
    );
  }
  return number;
}

/** Applies separately persisted Codex metadata from the same database snapshot. */
function applyStateSummary(
  summary: StreamSessionSummary,
  database: NativeSqliteSnapshot,
  row: number | bigint,
): void {
  summary.title = (textField(database, "threads", row, "name") ||
    textField(database, "threads", row, "title") || summary.title)?.slice(
      0,
      500,
    ) ?? null;
  const cwd = textField(database, "threads", row, "cwd", {
    bytes: 4096,
    complete: true,
  });
  if (cwd !== undefined) summary.cwd = cwd || null;
  summary.gitBranch =
    textField(database, "threads", row, "git_branch")?.slice(0, 500) ?? null;
  summary.gitRepo =
    textField(database, "threads", row, "git_origin_url")?.slice(0, 500) ??
      null;
  const created = numberField(database, "threads", row, "created_at_ms") ??
    (numberField(database, "threads", row, "created_at") ?? 0) * 1000;
  const updated = numberField(database, "threads", row, "updated_at_ms") ??
    (numberField(database, "threads", row, "updated_at") ?? 0) * 1000;
  if (created) summary.createdAt = new Date(created).toISOString();
  if (updated) summary.updatedAt = new Date(updated).toISOString();
  const archived = numberField(database, "threads", row, "archived");
  if (archived !== null) summary.archived = archived !== 0;
}

/**
 * Keeps each database in one read transaction until the returned iterator
 * closes. File extents are pinned separately; cross-file inconsistencies are
 * reported after their native database records have been streamed.
 */
export async function* streamNativeSessions(
  config: AgentSourceConfig,
  options: NativeCollectionOptions,
): AsyncGenerator<SessionStream> {
  if (
    config.driver !== "claude-agent-sdk" && config.driver !== "codex-app-server"
  ) {
    throw new Error(
      `Driver has no bounded native source: \`${config.driver}\``,
    );
  }
  const { limits, signal, observe } = options;
  const home = sourceHome(config);
  if (!(await Deno.lstat(home)).isDirectory) {
    throw new Error("Native source home is not a directory");
  }
  await using inventory = await NativeInventory.open(options.scratchDirectory);
  using resources = new DisposableStack();
  const databases: Partial<Record<DatabaseKind, SourceDatabase>> = {};
  let enumerationError: unknown;
  if (config.driver === "codex-app-server") {
    for (const [kind, path] of Object.entries(await databasePaths(home))) {
      try {
        const snapshot = resources.use(new NativeSqliteSnapshot(path));
        databases[kind as DatabaseKind] = { path, snapshot };
      } catch (error) {
        signal?.throwIfAborted();
        enumerationError ??= error;
      }
    }
  }

  const roots: Array<[string, boolean | null]> =
    config.driver === "codex-app-server"
      ? [[join(home, "sessions"), false], [
        join(home, "archived_sessions"),
        true,
      ]]
      : [[join(home, "projects"), null]];
  for (const [root, archived] of roots) {
    try {
      for await (const file of nativeSessionFiles(root, archived, signal)) {
        try {
          const info = await Deno.lstat(file.path);
          if (!info.isFile) {
            throw new Error("Native session changed during enumeration");
          }
          inventory.addFile(file, info.mtime?.getTime() ?? 0);
        } catch (error) {
          signal?.throwIfAborted();
          enumerationError ??= error;
        }
        observe?.("enumeration");
      }
    } catch (error) {
      signal?.throwIfAborted();
      enumerationError ??= error;
    }
  }
  for (const kind of ["state", "history"] as const) {
    const source = databases[kind];
    if (!source) continue;
    for (const [table, idColumn] of Object.entries(TABLES[kind])) {
      if (!source.snapshot.hasTable(table)) continue;
      try {
        for (const row of source.snapshot.rows(table)) {
          signal?.throwIfAborted();
          try {
            const id = textField(source.snapshot, table, row, idColumn, {
              bytes: 128,
              complete: true,
            });
            if (!id || !UUID.test(id)) {
              throw new Error(
                `Native database has an invalid session identifier: \`${table}\``,
              );
            }
            inventory.addRow(id, { database: kind, table, row });
            if (kind === "state" && table === "threads") {
              const path = textField(
                source.snapshot,
                table,
                row,
                "rollout_path",
                { bytes: 4096, complete: true },
              );
              if (path) {
                const archived = numberField(
                  source.snapshot,
                  table,
                  row,
                  "archived",
                );
                inventory.addFile(
                  {
                    path,
                    id,
                    archived: archived === null ? null : archived !== 0,
                  },
                  0,
                  true,
                );
              }
            }
            observe?.("enumeration");
          } catch (error) {
            signal?.throwIfAborted();
            enumerationError ??= error;
          }
        }
      } catch (error) {
        signal?.throwIfAborted();
        enumerationError ??= error;
      }
    }
  }
  for (const session of inventory.sessions()) {
    signal?.throwIfAborted();
    if (
      options.nativeSessionId !== undefined &&
      session.id !== options.nativeSessionId
    ) continue;
    yield await openSession(session);
  }
  if (enumerationError) throw enumerationError;

  async function openSession(
    session: NativeInventorySession,
  ): Promise<SessionStream> {
    let log: NativeFileSessionStream | undefined;
    let problem: unknown;
    let fileSize: number | undefined;
    const format = config.driver === "codex-app-server"
      ? "codex-rollout-jsonl"
      : "claude-project-jsonl";
    if (session.path) {
      try {
        log = await openNativeSessionLog(
          {
            path: session.path,
            id: session.id,
            archived: session.archived === null ? null : session.archived !== 0,
          },
          format,
          limits,
          signal,
          observe,
          options.scratchDirectory,
        );
        fileSize = log.byteLength;
      } catch (error) {
        problem = error;
      }
    }
    const summary: StreamSessionSummary = log?.summary ?? {
      nativeSessionId: session.id,
      title: null,
      cwd: null,
      createdAt: null,
      updatedAt: null,
      archived: null,
      active: null,
    };
    return {
      summary,
      format,
      revision: log?.revision ?? "database-snapshot",
      parts: parts(),
    };

    async function* parts(): AsyncGenerator<SessionStreamPart> {
      if (log) {
        try {
          yield* log.parts;
        } catch (error) {
          signal?.throwIfAborted();
          problem ??= error;
        }
      }
      if (config.driver === "claude-agent-sdk") {
        for (const subagent of inventory.subagents(session.id)) {
          try {
            const child = await openNativeSessionLog(
              subagent,
              format,
              limits,
              signal,
              observe,
              options.scratchDirectory,
            );
            yield* child.parts;
          } catch (error) {
            signal?.throwIfAborted();
            problem ??= error;
          }
        }
      }
      for (const row of inventory.rows(session.id)) {
        const source = databases[row.database]!;
        const database = source.snapshot;
        if (row.database === "state" && row.table === "threads") {
          applyStateSummary(summary, database, row.row);
        }
        if (row.database === "history") {
          for (
            const column of [
              "next_rollout_byte_offset",
              "rollout_byte_offset",
              "rollout_end_byte_offset",
            ]
          ) {
            const offset = numberField(database, row.table, row.row, column);
            if (
              offset !== null && fileSize !== undefined && offset > fileSize
            ) {
              problem ??= new Error(
                `Native projection exceeds the captured rollout: \`${session.id}\``,
              );
            }
          }
        }
        const provenance: NativeProvenance = {
          kind: row.database === "state" ? "codex-state" : "codex-history",
          path: source.path,
          table: row.table,
          row: String(row.row),
        };
        for (const column of database.columns(row.table, row.row)) {
          signal?.throwIfAborted();
          const origin = {
            ...provenance,
            column: column.name,
            type: column.type,
          };
          if (column.type === "text" || column.type === "blob") {
            const bytes = database.bytes(
              row.table,
              row.row,
              column.name,
              limits.readBytes,
            );
            if (column.name === "item_json" && column.type === "text") {
              for await (
                const part of decodeNativeJson(
                  bytes,
                  origin,
                  summary,
                  "codex-item-json",
                  observe,
                  signal,
                  options.scratchDirectory,
                )
              ) {
                part.eventCount = 0;
                yield part;
              }
            } else {
              let offset = 0;
              for (const part of bytes) {
                signal?.throwIfAborted();
                observe?.("decoding");
                yield {
                  provenance: origin,
                  offset,
                  bytes: part,
                  messages: [],
                  eventCount: 0,
                };
                offset += part.length;
              }
              if (offset === 0) {
                yield {
                  provenance: origin,
                  offset,
                  bytes: new Uint8Array(),
                  messages: [],
                  eventCount: 0,
                };
              }
            }
          } else {
            const scalar = database.scalar(row.table, row.row, column);
            yield {
              provenance: origin,
              offset: 0,
              bytes: new TextEncoder().encode(String(scalar)),
              messages: [],
              eventCount: 0,
            };
          }
        }
        yield {
          provenance,
          offset: 0,
          bytes: new Uint8Array(),
          messages: [],
          eventCount: 1,
        };
      }
      if (problem) throw problem;
    }
  }
}
