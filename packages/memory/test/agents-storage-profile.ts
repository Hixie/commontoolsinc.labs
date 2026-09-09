/** Runs bounded page replacement against an instrumented child memory server. */
import { expect } from "@std/expect";
import { connect, type Transport } from "../v2/client.ts";
import type { Operation } from "../v2.ts";
import { testSessionOpenAuthFactory } from "./v2-auth-test-helpers.ts";
import {
  collectGarbage,
  ProfileLog,
  utf8Bytes,
} from "./agents-storage-profile-probes.ts";

const generations = Number(Deno.args[0] ?? 8);
const cacheBudget = Number(Deno.args[1] ?? 128 * 1024 * 1024);
const pages = 16;
const pageBytes = 256 * 1024;
if (!Number.isInteger(generations) || generations < 1 || generations > 8) {
  throw new Error("this controlled probe is limited to eight generations");
}
const libraryPath = Deno.args[2] ?? Deno.env.get("DENO_SQLITE_PATH");
if (!libraryPath) {
  throw new Error(
    "Pass the matching SQLite library as argument 3 or DENO_SQLITE_PATH",
  );
}
const directory = await Deno.makeTempDir({ prefix: "agents-storage-profile-" });
const token = crypto.randomUUID();
const output = new ProfileLog(`${directory}/client.jsonl`);
const errors = await Deno.open(`${directory}/server.stderr`, {
  createNew: true,
  write: true,
});
const child = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "--quiet",
    "-A",
    "--v8-flags=--expose-gc",
    new URL("./agents-storage-profile-server.ts", import.meta.url).pathname,
    directory,
    token,
    libraryPath,
    String(cacheBudget),
  ],
  env: { DENO_SQLITE_PATH: libraryPath },
  stdout: "piped",
  stderr: "piped",
}).spawn();
const errorPump = child.stderr.pipeTo(errors.writable);
const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
let readyLine = "";
while (!readyLine.includes("\n")) {
  const first = await lines.read();
  if (first.done) throw new Error(`server exited before ready: ${directory}`);
  readyLine += first.value;
  if (readyLine.length > 2048) throw new Error("invalid readiness response");
}
const ready = JSON.parse(readyLine.trim()) as { port: number; pid: number };
const base = new URL(`http://127.0.0.1:${ready.port}`);
const requestBytes = new Map<string, number>();
let localSeq = 0;
let firstSeq: number | undefined;
let totalPayloadBytes = 0;
let currentGeneration = 0;
let socket: WebSocket | undefined;
const requestId = (payload: string) =>
  /"requestId"\s*:\s*"([^"]+)"/.exec(payload)?.[1];

async function profile(path: string, stage: string) {
  const url = new URL(path, base);
  url.searchParams.set("token", token);
  url.searchParams.set("generation", String(currentGeneration));
  url.searchParams.set("stage", stage);
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  const server = await response.json();
  output.write(stage, {
    generation: currentGeneration,
    totalPayloadBytes,
    requests: requestBytes.size,
    outstandingRequestBytes: [...requestBytes.values()].reduce(
      (a, b) => a + b,
      0,
    ),
    websocketBufferedBytes: socket?.bufferedAmount ?? 0,
    server,
  });
  if (
    Deno.build.os === "darwin" && [
      "after-gc",
      "after-sqlite-shrink-and-gc",
      "after-storage-close-and-gc",
      "after-native-allocator-release",
    ].includes(stage)
  ) {
    const mapping = await new Deno.Command("/usr/bin/vmmap", {
      args: ["-summary", String(ready.pid)],
      stdout: "piped",
      stderr: "piped",
    }).output();
    expect(mapping.success).toBe(true);
    await Deno.writeFile(`${directory}/${stage}.vmmap.txt`, mapping.stdout);
  }
  return server;
}

async function openTransport(): Promise<Transport> {
  const url = new URL("/socket", base);
  url.protocol = "ws:";
  url.searchParams.set("token", token);
  const current = new WebSocket(url);
  socket = current;
  await new Promise<void>((resolve, reject) => {
    current.onopen = () => resolve();
    current.onerror = reject;
  });
  let receiver = (_payload: string) => {};
  let closeReceiver = (_error?: Error) => {};
  current.onmessage = (event) => {
    const payload = String(event.data);
    const id = requestId(payload);
    if (id) requestBytes.delete(id);
    receiver(payload);
  };
  current.onclose = () => closeReceiver();
  return {
    send(payload) {
      const id = requestId(payload);
      if (id) requestBytes.set(id, utf8Bytes(payload));
      current.send(payload);
      return Promise.resolve();
    },
    close() {
      const done = new Promise<void>((resolve) =>
        current.addEventListener("close", () => resolve(), { once: true })
      );
      current.close();
      return done;
    },
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver(next) {
      closeReceiver = next;
    },
  };
}

