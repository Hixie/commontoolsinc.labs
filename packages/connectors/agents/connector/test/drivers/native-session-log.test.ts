/** Exercises native history decoding across byte and JSON token boundaries. */

import { encodeHex } from "@std/encoding/hex";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { createHasher } from "@commonfabric/content-hash";
import {
  decodeNativeJson,
  type NativeJsonFormat,
  nativeSessionFiles,
  openNativeSessionLog,
} from "../../src/drivers/native-session-log.ts";
import {
  collectionLimits,
  type StreamSessionSummary,
} from "../../src/session-stream.ts";

describe("native-session-log", () => {
  it("preserves complete working directories while bounding display previews", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agent-log-test-" });
    const cwd = `${directory}/${Array(8).fill("a".repeat(64)).join("/")}`;
    const id = "00000000-0000-4000-8000-000000000001";
    const path = `${directory}/${id}.jsonl`;
    const title = "Title ".repeat(100);
    const content = "Message ".repeat(100);
    const cases = [{
      format: "claude-project-jsonl" as const,
      value: {
        type: "user",
        cwd,
        customTitle: title,
        message: { role: "user", content },
      },
    }, {
      format: "claude-project-jsonl" as const,
      value: {
        type: "relocated",
        cwd: "/original",
        relocatedCwd: cwd,
        customTitle: title,
        message: { role: "user", content },
      },
    }, {
      format: "codex-rollout-jsonl" as const,
      value: {
        type: "response_item",
        payload: { type: "message", role: "user", cwd, title, content },
      },
    }];
    try {
      await Deno.mkdir(cwd, { recursive: true });
      expect(cwd.length).toBeGreaterThan(500);
      for (const { format, value } of cases) {
        await Deno.writeTextFile(path, JSON.stringify(value) + "\n");
        const session = await openNativeSessionLog(
          { path, id, archived: null },
          format,
          collectionLimits({ readBytes: 17 }),
        );
        const previews: Array<string | null> = [];
        for await (const part of session.parts) {
          previews.push(...part.messages.map((message) => message.textPreview));
        }
        expect(session.summary.cwd).toBe(cwd);
        expect(session.summary.title).toBe(title.slice(0, 500));
        expect(previews).toEqual([content.slice(0, 500)]);
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("preserves native bytes while enforcing the working-directory UTF-8 budget", async () => {
    const encoder = new TextEncoder();
    const boundary = "/" + "é".repeat(2045) + "a🐈";
    expect(encoder.encode(boundary).length).toBe(4096);
    const paths = [
      "/initial",
      boundary,
      boundary + "a",
      "/" + "é".repeat(10000),
      "/recovered",
    ];
    const cases: Array<{
      format: NativeJsonFormat;
      record: (cwd: string) => object;
    }> = [{
      format: "claude-project-jsonl",
      record: (cwd) => ({ type: "user", cwd }),
    }, {
      format: "claude-project-jsonl",
      record: (relocatedCwd) => ({ type: "relocated", relocatedCwd }),
    }, {
      format: "codex-rollout-jsonl",
      record: (cwd) => ({ type: "session_meta", payload: { cwd } }),
    }];
    for (const { format, record } of cases) {
      const source = paths.map((path) =>
        JSON.stringify(record(path)).replaceAll("🐈", "\\ud83d\\udc08") + "\n"
      );
      const summary: StreamSessionSummary = {
        nativeSessionId: "00000000-0000-4000-8000-000000000001",
        cwd: null,
        title: null,
        createdAt: null,
        updatedAt: null,
        archived: null,
        active: null,
      };
      const chunks = function* (): Generator<Uint8Array> {
        for (const record of source) {
          const bytes = encoder.encode(record);
          for (let offset = 0; offset < bytes.length; offset += 17) {
            yield bytes.subarray(offset, offset + 17);
          }
        }
      };
      const actual = createHasher();
      const observed: Array<string | null> = [];
      for await (
        const part of decodeNativeJson(
          chunks(),
          { kind: "claude-project", path: "/synthetic" },
          summary,
          format,
        )
      ) {
        actual.update(part.bytes);
        if (part.eventCount > 0) observed.push(summary.cwd);
      }
      expect(observed).toEqual([
        "/initial",
        boundary,
        null,
        null,
        "/recovered",
      ]);
      const expected = createHasher();
      expected.update(encoder.encode(source.join("")));
      expect(actual.digest("base64url")).toBe(expected.digest("base64url"));
    }
  });

  it("preserves escaped strings and UTF-8 across bounded reads", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agent-log-test-" });
    const id = "00000000-0000-4000-8000-000000000001";
    const path = `${directory}/${id}.jsonl`;
    const value = '🐈\n\t\\"\u0000';
    const source = JSON.stringify({
      type: "assistant",
      uuid: "message-1",
      cwd: "/project",
      message: {
        role: "assistant",
        content: [{ type: "text", text: value.repeat(500) }],
      },
    }) + "\n";
    try {
      await Deno.writeTextFile(path, source);
      const session = await openNativeSessionLog(
        { path, id, archived: null },
        "claude-project-jsonl",
        collectionLimits({ readBytes: 17 }),
      );
      const hasher = createHasher();
      let events = 0;
      let messages = 0;
      for await (const part of session.parts) {
        expect(part.bytes.byteLength).toBeLessThanOrEqual(17);
        hasher.update(part.bytes);
        events += part.eventCount;
        for (const message of part.messages) {
          messages++;
          expect(message.id).toBe("message-1");
          expect(message.textPreview).toBe(value.repeat(500).slice(0, 500));
          expect(message.rawIndex).toBe(0);
        }
      }
      const expected = createHasher();
      const bytes = new TextEncoder().encode(source);
      expected.update(bytes);
      const expectedHash = encodeHex(expected.digest());
      expect(encodeHex(hasher.digest())).toBe(expectedHash);
      expect(session.revision).toBe(`${bytes.length}:${expectedHash}`);
      expect(events).toBe(1);
      expect(messages).toBe(1);
      expect(session.summary.cwd).toBe("/project");
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("stops before consuming the complete session when the consumer stops", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agent-log-test-" });
    const id = "00000000-0000-4000-8000-000000000002";
    const path = `${directory}/${id}.jsonl`;
    try {
      await Deno.writeTextFile(
        path,
        '{"type":"assistant","message":{"content":"' + "x".repeat(4096),
      );
      const session = await openNativeSessionLog(
        { path, id, archived: false },
        "claude-project-jsonl",
        collectionLimits({ readBytes: 64 }),
      );
      let consumed = 0;
      for await (const part of session.parts) {
        consumed += part.bytes.length;
        break;
      }
      expect(consumed).toBe(64);
      await Deno.remove(path);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("captures a fixed file extent while the source appends", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agent-log-test-" });
    const id = "00000000-0000-4000-8000-000000000003";
    const path = `${directory}/${id}.jsonl`;
    try {
      await Deno.writeTextFile(
        path,
        '{"type":"user","message":{"content":"one"}}\n',
      );
      const session = await openNativeSessionLog(
        { path, id, archived: false },
        "claude-project-jsonl",
        collectionLimits(),
      );
      await Deno.writeTextFile(
        path,
        '{"type":"user","message":{"content":"two"}}\n',
        { append: true },
      );
      let events = 0;
      for await (const part of session.parts) events += part.eventCount;
      expect(events).toBe(1);
      expect(session.summary.title).toBe("one");
      const files = [];
      for await (const file of nativeSessionFiles(directory, false)) {
        files.push(file);
      }
      expect(files).toEqual([{ path, id, archived: false }]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("detects replacement of the pinned file while it is being read", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agent-log-test-" });
    const id = "00000000-0000-4000-8000-000000000004";
    const path = `${directory}/${id}.jsonl`;
    try {
      await Deno.writeTextFile(
        path,
        JSON.stringify({ type: "user", message: { content: "x".repeat(128) } }),
      );
      const session = await openNativeSessionLog(
        { path, id, archived: false },
        "claude-project-jsonl",
        collectionLimits({ readBytes: 32 }),
      );
      const consume = async () => {
        let replaced = false;
        for await (const _part of session.parts) {
          if (!replaced) {
            replaced = true;
            await Deno.rename(path, `${path}.old`);
            await Deno.writeTextFile(path, "{}");
          }
        }
      };
      await expect(consume()).rejects.toThrow("replaced");
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("reports truncation and incomplete terminal records", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agent-log-test-" });
    const id = "00000000-0000-4000-8000-000000000005";
    const path = `${directory}/${id}.jsonl`;
    const consume = async (
      session: Awaited<ReturnType<typeof openNativeSessionLog>>,
    ) => {
      for await (
        const _part of session.parts
      ) { /* Consume the captured extent. */ }
    };
    try {
      await Deno.writeTextFile(
        path,
        '{"type":"user","message":{"content":"truncated"}}',
      );
      const session = await openNativeSessionLog(
        { path, id, archived: false },
        "claude-project-jsonl",
        collectionLimits(),
      );
      await Deno.truncate(path, 0);
      await expect(consume(session)).rejects.toThrow("truncated");
      await Deno.writeTextFile(
        path,
        '{"type":"user","message":{"content":"unfinished',
      );
      const incomplete = await openNativeSessionLog(
        { path, id, archived: false },
        "claude-project-jsonl",
        collectionLimits(),
      );
      await expect(consume(incomplete)).rejects.toThrow(
        "incomplete terminal record",
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
});
