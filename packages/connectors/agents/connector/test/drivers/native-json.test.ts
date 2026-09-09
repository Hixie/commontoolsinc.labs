import { describe, it } from "@std/testing/bdd";
/** Independent lexical and source-boundary checks for the native tokenizer. */
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";
import {
  type NativeJsonToken,
  NativeJsonTokenizer,
} from "../../src/drivers/native-json.ts";
import {
  decodeNativeJson,
  nativeSessionFiles,
  openNativeSessionLog,
} from "../../src/drivers/native-session-log.ts";
import { streamNativeSessions } from "../../src/drivers/native-source.ts";
import { NativeSqliteSnapshot } from "../../src/drivers/sqlite-snapshot.ts";
import {
  collectionLimits,
  type StreamSessionSummary,
} from "../../src/session-stream.ts";

const id = "00000000-0000-4000-8000-000000000001";
const limits = collectionLimits({ readBytes: 17 });
const summary = (): StreamSessionSummary => ({
  nativeSessionId: id,
  title: null,
  cwd: null,
  createdAt: null,
  updatedAt: null,
  archived: null,
  active: null,
});

function parsedByTokens(source: string, size: number): unknown[] {
  using tokenizer = new NativeJsonTokenizer();
  const result: unknown[] = [];
  const containers: Array<
    { value: Record<string, unknown> | unknown[]; key: string }
  > = [];
  let scalar = "";
  const append = (value: unknown) => {
    const top = containers.at(-1);
    if (!top) result.push(value);
    else if (Array.isArray(top.value)) top.value.push(value);
    else {Object.defineProperty(top.value, top.key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });}
  };
  const consume = (token: NativeJsonToken) => {
    switch (token.name) {
      case "startObject":
      case "startArray": {
        const value = token.name === "startObject" ? {} : [];
        append(value);
        containers.push({ value, key: "" });
        break;
      }
      case "endObject":
      case "endArray":
        containers.pop();
        break;
      case "startKey":
      case "startString":
      case "startNumber":
        scalar = "";
        break;
      case "stringChunk":
      case "numberChunk":
        scalar += token.value;
        break;
      case "endKey":
        containers.at(-1)!.key = scalar;
        break;
      case "endString":
        append(scalar);
        break;
      case "endNumber":
        append(Number(scalar));
        break;
      case "trueValue":
      case "falseValue":
      case "nullValue":
        append(token.value);
        break;
    }
  };
  for (let offset = 0; offset < source.length; offset += size) {
    for (const token of tokenizer.write(source.slice(offset, offset + size))) {
      consume(token);
    }
  }
  tokenizer.finish();
  return result;
}

