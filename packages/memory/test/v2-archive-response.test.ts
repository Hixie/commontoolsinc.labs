/** Checks admission while an acknowledged response still owns pending work. */
import { Database } from "@db/sqlite";
import {
  ARCHIVE_LIMITS,
  archiveResponseHash,
  readArchiveBody,
} from "../v2/archive.ts";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { ArchiveStore } from "../v2/archive-store.ts";
import { ArchiveHttp } from "../v2/archive-http.ts";
import type { ArchiveIdentity, ArchiveTicket } from "../v2/archive.ts";

const identity: ArchiveIdentity = {
  space: "did:key:archive-test",
  principal: "did:key:owner",
  actingPrincipal: "did:key:owner",
  sessionId: "session:owner",
  connectionId: "connection:owner",
};

function request(ticket: ArchiveTicket): Request {
  return new Request("http://archive.local/transfer", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ticket.token}`,
      "content-type": "application/octet-stream",
      "content-length": "0",
    },
    body: new Uint8Array(0),
  });
}

describe("archive response lifetime", () => {
  it("accepts attachment closure after archive storage has closed", async () => {
    const root = await Deno.makeTempDir({ prefix: "archive-test-detach-" });
    try {
      using store = await ArchiveStore.open({ root });
      const http = new ArchiveHttp(store, () =>
        Promise.resolve({
          writerPolicy: "agents",
          cfcPolicy: "{}",
        }), []);
      await http.issue({ op: "open", handle: "handle" }, identity);
      await http.close();
      store[Symbol.dispose]();
      http.detach(identity);
      http.detachSession(
        identity.space,
        identity.sessionId,
        identity.connectionId,
      );
      await expect(http.issue({ op: "open", handle: "handle" }, identity))
        .rejects.toThrow();
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("holds response slots until canceled response pulls unwind", async () => {
    const root = await Deno.makeTempDir({ prefix: "archive-test-response-" });
    try {
      using store = await ArchiveStore.open({ root });
      let gated = false;
      let entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const http = new ArchiveHttp(store, async () => {
        if (gated) {
          entered.resolve();
          await release.promise;
        }
        return { writerPolicy: "agents", cfcPolicy: "{}" };
      }, []);
      const tickets = [];
      for (let i = 0; i < 3; i++) {
        tickets.push(
          await http.issue({ op: "open", handle: `handle-${i}` }, identity),
        );
      }
      const held: Promise<unknown>[] = [];
      let third: Promise<Response> | undefined;
      try {
        const responses = [
          await http.handle(request(tickets[0])),
          await http.handle(request(tickets[1])),
        ];
        gated = true;
        for (const [index, response] of responses.entries()) {
          const reader = response.body!.getReader();
          entered = Promise.withResolvers<void>();
          held.push(
            reader.read().catch(() => undefined).finally(() =>
              reader.releaseLock()
            ),
          );
          await entered.promise;
          http.acknowledge(tickets[index].token, identity);
        }
        entered = Promise.withResolvers<void>();
        third = http.handle(request(tickets[2]));
        const admission = await Promise.race([
          third.then((response) => response.status),
          entered.promise.then(() => "authorization entered"),
        ]);
        expect(admission).toBe(429);
      } finally {
        release.resolve();
        await Promise.all(held);
        if (third) await (await third).body?.cancel();
        await http.close();
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

async function withPins(
  run: (fixture: {
    store: ArchiveStore;
    http: ArchiveHttp;
    archive: string;
    counts: () => unknown;
    issue: (owner?: ArchiveIdentity) => Promise<{
      ticket: ArchiveTicket;
      pin: { archive: string; pin: string; sequence: number };
    }>;
    adopt: (
      owner?: ArchiveIdentity,
    ) => Promise<{ archive: string; pin: string; sequence: number }>;
    authorize: (check: () => Promise<void>) => void;
    protected: (expected: boolean) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "archive-pin-owner-" });
  try {
    using store = await ArchiveStore.open({ root });
    const policy = { writerPolicy: "test", cfcPolicy: "{}" };
    const archive = store.openBinding(identity, "catalog", policy).id;
    const allow = () => Promise.resolve();
    await store.execute(
      { op: "begin", archive, generation: "b0", base: null },
      identity,
      allow,
    );
    await store.execute(
      { op: "publish", archive, generation: "b0" },
      identity,
      allow,
    );
    let authorize = allow;
    const http = new ArchiveHttp(store, async () => {
      await authorize();
      return policy;
    }, []);
    const database = new Database(`${root}/catalog.sqlite`, { readonly: true });
    const sequences = new Map<string, number>();
    const issue = async (owner = identity) => {
      const key = JSON.stringify(owner);
      const sequence = (sequences.get(key) ?? 0) + 1;
      sequences.set(key, sequence);
      const pin = { archive, pin: crypto.randomUUID(), sequence };
      const ticket = await http.issue(
        { op: "pin", archive, generation: "b0", pin: pin.pin },
        owner,
        sequence,
      );
      return { ticket, pin };
    };
    const adopt = async (owner = identity) => {
      const { ticket, pin } = await issue(owner);
      const response = await http.handle(request(ticket));
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.length).toBe(Number(response.headers.get("content-length")));
      expect(archiveResponseHash(bytes)).toBe(
        response.headers.get("x-archive-content-sha256"),
      );
      expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
        pin: pin.pin,
        generation: "b0",
      });
      await http.acknowledge(ticket.token, owner, true, pin);
      return pin;
    };
    try {
      await run({
        store,
        http,
        archive,
        issue,
        adopt,
        counts: () =>
          database.prepare(
            "SELECT (SELECT count(*) FROM pins) AS pins, (SELECT count(*) FROM tickets) AS tickets, (SELECT count(*) FROM pin_requests) AS requests",
          ).get(),
        authorize: (check) => {
          authorize = check;
        },
        protected: async (expected) => {
          if (store.binding(archive).generation === "b0") {
            await store.execute(
              { op: "begin", archive, generation: "b1", base: "b0" },
              identity,
              allow,
            );
            await store.execute(
              { op: "publish", archive, generation: "b1" },
              identity,
              allow,
            );
          }
          await store.execute(
            { op: "prune", archive, generation: "b1" },
            identity,
            allow,
          );
          expect(
            database.prepare(
              "SELECT count(*) AS count FROM generations WHERE id='b0'",
            ).get(),
          ).toEqual({ count: expected ? 1 : 0 });
        },
      });
    } finally {
      await http.close();
      database.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

describe("archive pin ownership", () => {
  for (const wrapped of [false, true]) {
    for (const adoptedFirst of [false, true]) {
      for (
        const ending of [
          "EOF",
          "HTTP cancellation",
          "failure ACK",
          "release",
          "detach",
        ] as const
      ) {
        if (!wrapped && ending !== "EOF") continue;
        it(`settles ${ending} ${adoptedFirst ? "after" : "before"} adoption through ${wrapped ? "a transform" : "a direct body"}`, () =>
          withPins(async (f) => {
            const eofEntered = Promise.withResolvers<void>();
            const releaseEof = Promise.withResolvers<void>();
            const pullReleased = Promise.withResolvers<void>();
            const cancellationObserved = Promise.withResolvers<void>();
            const pipelineAbort = new AbortController();
            const flushed = Promise.withResolvers<void>();
            let reading = false;
            let responseChecks = 0;
            let adoptionChecks = 0;
            let adoptions = 0;
            let eofResumed = false;
            let canceling = false;
            let requestAborted = false;
            let transmission: Promise<"fulfilled" | "rejected"> | undefined;
            const adopt = f.store.adoptPin.bind(f.store);
            const releasePin = f.store.releasePin.bind(f.store);
            f.store.adoptPin = (...args) => {
              adoptions++;
              adopt(...args);
            };
            f.store.releasePin = (...args) => {
              releasePin(...args);
              if (eofResumed) pullReleased.resolve();
              else if (canceling) cancellationObserved.resolve();
            };
            const server = Deno.serve({
              hostname: "127.0.0.1",
              port: 0,
              onListen() {},
            }, async (request, info) => {
              request.signal.addEventListener("abort", () => {
                requestAborted = true;
              }, { once: true });
              transmission = info.completed.then(
                () => "fulfilled" as const,
                () => "rejected" as const,
              );
              const response = await f.http.handle(request);
              reading = true;
              f.authorize(async () => {
                if (reading) {
                  if (++responseChecks === 2) {
                    eofEntered.resolve();
                    await releaseEof.promise;
                    eofResumed = true;
                  }
                } else adoptionChecks++;
              });
              if (!wrapped) return response;
              const bytes = Number(response.headers.get("content-length"));
              let consumed = 0;
              const body = response.body!.pipeThrough(
                new TransformStream<Uint8Array, Uint8Array>({
                  transform(chunk, controller) {
                    consumed += chunk.byteLength;
                    if (consumed > ARCHIVE_LIMITS.controlBytes) {
                      throw new Error(
                        "Archive response exceeded its byte ceiling",
                      );
                    }
                    controller.enqueue(chunk);
                  },
                  flush() {
                    if (consumed !== bytes) {
                      throw new Error(
                        "Archive response length did not match its header",
                      );
                    }
                    flushed.resolve();
                  },
                }),
                { signal: pipelineAbort.signal },
              );
              return new Response(body, response);
            });
            const client = Deno.createHttpClient({});
            try {
              const { ticket, pin } = await f.issue();
              const options = {
                method: "POST",
                headers: {
                  authorization: `Bearer ${ticket.token}`,
                  "content-type": "application/octet-stream",
                },
                body: new Uint8Array(0),
                client,
              };
              const response = await fetch(
                `http://127.0.0.1:${server.addr.port}/transfer`,
                options,
              );
              expect(response.status).toBe(200);
              const bytes = new Uint8Array(
                Number(response.headers.get("content-length")),
              );
              const reader = response.body!.getReader();
              let received = 0;
              let finalDataDone: boolean | undefined;
              try {
                while (true) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  finalDataDone = chunk.done;
                  bytes.set(chunk.value, received);
                  received += chunk.value.length;
                }
              } finally {
                reader.releaseLock();
              }
              expect(finalDataDone).toBe(false);
              expect(received).toBe(bytes.length);
              expect(archiveResponseHash(bytes)).toBe(
                response.headers.get("x-archive-content-sha256"),
              );
              expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
                pin: pin.pin,
                generation: "b0",
              });
              await eofEntered.promise;
              reading = false;
              expect(
                f.store.pinState(f.archive, pin.pin, identity, pin.sequence),
              )
                .toBe("provisional");
              expect(f.counts()).toEqual({ pins: 1, tickets: 0, requests: 1 });
              expect(f.http.activeTransferCount).toBe(1);
              await f.protected(true);
              const acknowledge = () =>
                f.http.acknowledge(ticket.token, identity, true, pin);
              const assertAdopted = async () => {
                expect(
                  f.store.pinState(f.archive, pin.pin, identity, pin.sequence),
                )
                  .toBe("adopted");
                expect(f.counts()).toEqual({
                  pins: 1,
                  tickets: 0,
                  requests: 1,
                });
                expect(adoptionChecks).toBe(1);
                expect(adoptions).toBe(1);
                await acknowledge();
                expect(adoptions).toBe(1);
                await f.protected(true);
              };
              if (adoptedFirst) {
                await acknowledge();
                await assertAdopted();
                expect(f.http.activeTransferCount).toBe(1);
              }
              if (ending === "EOF") {
                releaseEof.resolve();
                if (wrapped) await flushed.promise;
                expect(await transmission).toBe("fulfilled");
                // Deno's legacy request signal aborts on successful transmission.
                expect(requestAborted).toBe(true);
                expect(responseChecks).toBe(2);
                if (!adoptedFirst) {
                  expect(
                    f.store.pinState(
                      f.archive,
                      pin.pin,
                      identity,
                      pin.sequence,
                    ),
                  )
                    .toBe("provisional");
                  expect(f.http.activeTransferCount).toBe(1);
                  await acknowledge();
                }
                await assertAdopted();
              } else {
                if (ending === "HTTP cancellation") {
                  canceling = true;
                  pipelineAbort.abort(new Error("HTTP response canceled"));
                  await cancellationObserved.promise;
                } else if (ending === "failure ACK") {
                  await f.http.acknowledge(undefined, identity, false, pin);
                } else if (ending === "release") {
                  await f.http.acknowledge(
                    undefined,
                    identity,
                    false,
                    pin,
                    true,
                  );
                } else {
                  f.http.detachSession(
                    identity.space,
                    identity.sessionId,
                    identity.connectionId,
                  );
                }
                const retained = adoptedFirst &&
                  (ending === "HTTP cancellation" || ending === "failure ACK");
                expect(
                  f.store.pinState(f.archive, pin.pin, identity, pin.sequence),
                )
                  .toBe(retained ? "adopted" : "released");
                expect(f.counts()).toEqual({
                  pins: retained ? 1 : 0,
                  tickets: 0,
                  requests: ending === "detach" ? 0 : 1,
                });
                expect(f.http.activeTransferCount).toBe(1);
                await f.protected(retained);
                if (retained) await acknowledge();
                else {await expect(acknowledge()).rejects.toThrow(
                    "unavailable for adoption",
                  );}
                expect(adoptions).toBe(adoptedFirst ? 1 : 0);
                releaseEof.resolve();
                await pullReleased.promise;
                await transmission;
              }
              expect(f.http.activeTransferCount).toBe(0);
              f.http.detachSession(
                identity.space,
                identity.sessionId,
                identity.connectionId,
              );
              expect(f.counts()).toEqual({ pins: 0, tickets: 0, requests: 0 });
              await f.protected(false);
            } finally {
              reading = false;
              releaseEof.resolve();
              client.close();
              await server.shutdown();
              await transmission;
              f.store.adoptPin = adopt;
              f.store.releasePin = releasePin;
            }
          }));
      }
    }
  }

  for (
    const failure of [
      "unread response",
      "first pull",
      "partial consumption",
      "failed verification",
    ] as const
  ) {
    it(`releases only its provisional pin after ${failure} and permits further acquisitions`, () =>
      withPins(async (f) => {
        const retained = await f.adopt();
        await f.protected(true);
        for (let index = 0; index <= ARCHIVE_LIMITS.principalPins; index++) {
          const { ticket, pin } = await f.issue();
          expect(f.store.pinState(f.archive, pin.pin, identity)).toBe(
            "pending",
          );
          expect(f.counts()).toEqual({ pins: 2, tickets: 1, requests: 1 });
          const response = await f.http.handle(request(ticket));
          expect(response.status).toBe(200);
          expect(response.bodyUsed).toBe(false);
          expect(f.store.pinState(f.archive, pin.pin, identity)).toBe(
            "provisional",
          );
          expect(f.counts()).toEqual({ pins: 2, tickets: 0, requests: 1 });
          if (failure === "unread response") await response.body!.cancel();
          else if (failure === "first pull") {
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const error = new Error("first response authorization failed");
            f.authorize(async () => {
              entered.resolve();
              await release.promise;
              throw error;
            });
            const reader = response.body!.getReader();
            const rejected = expect(reader.read()).rejects.toBe(error);
            try {
              await entered.promise;
              expect(f.http.activeTransferCount).toBe(1);
              expect(f.counts()).toEqual({ pins: 2, tickets: 0, requests: 1 });
            } finally {
              release.resolve();
              await rejected;
              reader.releaseLock();
              f.authorize(() => Promise.resolve());
            }
          } else if (failure === "partial consumption") {
            const reader = response.body!.getReader();
            const first = await reader.read();
            expect(first.done).toBe(false);
            await reader.cancel();
            reader.releaseLock();
          } else await response.arrayBuffer();
          await f.http.acknowledge(ticket.token, identity, false, pin);
          expect(f.store.pinState(f.archive, pin.pin, identity)).toBe(
            "released",
          );
          expect(f.store.pinState(f.archive, retained.pin, identity)).toBe(
            "adopted",
          );
          expect(f.http.activeTransferCount).toBe(0);
          expect(f.counts()).toEqual({ pins: 1, tickets: 0, requests: 1 });
          await f.protected(true);
        }
        await f.http.acknowledge(undefined, identity, false, retained, true);
        expect(f.counts()).toEqual({ pins: 0, tickets: 0, requests: 1 });
        await f.protected(false);
      }));
  }

  it("makes duplicate and conflicting acknowledgements terminal without reviving released pins", () =>
    withPins(async (f) => {
      const { ticket, pin } = await f.issue();
      const response = await f.http.handle(request(ticket));
      await response.arrayBuffer();
      await f.http.acknowledge(ticket.token, identity, true, pin);
      await f.http.acknowledge(ticket.token, identity, true, pin);
      await f.http.acknowledge(ticket.token, identity, false, pin);
      expect(f.store.pinState(f.archive, pin.pin, identity)).toBe("adopted");
      expect(f.counts()).toEqual({ pins: 1, tickets: 0, requests: 1 });
      await f.protected(true);
      await f.http.acknowledge(undefined, identity, false, pin, true);
      await f.http.acknowledge(undefined, identity, false, pin, true);
      await f.http.acknowledge(ticket.token, identity, false, pin);
      await expect(f.http.acknowledge(ticket.token, identity, true, pin))
        .rejects.toThrow("unavailable for adoption");
      expect(f.counts()).toEqual({ pins: 0, tickets: 0, requests: 1 });
      expect(f.http.activeTransferCount).toBe(0);
      await f.protected(false);
    }));

  it("refuses overlapping requests in one session and preserves other sessions with the same principal", async () => {
    for (const firstDetached of ["pending", "adopted"]) {
      await withPins(async (f) => {
        const other = { ...identity, sessionId: "session:other" };
        const first = await f.issue();
        const response = await f.http.handle(request(first.ticket));
        await expect(f.issue()).rejects.toThrow("provisional pin request");
        const second = await f.adopt(other);
        expect(f.counts()).toEqual({ pins: 2, tickets: 0, requests: 2 });
        expect(f.http.activeTransferCount).toBe(1);
        const count = await f.http.issue({
          op: "count",
          archive: f.archive,
          generation: "b0",
          pin: second.pin,
        }, other);
        const counted = await f.http.handle(request(count));
        expect(await counted.json()).toEqual({ count: 0 });
        await f.http.acknowledge(count.token, other, true);
        await f.protected(true);
        f.http.detach(firstDetached === "pending" ? identity : other);
        expect(f.counts()).toEqual({ pins: 1, tickets: 0, requests: 1 });
        await f.protected(true);
        f.http.detach(firstDetached === "pending" ? other : identity);
        expect(f.counts()).toEqual({ pins: 0, tickets: 0, requests: 0 });
        expect(f.http.activeTransferCount).toBe(0);
        await response.body!.cancel().catch(() => {});
        await f.protected(false);
      });
    }
  });

  it("rechecks authorization at adoption and keeps cleanup scoped to the exact identity", () =>
    withPins(async (f) => {
      const retained = await f.adopt();
      const next = await f.issue();
      const response = await f.http.handle(request(next.ticket));
      await response.arrayBuffer();
      await expect(
        f.http.acknowledge(
          next.ticket.token,
          { ...identity, sessionId: "other" },
          true,
          next.pin,
        ),
      ).rejects.toThrow("different session");
      await f.http.acknowledge(
        undefined,
        { ...identity, sessionId: "other" },
        false,
        retained,
        true,
      );
      expect(f.counts()).toEqual({ pins: 2, tickets: 0, requests: 2 });
      f.authorize(() =>
        Promise.reject(new Error("policy revoked before adoption"))
      );
      await expect(
        f.http.acknowledge(next.ticket.token, identity, true, next.pin),
      ).rejects.toThrow("policy revoked");
      f.authorize(() => Promise.resolve());
      expect(f.store.pinState(f.archive, retained.pin, identity)).toBe(
        "adopted",
      );
      expect(f.store.pinState(f.archive, next.pin.pin, identity)).toBe(
        "released",
      );
      expect(f.counts()).toEqual({ pins: 1, tickets: 0, requests: 2 });
    }));

  for (
    const state of [
      "new",
      "pending",
      "provisional",
      "consumed",
      "adopted",
    ] as const
  ) {
    it(`clears reader state on transport close from ${state}`, () =>
      withPins(async (f) => {
        if (state !== "new") {
          const { ticket, pin } = await f.issue();
          expect(f.counts()).toEqual({ pins: 1, tickets: 1, requests: 1 });
          await f.protected(true);
          if (state !== "pending") {
            const response = await f.http.handle(request(ticket));
            if (state === "consumed" || state === "adopted") {
              await response.arrayBuffer();
            }
            if (state === "adopted") {
              await f.http.acknowledge(ticket.token, identity, true, pin);
            }
          }
        }
        await f.http.close();
        expect(f.http.activeTransferCount).toBe(0);
        expect(f.counts()).toEqual({ pins: 0, tickets: 0, requests: 0 });
        await f.protected(false);
      }));
  }

  it("waits for a gated admission to unwind before close and prevents pin creation after detach", () =>
    withPins(async (f) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      f.authorize(async () => {
        entered.resolve();
        await release.promise;
      });
      const issuance = f.issue();
      const rejected = expect(issuance).rejects.toThrow("closed");
      await entered.promise;
      const closing = f.http.close();
      expect(f.counts()).toEqual({ pins: 0, tickets: 0, requests: 0 });
      release.resolve();
      await rejected;
      await closing;
      expect(f.counts()).toEqual({ pins: 0, tickets: 0, requests: 0 });
    }));
  it("releases an admitted request rejected before a transfer is installed", () =>
    withPins(async (f) => {
      const { ticket, pin } = await f.issue();
      const invalid = request(ticket);
      invalid.headers.set("content-length", "1");
      const response = await f.http.handle(invalid);
      expect(response.status).toBe(400);
      await response.text();
      expect(f.http.activeTransferCount).toBe(0);
      expect(f.store.pinState(f.archive, pin.pin, identity, pin.sequence)).toBe(
        "released",
      );
      expect(f.counts()).toEqual({ pins: 0, tickets: 0, requests: 1 });
      const recovered = await f.adopt();
      expect(
        f.store.pinState(
          f.archive,
          recovered.pin,
          identity,
          recovered.sequence,
        ),
      ).toBe("adopted");
    }));

  it("isolates delayed execution and acknowledgements from a later reuse of the owner ID", () =>
    withPins(async (f) => {
      const first = await f.issue();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const execute = f.store.execute.bind(f.store);
      let delayed = true;
      f.store.execute = async (
        ...args: Parameters<ArchiveStore["execute"]>
      ) => {
        if (args[0].op === "pin" && delayed) {
          delayed = false;
          entered.resolve();
          await release.promise;
        }
        return execute(...args);
      };
      const old = f.http.handle(request(first.ticket));
      try {
        await entered.promise;
        await f.http.acknowledge(undefined, identity, false, first.pin);
        const nextPin = { ...first.pin, sequence: first.pin.sequence + 1 };
        const ticket = await f.http.issue(
          { op: "pin", archive: f.archive, generation: "b0", pin: nextPin.pin },
          identity,
          nextPin.sequence,
        );
        expect(
          f.store.pinState(f.archive, nextPin.pin, identity, nextPin.sequence),
        ).toBe("pending");
        release.resolve();
        const rejected = await old;
        expect(rejected.status).toBe(403);
        await rejected.text();
        await f.http.acknowledge(
          first.ticket.token,
          identity,
          false,
          first.pin,
        );
        await f.http.acknowledge(undefined, identity, false, first.pin, true);
        await expect(
          f.http.acknowledge(
            undefined,
            identity,
            false,
            {
              archive: first.pin.archive,
              pin: first.pin.pin,
            } as typeof first.pin,
            true,
          ),
        ).rejects.toThrow("exact request sequence");
        for (const op of ["release", "pin-status"] as const) {
          await expect(
            f.http.issue(
              { op, archive: f.archive, pin: first.pin.pin },
              identity,
            ),
          ).rejects.toThrow("exact request sequence");
        }
        await expect(
          f.http.acknowledge(first.ticket.token, identity, true, first.pin),
        ).rejects.toThrow();
        expect(
          f.store.pinState(f.archive, nextPin.pin, identity, nextPin.sequence),
        ).toBe("pending");
        expect(
          f.store.pinState(
            f.archive,
            first.pin.pin,
            identity,
            first.pin.sequence,
          ),
        ).toBe("released");
        expect(f.counts()).toEqual({ pins: 1, tickets: 1, requests: 1 });
        const response = await f.http.handle(request(ticket));
        expect(response.status).toBe(200);
        await response.arrayBuffer();
        await f.http.acknowledge(ticket.token, identity, true, nextPin);
        await f.http.acknowledge(undefined, identity, false, first.pin, true);
        expect(
          f.store.pinState(f.archive, nextPin.pin, identity, nextPin.sequence),
        ).toBe("adopted");
        expect(f.counts()).toEqual({ pins: 1, tickets: 0, requests: 1 });
        await f.protected(true);
      } finally {
        release.resolve();
        await old;
        f.store.execute = execute;
      }
    }));

  it("bounds high-water rows independently of live pins and releases the bound only at detach", () =>
    withPins(async (f) => {
      const owners: ArchiveIdentity[] = [];
      for (
        let index = 0;
        index < ARCHIVE_LIMITS.principalPinSessions;
        index++
      ) {
        const owner = { ...identity, sessionId: `session:${index}` };
        owners.push(owner);
        const request = await f.issue(owner);
        await f.http.acknowledge(undefined, owner, false, request.pin);
      }
      expect(f.counts()).toEqual({
        pins: 0,
        tickets: 0,
        requests: ARCHIVE_LIMITS.principalPinSessions,
      });
      const extra = { ...identity, sessionId: "session:extra" };
      await expect(f.issue(extra)).rejects.toThrow("pin session state limit");
      expect(f.counts()).toEqual({
        pins: 0,
        tickets: 0,
        requests: ARCHIVE_LIMITS.principalPinSessions,
      });
      f.http.detach(owners[0]);
      await f.adopt(extra);
      expect(f.counts()).toEqual({
        pins: 1,
        tickets: 0,
        requests: ARCHIVE_LIMITS.principalPinSessions,
      });
    }));

  it("does not recreate detached ownership when a canceled response pull unwinds", () =>
    withPins(async (f) => {
      const { ticket } = await f.issue();
      const response = await f.http.handle(request(ticket));
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      f.authorize(async () => {
        entered.resolve();
        await release.promise;
      });
      const reader = response.body!.getReader();
      const rejected = expect(reader.read()).rejects.toThrow("closed");
      const unwound = Promise.withResolvers<void>();
      const releasePin = f.store.releasePin.bind(f.store);
      let detached = false;
      f.store.releasePin = (...args) => {
        releasePin(...args);
        if (detached) unwound.resolve();
      };
      try {
        await entered.promise;
        f.http.detach(identity);
        detached = true;
        expect(f.counts()).toEqual({ pins: 0, tickets: 0, requests: 0 });
        release.resolve();
        await rejected;
        await unwound.promise;
        expect(f.http.activeTransferCount).toBe(0);
        expect(f.counts()).toEqual({ pins: 0, tickets: 0, requests: 0 });
      } finally {
        release.resolve();
        reader.releaseLock();
        f.store.releasePin = releasePin;
      }
    }));
});

describe("counted archive response verification", () => {
  for (const ending of ["done", "extra", "early"] as const) {
    it(`client counted body requires EOF and rejects invalid length: ${ending}`, async () => {
      const eofEntered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let first = true;
      let finished = false;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (first) {
            first = false;
            controller.enqueue(
              new Uint8Array(ending === "early" ? [1] : [1, 2]),
            );
          } else {
            eofEntered.resolve();
            await resume.promise;
            if (ending === "extra") controller.enqueue(new Uint8Array([3]));
            controller.close();
          }
        },
      }, { highWaterMark: 0 });
      const result = readArchiveBody(stream, 2, () => {}).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      ).finally(() => {
        finished = true;
      });
      await eofEntered.promise;
      expect(finished).toBe(false);
      resume.resolve();
      const value = await result;
      expect(value.ok).toBe(ending === "done");
      if (!value.ok && "error" in value) {
        expect(value.error.message).toMatch(/declared length/);
      }
    });
  }
});
