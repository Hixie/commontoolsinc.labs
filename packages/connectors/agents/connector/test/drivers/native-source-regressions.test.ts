/** Covers native records, metadata precedence, and interrupted collection. */
import { Database } from "@db/sqlite";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { streamNativeSessions } from "../../src/drivers/native-source.ts";
import {
  decodeNativeJson,
  openNativeSessionLog,
} from "../../src/drivers/native-session-log.ts";
import { NativeSqliteSnapshot } from "../../src/drivers/sqlite-snapshot.ts";
import {
  collectionLimits,
  type StreamSessionSummary,
} from "../../src/session-stream.ts";

const id = "00000000-0000-4000-8000-000000000001";
const limits = collectionLimits({ readBytes: 64 });
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const summary = (): StreamSessionSummary => ({
  nativeSessionId: id,
  title: null,
  cwd: null,
  createdAt: null,
  updatedAt: null,
  archived: null,
  active: null,
});

describe("native source completeness", () => {
  it("preserves complete SQLite working directories and leaves oversized paths unknown", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agents-review-" });
    const boundary = "/" + "é".repeat(2045) + "a🐈";
    expect(new TextEncoder().encode(boundary).length).toBe(4096);
    try {
      const database = new Database(`${directory}/state_1.sqlite`);
      try {
        database.exec("CREATE TABLE threads (id TEXT, cwd TEXT)");
        using insert = database.prepare("INSERT INTO threads VALUES (?, ?)");
        insert.run(id, boundary);
      } finally {
        database.close();
      }
      for (const cwd of [boundary, boundary + "a", "/recovered"]) {
        const writer = new Database(`${directory}/state_1.sqlite`);
        try {
          using update = writer.prepare("UPDATE threads SET cwd = ?");
          update.run(cwd);
        } finally {
          writer.close();
        }
        let seen = 0;
        for await (
          const session of streamNativeSessions({
            id: "codex",
            driver: "codex-app-server",
            enabled: true,
            codexHome: directory,
          }, { limits, scratchDirectory: `${directory}/scratch` })
        ) {
          const decoder = new TextDecoder();
          let nativeCwd = "";
          for await (const part of session.parts) {
            if (part.provenance.column === "cwd") {
              nativeCwd += decoder.decode(part.bytes, { stream: true });
            }
          }
          nativeCwd += decoder.decode();
          expect(nativeCwd).toBe(cwd);
          expect(session.summary.cwd).toBe(
            new TextEncoder().encode(cwd).length > 4096 ? null : cwd,
          );
          seen++;
        }
        expect(seen).toBe(1);
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("Codex database items retain their native identifiers", async () => {
    const messages = [];
    for await (
      const part of decodeNativeJson(
        [encode({
          type: "agentMessage",
          id: "native-item-id",
          text: "example",
        })],
        { kind: "codex-history", path: "/synthetic" },
        summary(),
        "codex-item-json",
      )
    ) messages.push(...part.messages);
    expect(messages[0].id).toBe("native-item-id");
  });

  it("valid deeply nested opaque native fields remain collectible", async () => {
    const nested = "[".repeat(129) + "0" + "]".repeat(129);
    const bytes = new TextEncoder().encode(
      '{"type":"user","message":{"content":"example"},"opaque":' + nested + "}",
    );
    let actual = 0;
    for await (
      const part of decodeNativeJson(
        [bytes],
        { kind: "claude-project", path: "/synthetic" },
        summary(),
        "claude-project-jsonl",
      )
    ) actual += part.bytes.length;
    expect(actual).toBe(bytes.length);
  });

  it("Claude subagent transcript bytes are included", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agents-review-" });
    try {
      const project = `${directory}/projects/example`;
      await Deno.mkdir(`${project}/${id}/subagents`, { recursive: true });
      await Deno.writeTextFile(
        `${project}/${id}.jsonl`,
        '{"type":"user","message":{"content":"main"}}\n',
      );
      const childPath = `${project}/${id}/subagents/agent-a123456.jsonl`;
      await Deno.writeTextFile(
        childPath,
        '{"type":"assistant","isSidechain":true,"message":{"content":"child"}}\n',
      );
      const paths = new Set<string>();
      for await (
        const session of streamNativeSessions({
          id: "claude",
          driver: "claude-agent-sdk",
          enabled: true,
          configDir: directory,
        }, { limits, scratchDirectory: `${directory}/scratch` })
      ) {
        for await (const part of session.parts) paths.add(part.provenance.path);
      }
      expect(paths.has(childPath)).toBe(true);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("cancellation interrupts a large database item between reads", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agents-review-" });
    try {
      const database = new Database(`${directory}/thread_history_1.sqlite`);
      try {
        database.exec(
          "CREATE TABLE thread_items (thread_id TEXT, item_json TEXT)",
        );
        using insert = database.prepare(
          "INSERT INTO thread_items VALUES (?, ?)",
        );
        insert.run(
          id,
          JSON.stringify({
            type: "agentMessage",
            id: "item",
            text: "x".repeat(128 * 1024),
          }),
        );
      } finally {
        database.close();
      }
      const controller = new AbortController();
      let decodingEvents = 0;
      let decodedBytes = 0;
      let interrupted = false;
      try {
        for await (
          const session of streamNativeSessions({
            id: "codex",
            driver: "codex-app-server",
            enabled: true,
            codexHome: directory,
          }, {
            limits,
            scratchDirectory: `${directory}/scratch`,
            signal: controller.signal,
            observe(stage) {
              if (stage === "decoding" && ++decodingEvents === 2) {
                controller.abort();
              }
            },
          })
        ) {
          for await (const part of session.parts) {
            if (part.provenance.column === "item_json") {
              decodedBytes += part.bytes.length;
            }
          }
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          interrupted = true;
        } else throw error;
      }
      expect(decodedBytes).toBeLessThanOrEqual(limits.readBytes);
      expect(interrupted).toBe(true);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("truncate and regrow cannot masquerade as an append", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agents-review-" });
    try {
      const path = `${directory}/${id}.jsonl`;
      await Deno.writeTextFile(
        path,
        '{"type":"user","message":{"content":"before"}}\n',
      );
      const session = await openNativeSessionLog(
        { path, id, archived: null },
        "claude-project-jsonl",
        limits,
      );
      await Deno.writeTextFile(
        path,
        '{"type":"user","message":{"content":"after "}}\n{}\n',
      );
      await Deno.utime(path, 200, 200);
      const consume = async () => {
        for await (
          const _part of session.parts
        ) { /* Exhaust the captured extent. */ }
      };
      await expect(consume()).rejects.toThrow();
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("an unreadable project does not hide readable sibling sessions", async () => {
    if (Deno.build.os === "windows") return;
    const directory = await Deno.makeTempDir({ prefix: "agents-review-" });
    let blocked: string | undefined;
    try {
      const root = `${directory}/projects`;
      await Deno.mkdir(`${root}/one`, { recursive: true });
      await Deno.mkdir(`${root}/two`);
      const entries = [];
      for await (const entry of Deno.readDir(root)) entries.push(entry.name);
      blocked = `${root}/${entries[0]}`;
      const readable = `${root}/${entries[1]}/${id}.jsonl`;
      await Deno.writeTextFile(
        readable,
        '{"type":"user","message":{"content":"readable"}}\n',
      );
      await Deno.chmod(blocked, 0o000);
      const seen = [];
      try {
        for await (
          const session of streamNativeSessions({
            id: "claude",
            driver: "claude-agent-sdk",
            enabled: true,
            configDir: directory,
          }, { limits, scratchDirectory: `${directory}/scratch` })
        ) {
          seen.push(session.summary.nativeSessionId);
          for await (const _part of session.parts) {
            /* Consume the fixture. */
          }
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.PermissionDenied)) throw error;
      }
      expect(seen).toEqual([id]);
    } finally {
      if (blocked) await Deno.chmod(blocked, 0o700);
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("Claude title precedence and relocation metadata match native semantics", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agents-review-" });
    try {
      const path = `${directory}/${id}.jsonl`;
      const entries = [
        {
          type: "user",
          cwd: "/original",
          timestamp: "2026-01-01T00:00:00Z",
          message: { role: "user", content: "First prompt" },
        },
        { type: "custom-title", customTitle: "Manual title" },
        { type: "summary", summary: "Compaction summary" },
        { type: "relocated", relocatedCwd: "/new", gitBranch: "branch" },
      ];
      await Deno.writeTextFile(
        path,
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
      await Deno.utime(path, 200, 200);
      const session = await openNativeSessionLog(
        { path, id, archived: null },
        "claude-project-jsonl",
        limits,
      );
      for await (const _part of session.parts) { /* Consume the fixture. */ }
      expect({
        title: session.summary.title,
        cwd: session.summary.cwd,
        gitBranch: session.summary.gitBranch,
        updatedAt: session.summary.updatedAt,
      }).toEqual({
        title: "Manual title",
        cwd: "/new",
        gitBranch: "branch",
        updatedAt: new Date(200_000).toISOString(),
      });
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("native SQLite supports its full signed rowid range", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agents-review-" });
    try {
      const path = `${directory}/native.sqlite`;
      const database = new Database(path, { int64: true });
      try {
        database.exec("CREATE TABLE messages (value TEXT)");
        database.exec(
          "INSERT INTO messages (rowid, value) VALUES (9007199254740993, 'example')",
        );
      } finally {
        database.close();
      }
      using snapshot = new NativeSqliteSnapshot(path);
      expect([...snapshot.rows("messages")].map(String)).toEqual([
        "9007199254740993",
      ]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
});
