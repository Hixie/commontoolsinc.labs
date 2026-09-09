/** Exercises native source coverage without calling eager provider APIs. */

import { Database } from "@db/sqlite";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { streamNativeSessions } from "../../src/drivers/native-source.ts";
import {
  collectionLimits,
  type SessionStream,
} from "../../src/session-stream.ts";

const DATABASE_ONLY = "00000000-0000-4000-8000-000000000001";
const ROLLOUT_ONLY = "00000000-0000-4000-8000-000000000002";
const BOTH = "00000000-0000-4000-8000-000000000003";

/** Captures only the small fixture's individual native database columns. */
async function readFixture(session: SessionStream) {
  const fields: Record<string, string> = {};
  const origins = new Set<string>();
  let events = 0;
  let messages = 0;
  const decoder = new TextDecoder();
  for await (const part of session.parts) {
    origins.add(part.provenance.kind);
    events += part.eventCount;
    messages += part.messages.length;
    if (part.provenance.column) {
      const key = `${part.provenance.table}.${part.provenance.column}`;
      fields[key] = (fields[key] ?? "") + decoder.decode(part.bytes);
    }
  }
  return { fields, origins: [...origins].sort(), events, messages };
}

describe("native agent source collection", () => {
  it("captures database-only and rollout-only Codex sessions with distinct provenance", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agents-source-test-" });
    try {
      await Deno.mkdir(`${directory}/sessions`);
      await Deno.writeTextFile(
        `${directory}/sessions/${ROLLOUT_ONLY}.jsonl`,
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "rollout" }],
          },
        }) + "\n",
      );
      {
        const database = new Database(`${directory}/thread_history_1.sqlite`);
        try {
          database.exec(
            "CREATE TABLE thread_items (thread_id TEXT, item_json TEXT)",
          );
          using insert = database.prepare(
            "INSERT INTO thread_items VALUES (?,?)",
          );
          insert.run(
            DATABASE_ONLY,
            JSON.stringify({
              type: "userMessage",
              id: "db-message",
              content: [{ type: "text", text: "database" }],
            }),
          );
        } finally {
          database.close();
        }
      }
      const seen: string[] = [];
      for await (
        const session of streamNativeSessions({
          id: "codex",
          driver: "codex-app-server",
          enabled: true,
          codexHome: directory,
        }, {
          limits: collectionLimits({ readBytes: 17 }),
          scratchDirectory: `${directory}/scratch`,
        })
      ) {
        seen.push(session.summary.nativeSessionId);
        const result = await readFixture(session);
        expect(result.events).toBe(1);
        expect(result.messages).toBe(1);
        if (session.summary.nativeSessionId === DATABASE_ONLY) {
          expect(result.origins).toEqual(["codex-history"]);
          expect(JSON.parse(result.fields["thread_items.item_json"]).id).toBe(
            "db-message",
          );
        } else {
          expect(result.origins).toEqual(["codex-rollout"]);
        }
      }
      expect(seen).toEqual([DATABASE_ONLY, ROLLOUT_ONLY]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("keeps native state metadata and history rows in their read snapshots", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agents-source-test-" });
    try {
      using resources = new DisposableStack();
      const state = new Database(`${directory}/state_5.sqlite`);
      resources.defer(() => state.close());
      state.exec("PRAGMA journal_mode = WAL");
      state.exec(
        "CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, archived INTEGER)",
      );
      using insert = state.prepare(
        "INSERT INTO threads VALUES (?, 'before', '/before', 0)",
      );
      insert.run(DATABASE_ONLY);
      const history = new Database(`${directory}/thread_history_1.sqlite`);
      resources.defer(() => history.close());
      history.exec("PRAGMA journal_mode = WAL");
      history.exec(
        "CREATE TABLE thread_items (thread_id TEXT, item_json TEXT)",
      );
      using item = history.prepare("INSERT INTO thread_items VALUES (?, ?)");
      item.run(
        DATABASE_ONLY,
        '{"type":"agentMessage","id":"before","text":"before"}',
      );
      for await (
        const session of streamNativeSessions({
          id: "codex",
          driver: "codex-app-server",
          enabled: true,
          codexHome: directory,
        }, {
          limits: collectionLimits({ readBytes: 17 }),
          scratchDirectory: `${directory}/scratch`,
        })
      ) {
        state.exec("UPDATE threads SET title = 'after', cwd = '/after'");
        history.exec(
          'UPDATE thread_items SET item_json = \'{"type":"agentMessage","id":"after"}\'',
        );
        const result = await readFixture(session);
        expect(result.fields["threads.title"]).toBe("before");
        expect(JSON.parse(result.fields["thread_items.item_json"]).id).toBe(
          "before",
        );
        expect(session.summary.title).toBe("before");
        expect(session.summary.cwd).toBe("/before");
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("preserves native database bytes before reporting a stale projection extent", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agents-source-test-" });
    try {
      await Deno.mkdir(`${directory}/sessions`);
      await Deno.writeTextFile(`${directory}/sessions/${BOTH}.jsonl`, "{}\n");
      const database = new Database(`${directory}/thread_history_1.sqlite`);
      try {
        database.exec(
          "CREATE TABLE thread_history_projection_state (thread_id TEXT, next_rollout_byte_offset INTEGER)",
        );
        using insert = database.prepare(
          "INSERT INTO thread_history_projection_state VALUES (?, 4096)",
        );
        insert.run(BOTH);
      } finally {
        database.close();
      }
      for await (
        const session of streamNativeSessions({
          id: "codex",
          driver: "codex-app-server",
          enabled: true,
          codexHome: directory,
        }, {
          limits: collectionLimits(),
          scratchDirectory: `${directory}/scratch`,
        })
      ) {
        let projection: string | undefined;
        const consume = async () => {
          for await (const part of session.parts) {
            if (part.provenance.column === "next_rollout_byte_offset") {
              projection = new TextDecoder().decode(part.bytes);
            }
          }
        };
        await expect(consume()).rejects.toThrow("projection exceeds");
        expect(projection).toBe("4096");
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("uses the selected Claude path for duplicate IDs", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agents-source-test-" });
    try {
      for (const project of ["a", "z"]) {
        await Deno.mkdir(`${directory}/projects/${project}`, {
          recursive: true,
        });
        const path = `${directory}/projects/${project}/${BOTH}.jsonl`;
        await Deno.writeTextFile(
          path,
          JSON.stringify({
            type: "user",
            customTitle: project,
            message: { content: project },
          }),
        );
        await Deno.utime(path, 100, 100);
      }
      let sessions = 0;
      for await (
        const session of streamNativeSessions({
          id: "claude",
          driver: "claude-agent-sdk",
          enabled: true,
          configDir: directory,
        }, {
          limits: collectionLimits(),
          scratchDirectory: `${directory}/scratch`,
        })
      ) {
        sessions++;
        await readFixture(session);
        expect(session.summary.title).toBe("a");
      }
      expect(sessions).toBe(1);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
});
