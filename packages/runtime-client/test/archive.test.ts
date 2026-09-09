/** Verifies imperative archive reads keep native bytes outside runtime messages. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  $conn,
  CellHandle,
  type CellRef,
  RequestType,
  type RuntimeClient,
} from "../src/mod.ts";

const ref: CellRef = {
  space: "did:key:archive",
  id: "of:catalog",
  path: [],
  scope: "space",
};
const command = {
  op: "read",
  archive: "abc",
  generation: "a1",
  pin: "b1",
  key: "session",
  index: 0,
  hash: "",
} as const;

describe("imperative archive reader", () => {
  it("fetches and verifies native bytes directly and acknowledges consumption without caching a cell value", async () => {
    const bytes = new TextEncoder().encode("native page");
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const requests: Array<{ type: RequestType; consumed?: boolean }> = [];
    const runtime = {
      [$conn]: () => ({
        request(request: { type: RequestType; consumed?: boolean }) {
          requests.push(request);
          if (request.type === RequestType.ArchivePrepareRead) {
            return Promise.resolve({
              transfer: {
                url: "https://archive.example/transfer",
                ticket: { token: "capability", bytes: 0, expiresAt: 1 },
              },
            });
          }
          if (request.type === RequestType.ArchiveAcknowledge) {
            return Promise
              .resolve({});
          }
          throw new Error("Unexpected runtime request");
        },
      }),
    } as unknown as RuntimeClient;
    const cell = new CellHandle(runtime, ref);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      expect(String(url)).toBe("https://archive.example/transfer");
      expect(options?.credentials).toBe("omit");
      expect(options?.redirect).toBe("error");
      expect(new Headers(options?.headers).get("authorization")).toBe(
        "Bearer capability",
      );
      return Promise.resolve(
        new Response(bytes, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(bytes.length),
          },
        }),
      );
    };
    try {
      expect(await cell.archive({ ...command, hash })).toEqual(bytes);
      expect(requests.map((request) => request.type)).toEqual([
        RequestType.ArchivePrepareRead,
        RequestType.ArchiveAcknowledge,
      ]);
      expect(requests.at(-1)?.consumed).toBe(true);
      expect(JSON.stringify(requests)).not.toContain("native page");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses an oversized response before reading its body and releases the capability", async () => {
    const requests: Array<{ type: RequestType; consumed?: boolean }> = [];
    let pulled = false;
    let canceled = false;
    const runtime = {
      [$conn]: () => ({
        request(request: { type: RequestType; consumed?: boolean }) {
          requests.push(request);
          return Promise.resolve(
            request.type === RequestType.ArchivePrepareRead
              ? {
                transfer: {
                  url: "https://archive.example/transfer",
                  ticket: { token: "capability", bytes: 0, expiresAt: 1 },
                },
              }
              : {},
          );
        },
      }),
    } as unknown as RuntimeClient;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull() {
              pulled = true;
            },
            cancel() {
              canceled = true;
            },
          }, { highWaterMark: 0 }),
          { headers: { "content-length": String(2 ** 31) } },
        ),
      );
    try {
      await expect(new CellHandle(runtime, ref).archive(command)).rejects
        .toThrow("bounded Content-Length");
      expect(requests.at(-1)?.consumed).toBe(false);
      expect(pulled).toBe(false);
      expect(canceled).toBe(true);
      expect(requests.map((request) => request.type)).toEqual([
        RequestType.ArchivePrepareRead,
        RequestType.ArchiveAcknowledge,
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves the fetch failure when its acknowledgement also fails", async () => {
    const original = new Error("direct page fetch failed");
    const cleanup = new Error("runtime acknowledgement failed");
    const runtime = {
      [$conn]: () => ({
        request(request: { type: RequestType; consumed?: boolean }) {
          if (request.type === RequestType.ArchivePrepareRead) {
            return Promise.resolve({
              transfer: {
                url: "https://archive.example/transfer",
                ticket: { token: "capability", bytes: 0, expiresAt: 1 },
              },
            });
          }
          if (request.type === RequestType.ArchiveAcknowledge) {
            expect(request.consumed).toBe(false);
            return Promise
              .reject(cleanup);
          }
          throw new Error("Unexpected runtime request");
        },
      }),
    } as unknown as RuntimeClient;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(original);
    let failure: unknown;
    try {
      await new CellHandle(runtime, ref).archive(command);
    } catch (error) {
      failure = error;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([original, cleanup]);
    expect((failure as AggregateError).cause).toBe(original);
  });
});
