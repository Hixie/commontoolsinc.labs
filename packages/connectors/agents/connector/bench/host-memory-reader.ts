/** Independently reads the authenticated archive without retaining its history. */

import { encodeHex } from "@std/encoding/hex";
import { TextLineStream } from "@std/streams/text-line-stream";

import { createHasher } from "@commonfabric/content-hash";
import {
  type ArchiveCommand,
  ArchivePinOwner,
  type ArchiveResult,
} from "@commonfabric/memory/v2/archive";
import { openAgentFabricRuntime } from "../../host/src/fabric-runtime.ts";
import type {
  AgentArchiveCatalog,
  AgentArchivePageMetadata,
  ArchivedSession,
} from "../src/archive.ts";
import { sessionKey } from "../src/session-contract.ts";
import {
  commands,
  config,
  log,
  reply,
  role,
  settled,
} from "./host-memory-common.ts";

const fabric = await openAgentFabricRuntime({
  apiUrl: config.apiUrl!,
  identityPath: config.identityPath,
  ownerDid: config.ownerDid,
  space: config.spaceDid!,
  deferStorageClaim: true,
});
const provider = fabric.runtime.storageManager.open(fabric.spaceDid);
async function control(command: ArchiveCommand): Promise<ArchiveResult> {
  const result = await provider.archive!(command);
  if (result instanceof Uint8Array) {
    throw new Error("Expected bounded archive metadata");
  }
  return result;
}
await reply("ready", { pid: Deno.pid });
await commands(async (command) => {
  if (command.op === "read") {
    using verified = await Deno.open(
      `${config.directory}/${role}-verified.jsonl`,
      { createNew: true, write: true, mode: 0o600 },
    );
    const recordVerification = async (value: unknown) => {
      const row = new TextEncoder().encode(JSON.stringify(value) + "\n");
      for (let offset = 0; offset < row.length;) {
        offset += await verified.write(row.subarray(offset));
      }
    };
    await fabric.target.cells.catalog.sync();
    const catalog = fabric.target.cells.catalog.get() as AgentArchiveCatalog;
    const scope = { archive: catalog.archive, generation: catalog.generation };
    const owner = new ArchivePinOwner(scope, control);
    const pin = owner.pin;
    let records = 0;
    let nativeBytes = 0;
    let transferredBytes = 0;
    let pages = 0;
    try {
      await owner.acquire();
      const expected = await Deno.open(`${config.directory}/expected.jsonl`, {
        read: true,
      });
      for await (
        const line of expected.readable.pipeThrough(new TextDecoderStream())
          .pipeThrough(new TextLineStream())
      ) {
        const fixture = JSON.parse(line) as {
          source: string;
          id: string;
          path: string;
          hash: string;
          bytes: number;
        };
        const key = sessionKey(fixture.source, fixture.id);
        let file: Deno.FsFile;
        try {
          file = await Deno.open(fixture.path, { read: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
          const missing = await control({ op: "get", ...scope, pin, key });
          if (missing.records?.length === 0) {
            await recordVerification({
              source: fixture.source,
              id: fixture.id,
              deleted: true,
            });
            continue;
          }
          throw new Error(
            "Deleted native session remains in a complete catalog",
          );
        }
        using native = file;
        const record = (await control({ op: "get", ...scope, pin, key }))
          .records?.[0];
        if (!record || record.partial) {
          throw new Error("Complete native record is absent");
        }
        const metadata = JSON.parse(record.metadata) as ArchivedSession;
        const size = (await native.stat()).size;
        if (
          metadata.nativeBytes !== size ||
          metadata.summary.nativeSessionId !== fixture.id
        ) {
          throw new Error(
            "Archived native metadata does not match the fixture",
          );
        }
        const appendBytes = new TextEncoder().encode(
          '{"type":"user","uuid":"appended","message":{"content":"Appended native record"}}\n',
        ).length;
        if (
          metadata.eventCount !== 1 + (size - fixture.bytes) / appendBytes ||
          metadata.messageCount !== metadata.eventCount
        ) throw new Error("Native event or message counts differ");
        const last = (await control({
          op: "pages",
          ...scope,
          pin,
          key,
          after: (metadata.gitContext?.firstPage ?? metadata.pageCount) - 2,
          limit: 1,
        })).pages!.at(-1)!;
        const extent = JSON.parse(last.metadata) as Extract<
          AgentArchivePageMetadata,
          { kind: "native-end" }
        >;
        if (extent.kind !== "native-end" || extent.bytes !== size) {
          throw new Error("Native extent is incomplete");
        }
        records++;
        nativeBytes += size;
        const fullReadback = records <= 2 || size > config.pageBytes;
        if (fullReadback) {
          const actual = createHasher();
          const expectedHash = createHasher();
          const buffer = new Uint8Array(65536);
          for (let count; (count = await native.read(buffer)) !== null;) {
            expectedHash.update(buffer.subarray(0, count));
          }
          let after: number | undefined;
          while (true) {
            const batch =
              (await control({ op: "pages", ...scope, pin, key, after }))
                .pages!;
            if (!batch.length) break;
            for (const page of batch) {
              after = page.index;
              const description = JSON.parse(
                page.metadata,
              ) as AgentArchivePageMetadata;
              if (description.kind !== "native") continue;
              const bytes = await provider.archive!({
                op: "read",
                ...scope,
                pin,
                key,
                index: page.index,
                hash: page.hash,
              });
              if (
                !(bytes instanceof Uint8Array) || bytes.length !== page.bytes
              ) throw new Error("Native response is malformed");
              actual.update(bytes);
              transferredBytes += bytes.length;
              if (++pages % 1024 === 0) {
                log.write("native-page", { records, pages, transferredBytes });
              }
            }
          }
          const expectedDigest = encodeHex(expectedHash.digest());
          if (
            encodeHex(actual.digest()) !== expectedDigest ||
            extent.hash !== expectedDigest
          ) throw new Error("Native readback differs from the original file");
        } else if (extent.hash !== fixture.hash) {
          throw new Error("Archived native digest differs from the fixture");
        }
        await recordVerification({
          source: fixture.source,
          id: fixture.id,
          bytes: size,
          hash: extent.hash,
          events: metadata.eventCount,
          messages: metadata.messageCount,
          fullReadback,
        });
      }
      if (records !== catalog.sessionCount) {
        throw new Error("Catalog count differs from the native files");
      }
      return settled("readback", {
        records,
        nativeBytes,
        transferredBytes,
        pages,
        generation: catalog.generation,
      });
    } finally {
      await owner.close();
    }
  }
  if (command.op === "stop") {
    await fabric.runtime.dispose();
    return settled("closed");
  }
  throw new Error("Unknown reader profile command");
});
