/** Exercises archive transfer cancellation and command admission boundaries. */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { ArchiveStore } from "../v2/archive-store.ts";
import { ArchiveHttp } from "../v2/archive-http.ts";
import {
  ARCHIVE_LIMITS,
  type ArchiveCommand,
  type ArchiveIdentity,
  type ArchiveTicket,
  readArchiveBody,
  validateArchiveCommand,
} from "../v2/archive.ts";

const identity: ArchiveIdentity = {
  space: "did:key:archive-boundary-test",
  principal: "did:key:owner",
  actingPrincipal: "did:key:owner",
  sessionId: "owner-session",
  connectionId: "owner-connection",
};

function request(
  ticket: ArchiveTicket,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://archive.example/transfer", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ticket.token}`,
      "content-type": "application/octet-stream",
      "content-length": "0",
      ...headers,
    },
    body: new Uint8Array(0),
    signal,
  });
}

const read: ArchiveCommand = {
  op: "read",
  archive: "a0",
  generation: "b0",
  pin: "c0",
  key: "record",
  index: 0,
  hash: "a".repeat(64),
};

describe("archive boundary review", () => {
  it("releases unconsumed responses when the HTTP request disconnects", async () => {
    const root = await Deno.makeTempDir({ prefix: "archive-boundary-abort-" });
    try {
      using store = await ArchiveStore.open({ root });
      const http = new ArchiveHttp(store, () =>
        Promise.resolve({
          writerPolicy: "test",
          cfcPolicy: "{}",
        }), []);
      try {
        const held = [];
        for (
          let index = 0;
          index < ARCHIVE_LIMITS.principalTransfers;
          index++
        ) {
          const ticket = await http.issue(
            { op: "open", handle: String(index) },
            identity,
          );
          const abort = new AbortController();
          const response = await http.handle(request(ticket, abort.signal));
          expect(response.status).toBe(200);
          held.push({ abort, response });
        }
        for (const { abort } of held) {
          abort.abort(new Error("peer disconnected"));
        }
        const ticket = await http.issue({
          op: "open",
          handle: "after-disconnect",
        }, identity);
        const response = await http.handle(request(ticket));
        try {
          expect(response.status).toBe(200);
        } finally {
          await response.body?.cancel();
        }
        for (const { response } of held) {
          const reader = response.body!.getReader();
          try {
            await expect(reader.read()).rejects.toThrow(
              "Archive transfer closed",
            );
          } finally {
            reader.releaseLock();
          }
        }
      } finally {
        await http.close();
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("rejects unknown operation fields and unsupported byte ranges before admission", () => {
    for (
      const command of [
        { op: "open", handle: "a", writer: "did:key:someone" },
        { ...read, offset: 1 },
        { ...read, length: 1 },
        { ...read, readers: ["did:key:someone"] },
        { op: "delete", archive: "a0", generation: "b0" },
      ]
    ) {
      expect(() => validateArchiveCommand(command)).toThrow(
        "Unknown archive field",
      );
    }
  });

  it("requires an exact SHA-256 digest for read capabilities", () => {
    for (const hash of ["a", "z".repeat(64), "A".repeat(64), "a".repeat(63)]) {
      expect(() => validateArchiveCommand({ ...read, hash })).toThrow(
        "Invalid archive hash",
      );
    }
  });

  it("releases the input reader and preserves a consumption failure when cancellation fails", async () => {
    const original = new Error("consumer rejected the bytes");
    const cleanup = new Error("input cancellation failed");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        throw cleanup;
      },
    }, { highWaterMark: 0 });
    let failure: unknown;
    try {
      await readArchiveBody(body, 1, () => {
        throw original;
      });
    } catch (error) {
      failure = error;
    }
    expect(body.locked).toBe(false);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([original, cleanup]);
  });

  it("releases the input reader after an errored stream", async () => {
    const original = new Error("input failed");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(original);
      },
    }, { highWaterMark: 0 });
    await expect(readArchiveBody(body, 1, () => {})).rejects.toThrow(
      "input failed",
    );
    expect(body.locked).toBe(false);
  });

  it("requires the exact configured origin and admits only its fixed preflight", async () => {
    const root = await Deno.makeTempDir({ prefix: "archive-boundary-origin-" });
    try {
      using store = await ArchiveStore.open({ root });
      const authorize = () =>
        Promise.resolve({ writerPolicy: "test", cfcPolicy: "{}" });
      for (
        const origin of [
          "null",
          "https://allowed.example/",
          "https://allowed.example:443",
          "file:///tmp/archive",
        ]
      ) {
        expect(() => new ArchiveHttp(store, authorize, [origin])).toThrow();
      }
      const http = new ArchiveHttp(store, authorize, [
        "https://allowed.example",
      ]);
      try {
        const cases: [Record<string, string>, number][] = [
          [{}, 200],
          [{ origin: "https://allowed.example" }, 200],
          [{ "sec-fetch-site": "same-origin" }, 403],
          [{ origin: "null" }, 403],
          [{ origin: "https://allowed.example/" }, 403],
          [{ origin: "https://allowed.example:443" }, 403],
          [{ origin: "https://allowed.example.evil" }, 403],
          [{ origin: "https://user@allowed.example" }, 403],
          [{ origin: "http://allowed.example" }, 403],
        ];
        for (const [headers, status] of cases) {
          const ticket = await http.issue(
            { op: "open", handle: "origin" },
            identity,
          );
          const response = await http.handle(
            request(ticket, undefined, headers),
          );
          expect(response.status).toBe(status);
          expect(response.headers.get("access-control-allow-origin")).toBe(
            status === 200 ? headers.origin ?? null : null,
          );
          await response.body?.cancel();
          http.acknowledge(ticket.token, identity);
        }
        for (
          const [method, headers, status] of [
            ["POST", "authorization, content-type", 204],
            ["POST", "Authorization, Content-Type", 204],
            ["POST", "authorization, range", 403],
            ["GET", "authorization", 403],
          ] as const
        ) {
          const response = await http.handle(
            new Request("https://archive.example/transfer", {
              method: "OPTIONS",
              headers: {
                origin: "https://allowed.example",
                "access-control-request-method": method,
                "access-control-request-headers": headers,
              },
            }),
          );
          expect(response.status).toBe(status);
          await response.body?.cancel();
        }
      } finally {
        await http.close();
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("rejects HTTP byte range headers", async () => {
    const root = await Deno.makeTempDir({ prefix: "archive-boundary-range-" });
    try {
      using store = await ArchiveStore.open({ root });
      const http = new ArchiveHttp(
        store,
        () => Promise.resolve({ writerPolicy: "test", cfcPolicy: "{}" }),
        [],
      );
      try {
        for (const header of ["range", "content-range"]) {
          const ticket = await http.issue(
            { op: "open", handle: "range" },
            identity,
          );
          const response = await http.handle(
            request(ticket, undefined, { [header]: "bytes=0-0" }),
          );
          try {
            expect(response.status).toBe(400);
          } finally {
            await response.body?.cancel();
            http.acknowledge(ticket.token, identity);
          }
        }
      } finally {
        await http.close();
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("enforces global admission across principals until responses are canceled", async () => {
    const root = await Deno.makeTempDir({ prefix: "archive-boundary-global-" });
    try {
      using store = await ArchiveStore.open({ root });
      const http = new ArchiveHttp(
        store,
        () => Promise.resolve({ writerPolicy: "test", cfcPolicy: "{}" }),
        [],
      );
      const responses: Response[] = [];
      try {
        for (let index = 0; index < ARCHIVE_LIMITS.transfers; index++) {
          const principal = `did:key:reader-${index}`;
          const ticket = await http.issue({ op: "open", handle: principal }, {
            ...identity,
            principal,
            actingPrincipal: principal,
          });
          const response = await http.handle(request(ticket));
          expect(response.status).toBe(200);
          responses.push(response);
        }
        const principal = "did:key:last-reader";
        const lastIdentity = {
          ...identity,
          principal,
          actingPrincipal: principal,
        };
        const ticket = await http.issue(
          { op: "open", handle: principal },
          lastIdentity,
        );
        const rejected = await http.handle(request(ticket));
        expect(rejected.status).toBe(429);
        await rejected.body?.cancel();
        await responses.shift()!.body?.cancel();
        const replacement = await http.issue(
          { op: "open", handle: principal },
          lastIdentity,
        );
        const accepted = await http.handle(request(replacement));
        expect(accepted.status).toBe(200);
        responses.push(accepted);
      } finally {
        for (const response of responses) await response.body?.cancel();
        await http.close();
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("bounds all principal pins and invalidates them on restart", async () => {
    const root = await Deno.makeTempDir({ prefix: "archive-boundary-pins-" });
    let store: ArchiveStore | undefined;
    try {
      store = await ArchiveStore.open({ root });
      const archive = store.openBinding(identity, "pins", {
        writerPolicy: "test",
        cfcPolicy: "{}",
      }).id;
      const allow = () => Promise.resolve();
      await store.execute(
        { op: "begin", archive, generation: "a0", base: null },
        identity,
        allow,
      );
      await store.execute(
        { op: "publish", archive, generation: "a0" },
        identity,
        allow,
      );
      const command = { op: "pin", archive, generation: "a0" } as const;
      let firstPin: string | undefined;
      for (let index = 0; index < ARCHIVE_LIMITS.pins; index++) {
        const principal = `did:key:reader-${
          Math.floor(index / ARCHIVE_LIMITS.principalPins)
        }`;
        const result = await store.execute(command, {
          ...identity,
          principal,
          actingPrincipal: principal,
        }, allow);
        if (!(result instanceof Uint8Array)) firstPin ??= result.pin;
      }
      await expect(store.execute(command, identity, allow)).rejects.toThrow(
        "pin limit",
      );
      store[Symbol.dispose]();
      store = await ArchiveStore.open({ root });
      const firstIdentity = {
        ...identity,
        principal: "did:key:reader-0",
        actingPrincipal: "did:key:reader-0",
      };
      await expect(
        store.execute(
          { op: "count", archive, generation: "a0", pin: firstPin! },
          firstIdentity,
          allow,
        ),
      ).rejects.toThrow("pin is unavailable");
      const fresh = await store.execute(command, firstIdentity, allow);
      expect(fresh).toHaveProperty("pin");
    } finally {
      store?.[Symbol.dispose]();
      await Deno.remove(root, { recursive: true });
    }
  });

  it("releases the original request reader when an incoming body errors", async () => {
    const root = await Deno.makeTempDir({ prefix: "archive-boundary-input-" });
    try {
      using store = await ArchiveStore.open({ root });
      const http = new ArchiveHttp(
        store,
        () => Promise.resolve({ writerPolicy: "test", cfcPolicy: "{}" }),
        [],
      );
      try {
        const ticket = await http.issue(
          { op: "open", handle: "input-error" },
          identity,
        );
        const input = request(ticket);
        const failed = new Request(input, {
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("incoming body failed"));
            },
          }, { highWaterMark: 0 }),
        });
        const response = await http.handle(failed);
        expect(response.status).toBe(403);
        expect(await response.text()).toContain("incoming body failed");
        expect(failed.body!.locked).toBe(false);
      } finally {
        await http.close();
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