const pageId = (generation: number, page: number) =>
  `of:page-${generation}-${page}`;
const payload =
  'bounded Fabric page\nwith escaped quotes " and slashes \\ and utf8 λ🙂. ';
const bodyFor = (generation: number, page: number) =>
  `${generation}:${page}:` +
  payload.repeat(Math.floor((pageBytes - 32) / utf8Bytes(payload)));

try {
  await profile("/profile", "baseline");
  for (
    currentGeneration = 1;
    currentGeneration <= generations;
    currentGeneration++
  ) {
    await profile("/profile", "generation-start");
    const client = await connect({ transport: await openTransport() });
    const session = await client.mount(
      "did:key:agents-profile",
      {},
      testSessionOpenAuthFactory,
    );
    const transact = (operations: Operation[]) =>
      session.transact({
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations,
      });
    try {
      const operations: Operation[] = Array.from(
        { length: pages },
        (_, page) => {
          const body = bodyFor(currentGeneration, page);
          totalPayloadBytes += utf8Bytes(body);
          return {
            op: "set",
            id: pageId(currentGeneration, page),
            value: { value: { generation: currentGeneration, page, body } },
          };
        },
      );
      const published = await transact(operations);
      operations.length = 0;
      await profile("/profile", "pages-published");
      await transact([{
        op: "set",
        id: "of:catalog",
        value: {
          value: {
            generation: currentGeneration,
            first: pageId(currentGeneration, 0),
            count: pages,
          },
        },
      }]);
      firstSeq ??= published.seq;
      const watched = await session.watchSet([{
        id: "current-pages",
        kind: "graph",
        query: {
          roots: Array.from(
            { length: pages },
            (_, page) => ({
              id: pageId(currentGeneration, page),
              selector: { path: [], schema: false },
            }),
          ),
        },
      }]);
      expect(watched.entities).toHaveLength(pages);
      await profile("/profile", "pages-watched");
      for (let page = 0; page < pages; page++) {
        const result = await session.queryGraph({
          atSeq: published.seq,
          roots: [{
            id: pageId(currentGeneration, page),
            selector: { path: [], schema: false },
          }],
        });
        expect(result.entities).toHaveLength(1);
        const value = result.entities[0].document?.value as {
          body: string;
          generation: number;
        };
        expect(value.generation).toBe(currentGeneration);
        expect(utf8Bytes(value.body)).toBeLessThanOrEqual(pageBytes);
      }
      const historical = await session.queryGraph({
        atSeq: firstSeq,
        roots: [{ id: pageId(1, 0), selector: { path: [], schema: false } }],
      });
      expect(
        (historical.entities[0].document?.value as { generation: number })
          .generation,
      ).toBe(1);
      await profile("/profile", "historical-read");
      if (currentGeneration > 1) {
        await transact(
          Array.from(
            { length: pages },
            (_, page) => ({
              op: "patch",
              id: pageId(currentGeneration - 1, page),
              patches: [{ op: "remove", path: "/value" }],
            }),
          ),
        );
      }
      await session.watchSet([]);
      if (currentGeneration === generations) {
        await transact([
          ...Array.from(
            { length: pages },
            (_, page): Operation => ({
              op: "patch",
              id: pageId(currentGeneration, page),
              patches: [{ op: "remove", path: "/value" }],
            }),
          ),
          { op: "delete", id: "of:catalog" },
        ]);
      }
    } finally {
      await session.watchSet([]);
      await client.close();
    }
    const idle = await profile("/profile", "generation-complete");
    expect(idle.outstanding.receives).toBe(0);
    expect(idle.outstanding.receiveBytes).toBe(0);
    expect(idle.watches.entityBytes).toBe(0);
    expect(requestBytes.size).toBe(0);
  }
  currentGeneration = generations;
  collectGarbage();
  await profile("/collect", "after-gc");
  await profile("/clear-cache", "after-document-cache-clear-and-gc");
  await profile("/shrink-sqlite", "after-sqlite-shrink-and-gc");
  await profile("/close-storage", "after-storage-close-and-gc");
  await profile("/release-allocator", "after-native-allocator-release");
} finally {
  await profile("/stop", "stopped");
  const status = await child.status;
  await errorPump;
  expect(status.success).toBe(true);
  lines.releaseLock();
  output.close();
  console.log(
    JSON.stringify({
      directory,
      serverPid: ready.pid,
      generations,
      totalPayloadBytes,
      cacheBudget,
    }),
  );
}