describe("native JSON fragments and source capture", () => {
  it("fragmented JSON matches independent native parsing", () => {
    const valid = [
      "{}",
      '{"a":[]}',
      '{"a":{}}',
      '{"a":[true,false,null,"",{},[]]}',
      '{"__proto__":{"value":1},"constructor":"x"}',
      '{"a":-0,"b":0,"c":-1.23e-04,"d":1E+9,"e":1e309}',
      '{"a":"\\"\\\\\\/\\b\\f\\n\\r\\t\\u0000\\u0022\\ud83d\\udc08\\ud800\\udfff"}',
      '{"a":"🐈  ","b":"text","nested":{"a":[1,{"x":false}]}}',
      '{"a":1,"a":2,"b":null}',
    ];
    for (let number = 0; number < 30; number++) {
      valid.push(
        JSON.stringify({
          number,
          list: [number / 7, -number, String.fromCharCode(number), {
            text: "x".repeat(number),
            empty: [],
          }],
        }),
      );
    }
    for (const source of valid) {
      const expected = JSON.parse(source);
      for (const size of [1, 2, 3, 7, 64]) {
        expect(parsedByTokens(source, size)).toEqual([expected]);
      }
    }
  });

  it("mutated syntax agrees with JSON.parse rejection", () => {
    const seeds = [
      '{"a":[true,false,null,0,-12.5e+4,"\\u00ab"]}',
      '{"a":{"b":[]},"c":"escaped\\ntext"}',
    ];
    const replacements = [
      "{",
      "}",
      "[",
      "]",
      ",",
      ":",
      '"',
      "\\",
      "0",
      "1",
      "-",
      "+",
      ".",
      "e",
      "t",
      "f",
      "n",
      " ",
      "\n",
      "\u0000",
    ];
    for (const seed of seeds) {
      for (let position = 1; position < seed.length; position++) {
        for (const replacement of replacements) {
          const source = seed.slice(0, position) + replacement +
            seed.slice(position + 1);
          let valid = false;
          let expected;
          try {
            expected = JSON.parse(source);
            valid = true;
          } catch {
            /* Compare rejection below. */
          }
          let actual;
          let error;
          try {
            actual = parsedByTokens(source, 1);
          } catch (caught) {
            error = caught;
          }
          if (valid) expect(actual, source).toEqual([expected]);
          else expect(error, source).toBeDefined();
        }
      }
    }
  });

  it("stack pages restore alternating containers and release scratch", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agents-json-test-" });
    try {
      for (const depth of [4095, 4096, 4097, 8191, 8192, 8193, 10000]) {
        const opens = Array.from(
          { length: depth },
          (_, index) => index % 3 ? "[" : '{"x":',
        );
        const closes = opens.map((value) => value === "[" ? "]" : "}")
          .reverse();
        const body = opens.join("") + "true" + closes.join("");
        const source = '{"a":[' + body + "," + body + '],"after":"ok"}';
        JSON.parse(source);
        let objects = 0;
        let arrays = 0;
        let ends = 0;
        {
          using tokenizer = new NativeJsonTokenizer(directory);
          for (let offset = 0; offset < source.length; offset += 97) {
            for (
              const token of tokenizer.write(source.slice(offset, offset + 97))
            ) {
              if (token.name === "startObject") objects++;
              if (token.name === "startArray") arrays++;
              if (token.name === "endObject" || token.name === "endArray") {
                ends++;
              }
            }
          }
          tokenizer.finish();
        }
        expect(objects + arrays).toBe(2 * depth + 2);
        expect(ends).toBe(objects + arrays);
        const leftovers = [];
        for await (const entry of Deno.readDir(directory)) {
          leftovers.push(entry.name);
        }
        expect(leftovers).toEqual([]);
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("raw UTF-8 and escape fragments survive every small byte split", async () => {
    const text = '🐈\n\t\\"\u0000';
    const source = JSON.stringify({
      type: "assistant",
      uuid: "message",
      message: { role: "assistant", content: [{ type: "text", text }] },
    }) + "\n";
    const expected = new TextEncoder().encode(source);
    for (const size of [1, 2, 3, 4, 7, 17]) {
      const chunks = function* () {
        for (let offset = 0; offset < expected.length; offset += size) {
          yield expected.subarray(offset, offset + size);
        }
      };
      const bytes: number[] = [];
      const messages = [];
      let events = 0;
      for await (
        const part of decodeNativeJson(
          chunks(),
          { kind: "claude-project", path: "/synthetic" },
          summary(),
          "claude-project-jsonl",
        )
      ) {
        bytes.push(...part.bytes);
        messages.push(...part.messages);
        events += part.eventCount;
      }
      expect(new Uint8Array(bytes)).toEqual(expected);
      expect(messages.map((message) => message.textPreview)).toEqual([text]);
      expect(events).toBe(1);
    }
  });

  it("spilled stacks close on syntax failure and early consumer return", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agents-json-test-" });
    try {
      const prefix = '{"a":' + "[".repeat(4100) + "0";
      expect(() => {
        using tokenizer = new NativeJsonTokenizer(directory);
        for (
          const _token of tokenizer.write(prefix)
        ) { /* Reach the spill boundary. */ }
        tokenizer.finish();
      }).toThrow("incomplete");
      const chunks = [
        new TextEncoder().encode(prefix),
        new TextEncoder().encode("]".repeat(4100) + "}"),
      ];
      for await (
        const _part of decodeNativeJson(
          chunks,
          { kind: "claude-project", path: "/synthetic" },
          summary(),
          "claude-project-jsonl",
          undefined,
          undefined,
          directory,
        )
      ) break;
      const leftovers = [];
      for await (const entry of Deno.readDir(directory)) {
        leftovers.push(entry.name);
      }
      expect(leftovers).toEqual([]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("signed rowids survive actual incremental TEXT reads", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agents-json-test-" });
    try {
      const path = `${directory}/native.sqlite`;
      const database = new Database(path, { int64: true });
      try {
        database.exec("CREATE TABLE messages (value TEXT)");
        using insert = database.prepare(
          "INSERT INTO messages (rowid,value) VALUES (?,?)",
        );
        insert.run(-9223372036854775808n, "negative 🐈");
        insert.run(9223372036854775807n, "positive 🐈");
      } finally {
        database.close();
      }
      using snapshot = new NativeSqliteSnapshot(path);
      const actual = [];
      for (const row of snapshot.rows("messages")) {
        const decoder = new TextDecoder();
        let text = "";
        for (const part of snapshot.bytes("messages", row, "value", 2)) {
          text += decoder.decode(part, { stream: true });
        }
        text += decoder.decode();
        actual.push([String(row), text]);
      }
      expect(actual).toEqual([["-9223372036854775808", "negative 🐈"], [
        "9223372036854775807",
        "positive 🐈",
      ]]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("UUID subagent names retain their parent identity", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agents-json-test-" });
    try {
      const childId = "00000000-0000-4000-8000-000000000002";
      await Deno.mkdir(`${directory}/${id}/subagents`, { recursive: true });
      const path = `${directory}/${id}/subagents/agent-${childId}.jsonl`;
      await Deno.writeTextFile(path, "{}");
      const files = [];
      for await (const file of nativeSessionFiles(directory, null)) {
        files.push(file);
      }
      expect(files).toEqual([{
        path,
        id,
        archived: null,
        subagentId: childId,
      }]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("Claude generated titles, last prompts, and cleared titles retain precedence", async () => {
    const cases = [
      {
        records: [{ type: "user", message: { content: "first" } }, {
          type: "ai-title",
          aiTitle: "generated",
        }],
        title: "generated",
      },
      {
        records: [{ type: "summary", summary: "summary" }, {
          type: "last-prompt",
          lastPrompt: "latest",
        }],
        title: "latest",
      },
      {
        records: [{ type: "custom-title", customTitle: "manual" }, {
          type: "ai-title",
          aiTitle: "generated",
        }, { type: "custom-title", customTitle: "" }],
        title: "generated",
      },
    ];
    const actual = [];
    for (const { records } of cases) {
      const projected = summary();
      const bytes = new TextEncoder().encode(
        records.map((record) => JSON.stringify(record)).join("\n"),
      );
      for await (
        const _part of decodeNativeJson(
          [bytes],
          { kind: "claude-project", path: "/synthetic" },
          projected,
          "claude-project-jsonl",
        )
      ) { /* Complete projection. */ }
      actual.push(projected.title);
    }
    expect(actual).toEqual(cases.map(({ title }) => title));
  });

  it("native-file stack spill uses the configured scratch directory", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agents-json-test-" });
    const makeTempFile = Deno.makeTempFileSync;
    try {
      const scratchDirectory = `${directory}/scratch`;
      await Deno.mkdir(`${directory}/projects/project`, { recursive: true });
      await Deno.writeTextFile(
        `${directory}/projects/project/${id}.jsonl`,
        '{"opaque":' + "[".repeat(4100) + "0" + "]".repeat(4100) + "}",
      );
      Deno.makeTempFileSync = (options) => {
        if (options?.prefix === "native-json-stack-") {
          expect(options.dir).toBe(scratchDirectory);
        }
        return makeTempFile(options);
      };
      for await (
        const session of streamNativeSessions({
          id: "claude",
          driver: "claude-agent-sdk",
          enabled: true,
          configDir: directory,
        }, { limits, scratchDirectory })
      ) for await (const _part of session.parts) { /* Complete source. */ }
    } finally {
      Deno.makeTempFileSync = makeTempFile;
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("append during hash capture leaves the pinned prefix collectible", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agents-json-test-" });
    const open = Deno.open;
    try {
      const path = `${directory}/${id}.jsonl`;
      const source = '{"type":"user","message":{"content":"' + "x".repeat(100) +
        '"}}\n';
      await Deno.writeTextFile(path, source);
      await Deno.utime(path, 100, 100);
      let appended = false;
      Deno.open = async (name, options) => {
        const file = await open(name, options);
        if (name !== path || appended) return file;
        return new Proxy(file, {
          get(target, key) {
            if (key === "read") {
              return async (buffer: Uint8Array) => {
                const count = await target.read(buffer);
                if (!appended) {
                  appended = true;
                  await Deno.writeTextFile(path, "{}\n", { append: true });
                  await Deno.utime(path, 200, 200);
                }
                return count;
              };
            }
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };
      const session = await openNativeSessionLog(
        { path, id, archived: null },
        "claude-project-jsonl",
        limits,
      );
      let actual = 0;
      for await (const part of session.parts) actual += part.bytes.length;
      expect(actual).toBe(new TextEncoder().encode(source).length);
    } finally {
      Deno.open = open;
      await Deno.remove(directory, { recursive: true });
    }
  });
});
