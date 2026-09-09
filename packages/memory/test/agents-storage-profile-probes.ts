/** Stage-based memory probes for the isolated agent storage review harness. */
// deno-lint-ignore no-external-import
import { Buffer } from "node:buffer";
// deno-lint-ignore no-external-import
import process from "node:process";
// deno-lint-ignore no-external-import
import v8 from "node:v8";

const native = Deno.build.os === "darwin"
  ? Deno.dlopen(
    "/usr/lib/libSystem.B.dylib",
    {
      malloc_zone_statistics: {
        parameters: ["pointer", "buffer"],
        result: "void",
      },
      malloc_zone_pressure_relief: {
        parameters: ["pointer", "usize"],
        result: "usize",
      },
    } as const,
  )
  : undefined;
const nativeStatistics = new Uint8Array(32);
const nativeView = new DataView(nativeStatistics.buffer);

export function nativeMemorySnapshot() {
  if (!native) return undefined;
  native.symbols.malloc_zone_statistics(null, nativeStatistics);
  return {
    blocksInUse: nativeView.getUint32(0, true),
    bytesInUse: Number(nativeView.getBigUint64(8, true)),
    maximumTouchedBytes: Number(nativeView.getBigUint64(16, true)),
    reservedBytes: Number(nativeView.getBigUint64(24, true)),
  };
}

export function releaseNativeAllocator(): number | undefined {
  return native
    ? Number(native.symbols.malloc_zone_pressure_relief(null, 0n))
    : undefined;
}

export const utf8Bytes = (value: string): number => Buffer.byteLength(value);

/** Counts logical string and buffer contents without serializing the value. */
export function contentsSize(value: unknown): { utf8: number; utf16: number } {
  const seen = new WeakSet<object>();
  let utf8 = 0;
  let utf16 = 0;
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      utf8 += utf8Bytes(value);
      utf16 += value.length * 2;
    } else if (
      typeof value === "object" && value !== null && !seen.has(value)
    ) {
      seen.add(value);
      if (ArrayBuffer.isView(value)) {
        utf8 += value.byteLength;
        utf16 += value.byteLength;
      } else if (value instanceof Map) {
        for (const [key, entry] of value) {
          visit(key);
          visit(entry);
        }
      } else if (value instanceof Set) {
        for (const entry of value) visit(entry);
      } else {
        for (const [key, entry] of Object.entries(value)) {
          visit(key);
          visit(entry);
        }
      }
    }
  };
  visit(value);
  return { utf8, utf16 };
}

/** ArrayBuffer accounting is unavailable when Deno's Node counter stays zero. */
export function memorySnapshot() {
  const node = process.memoryUsage();
  return {
    ...Deno.memoryUsage(),
    nodeArrayBuffers: node.arrayBuffers,
    arrayBufferCounterAvailable: node.arrayBuffers !== 0,
    v8: v8.getHeapStatistics(),
    malloc: nativeMemorySnapshot(),
  };
}

export function collectGarbage(): void {
  const gc = Reflect.get(globalThis, "gc");
  if (typeof gc !== "function") throw new Error("--expose-gc is required");
  gc();
}

export class ProfileLog {
  #file: Deno.FsFile;
  #encoder = new TextEncoder();
  #started = performance.now();

  constructor(path: string) {
    this.#file = Deno.openSync(path, { createNew: true, write: true });
  }

  write(stage: string, details: Record<string, unknown> = {}) {
    const row = {
      stage,
      at: Date.now(),
      processElapsedMs: performance.now(),
      elapsedMs: performance.now() - this.#started,
      pid: Deno.pid,
      memory: memorySnapshot(),
      ...details,
    };
    const encoded = this.#encoder.encode(JSON.stringify(row) + "\n");
    let offset = 0;
    while (offset < encoded.length) {
      offset += this.#file.writeSync(encoded.subarray(offset));
    }
    return row;
  }

  close(): void {
    this.#file.close();
  }
}

/** SQLite's counters read the same library loaded by @db/sqlite. */
export function sqliteMemoryProbe(libraryPath: string) {
  const library = Deno.dlopen(
    libraryPath,
    {
      sqlite3_status64: {
        parameters: ["i32", "buffer", "buffer", "i32"],
        result: "i32",
      },
      sqlite3_db_status: {
        parameters: ["pointer", "i32", "buffer", "buffer", "i32"],
        result: "i32",
      },
    } as const,
  );
  const current = new BigInt64Array(1);
  const high = new BigInt64Array(1);
  const dbCurrent = new Int32Array(1);
  const dbHigh = new Int32Array(1);
  let globalAllocatorCounterAvailable: boolean | undefined;
  return {
    snapshot(handle?: Deno.PointerValue) {
      const global = (op: number) => {
        const rc = library.symbols.sqlite3_status64(op, current, high, 0);
        if (rc !== 0) throw new Error(`sqlite3_status64 returned ${rc}`);
        return { current: Number(current[0]), high: Number(high[0]) };
      };
      const connection = (op: number) => {
        const rc = library.symbols.sqlite3_db_status(
          handle!,
          op,
          dbCurrent,
          dbHigh,
          0,
        );
        if (rc !== 0) throw new Error(`sqlite3_db_status returned ${rc}`);
        return dbCurrent[0];
      };
      const allocatorBytes = global(0);
      const pagerOverflowBytes = global(2);
      if (allocatorBytes.current !== 0) globalAllocatorCounterAvailable = true;
      else if (pagerOverflowBytes.current !== 0) {
        globalAllocatorCounterAvailable = false;
      }
      return {
        allocatorBytes,
        globalAllocatorCounterAvailable,
        pagerOverflowBytes,
        mallocCount: global(9),
        ...(handle
          ? {
            connection: {
              pagerBytes: connection(1),
              schemaBytes: connection(2),
              statementBytes: connection(3),
              cacheSpills: connection(12),
            },
          }
          : {}),
      };
    },
    close: () => library.close(),
  };
}
