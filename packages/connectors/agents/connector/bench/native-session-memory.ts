/** Measures decoding of one escaped native JSON string without retaining it. */

import { parseArgs } from "@std/cli/parse-args";

import { createHasher } from "@commonfabric/content-hash";
import { openNativeSessionLog } from "../src/drivers/native-session-log.ts";
import {
  collectionLimits,
  type CollectionStage,
} from "../src/session-stream.ts";

const args = parseArgs(Deno.args, { string: ["bytes", "read-bytes"] });
const bytes = Number(args.bytes ?? 8 * 1024 * 1024);
const limits = collectionLimits({
  readBytes: Number(args["read-bytes"] ?? 65536),
});
if (!Number.isSafeInteger(bytes) || bytes < 1) {
  throw new Error("Invalid byte count");
}
const directory = await Deno.makeTempDir({ prefix: "agents-native-memory-" });
const id = "00000000-0000-4000-8000-000000000001";
const path = `${directory}/${id}.jsonl`;
const encoder = new TextEncoder();
const block = encoder.encode(
  ("x".repeat(128) + '\\n\\t\\uD83D\\uDC08\\"\\\\🐈').repeat(256),
);
const expected = createHasher();
const actual = createHasher();
const peaks: Partial<Record<CollectionStage, Deno.MemoryUsage>> = {};
let samples = 0;
const observe = (stage: CollectionStage) => {
  // Sampling tokens at fixed counts bounds instrumentation work per byte.
  if (stage === "decoding" && ++samples % 1024 !== 0) return;
  const usage = Deno.memoryUsage();
  const prior = peaks[stage];
  peaks[stage] = prior
    ? {
      rss: Math.max(prior.rss, usage.rss),
      heapTotal: Math.max(prior.heapTotal, usage.heapTotal),
      heapUsed: Math.max(prior.heapUsed, usage.heapUsed),
      external: Math.max(prior.external, usage.external),
    }
    : usage;
};
let written = 0;
let read = 0;
let events = 0;
let messages = 0;
try {
  {
    using file = await Deno.open(path, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    const write = async (chunk: Uint8Array) => {
      expected.update(chunk);
      written += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        offset += await file.write(chunk.subarray(offset));
      }
    };
    await write(
      encoder.encode(
        '{"type":"assistant","uuid":"huge-message","message":{"role":"assistant","content":"',
      ),
    );
    while (written < bytes) await write(block);
    await write(encoder.encode('"}}\n'));
  }
  const session = await openNativeSessionLog(
    { path, id, archived: null },
    "claude-project-jsonl",
    limits,
    undefined,
    observe,
  );
  for await (const part of session.parts) {
    actual.update(part.bytes);
    read += part.bytes.length;
    events += part.eventCount;
    messages += part.messages.length;
    if (
      part.messages.some((message) => (message.textPreview?.length ?? 0) > 500)
    ) {
      throw new Error("Unbounded preview");
    }
  }
  const hash = actual.digest("base64url");
  if (
    hash !== expected.digest("base64url") || read !== written || events !== 1 ||
    messages !== 1
  ) {
    throw new Error("Native source verification failed");
  }
  console.log(JSON.stringify({ read, events, messages, hash, limits, peaks }));
} finally {
  await Deno.remove(directory, { recursive: true });
}
