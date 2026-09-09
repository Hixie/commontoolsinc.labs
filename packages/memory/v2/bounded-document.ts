/** Imperative legacy reads with a metadata-only storage preflight. */

import type { Database } from "@db/sqlite";
import type { Engine } from "./engine.ts";
import { applyPatchToDocument, emptyEntityDocument } from "./patch.ts";
import {
  decodeMemoryBoundary,
  decodeStoredDocumentPayload,
  decodeStoredPatchListPayload,
  encodeMemoryBoundary,
  type EntityDocument,
} from "../v2.ts";

/** Fixed replay and decoded-shape bounds for explicit legacy inspection. */
export const LEGACY_READ_LIMITS = {
  bytes: 16 * 1024,
  revisions: 64,
  depth: 32,
  nodes: 4096,
  scalar: 4096,
} as const;

/** A refusal contains no stored data or exception text from a value decoder. */
export class LegacyReadRefused extends Error {
  constructor() {
    super(
      "Legacy document exceeds the bounded inspection format; rebuild it from its native source.",
    );
  }
}

type Revision = {
  seq: number;
  op_index: number;
  op: "set" | "patch" | "delete";
  bytes: number | null;
};
const tags = new Set([
  "/hole",
  "/quote",
  "/object",
  "/Link@1",
  "/Undefined@1",
  "/SpecialNumber@1",
  "/BigInt@1",
  "/Hash@1",
  "/Bytes@1",
]);

/** Checks the wire tree before the Fabric codec expands tags and array holes. */
function guardWire(wire: string): void {
  if (
    !wire.startsWith("fvj1:") ||
    new TextEncoder().encode(wire).length > LEGACY_READ_LIMITS.bytes
  ) throw new LegacyReadRefused();
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of wire) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      if (++depth > LEGACY_READ_LIMITS.depth) throw new LegacyReadRefused();
    } else if (character === "}" || character === "]") depth--;
  }
  type Node = { value: unknown; mode: "decode" | "object" | "literal" };
  const pending: Node[] = [{
    value: JSON.parse(wire.slice(5)),
    mode: "decode",
  }];
  let remaining: number = LEGACY_READ_LIMITS.nodes;
  while (pending.length) {
    if (--remaining < 0) throw new LegacyReadRefused();
    const { value, mode } = pending.pop()!;
    if (typeof value === "string") {
      if (value.length > LEGACY_READ_LIMITS.scalar) {
        throw new LegacyReadRefused();
      }
    } else if (Array.isArray(value)) {
      if (value.length > remaining) throw new LegacyReadRefused();
      pending.push(
        ...value.map((value) => ({
          value,
          mode: mode === "literal" ? "literal" as const : "decode" as const,
        })),
      );
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      const tag = mode === "decode" && entries.length === 1 &&
          entries[0][0].startsWith("/")
        ? entries[0][0]
        : undefined;
      if (tag !== undefined && !tags.has(tag)) throw new LegacyReadRefused();
      for (const [key, child] of entries) {
        if (--remaining < 0 || key.length > LEGACY_READ_LIMITS.scalar) {
          throw new LegacyReadRefused();
        }
        if (tag === "/hole") {
          if (
            !Number.isSafeInteger(child) || (child as number) < 1 ||
            (child as number) > remaining
          ) throw new LegacyReadRefused();
          remaining -= child as number;
        }
        pending.push({
          value: child,
          mode: mode === "literal" || tag === "/quote"
            ? "literal"
            : tag === "/object"
            ? "object"
            : "decode",
        });
      }
    }
  }
}

function one<T>(
  database: Database,
  sql: string,
  parameters: Record<string, string | number>,
): T | undefined {
  const statement = database.prepare(sql);
  try {
    return statement.get(parameters) as T | undefined;
  } finally {
    statement.finalize();
  }
}

/**
 * Reads the current shared-scope document on the main branch. It does not follow
 * links, register watches, fill document caches, or read commit originals.
 */
export function readBoundedDocument(
  engine: Engine,
  id: string,
): EntityDocument | null {
  const database = engine.database;
  return database.transaction(() => {
    const address = { id, branch: "", scope_key: "space" };
    const target = one<Revision>(
      database,
      `SELECT r.seq, r.op_index, r.op, octet_length(r.data) AS bytes
      FROM head h JOIN revision r USING (branch, id, scope_key, seq, op_index)
      WHERE h.branch = :branch AND h.id = :id AND h.scope_key = :scope_key`,
      address,
    );
    if (!target || target.op === "delete") return null;
    const fence = { ...address, seq: target.seq, op_index: target.op_index };
    const base = target.op === "set" ? target : one<Revision>(
      database,
      `SELECT seq, op_index, op, octet_length(data) AS bytes
      FROM revision WHERE branch = :branch AND id = :id AND scope_key = :scope_key AND op IN ('set', 'delete')
      AND (seq < :seq OR (seq = :seq AND op_index <= :op_index)) ORDER BY seq DESC, op_index DESC LIMIT 1`,
      fence,
    );
    const snapshot = target.op === "patch"
      ? one<{ seq: number; bytes: number }>(
        database,
        `SELECT seq, octet_length(value) AS bytes FROM snapshot
      WHERE branch = :branch AND id = :id AND scope_key = :scope_key AND seq <= :seq ORDER BY seq DESC LIMIT 1`,
        { ...address, seq: target.seq },
      )
      : undefined;
    const useSnapshot = snapshot !== undefined &&
      (base === undefined || snapshot.seq >= base.seq);
    const baseSeq = useSnapshot ? snapshot!.seq : base?.seq ?? 0;
    const baseIndex = useSnapshot
      ? Number.MAX_SAFE_INTEGER
      : base?.op_index ?? -1;
    const baseBytes = useSnapshot
      ? snapshot!.bytes
      : base?.op === "set"
      ? base.bytes
      : 0;
    let remaining: number = LEGACY_READ_LIMITS.bytes;
    const charge = (bytes: number | null) => {
      if (
        bytes === null || !Number.isSafeInteger(bytes) || bytes < 0 ||
        bytes > remaining
      ) throw new LegacyReadRefused();
      remaining -= bytes;
    };
    charge(baseBytes ?? 0);
    const statement = database.prepare(
      `SELECT seq, op_index, op, octet_length(data) AS bytes FROM revision
      WHERE branch = :branch AND id = :id AND scope_key = :scope_key AND op = 'patch'
      AND (seq > :base_seq OR (seq = :base_seq AND op_index > :base_op_index))
      AND (seq < :seq OR (seq = :seq AND op_index <= :op_index))
      ORDER BY seq, op_index LIMIT :limit`,
    );
    let patches: Revision[];
    try {
      patches = target.op === "patch"
        ? statement.all({
          ...fence,
          base_seq: baseSeq,
          base_op_index: baseIndex,
          limit: LEGACY_READ_LIMITS.revisions + 1,
        }) as Revision[]
        : [];
    } finally {
      statement.finalize();
    }
    if (
      patches.length + (useSnapshot || base ? 1 : 0) >
        LEGACY_READ_LIMITS.revisions
    ) throw new LegacyReadRefused();
    for (const patch of patches) charge(patch.bytes);
    const payload = (revision: { seq: number; op_index: number }) => {
      const wire = one<{ data: string }>(
        database,
        `SELECT data FROM revision WHERE branch = :branch AND id = :id AND scope_key = :scope_key AND seq = :seq AND op_index = :op_index`,
        { ...address, seq: revision.seq, op_index: revision.op_index },
      )!.data;
      guardWire(wire);
      return wire;
    };
    try {
      let document = emptyEntityDocument();
      if (useSnapshot) {
        const wire = one<{ value: string }>(
          database,
          `SELECT value FROM snapshot WHERE branch = :branch AND id = :id AND scope_key = :scope_key AND seq = :seq`,
          { ...address, seq: snapshot!.seq },
        )!.value;
        guardWire(wire);
        document = decodeStoredDocumentPayload(decodeMemoryBoundary, wire);
      } else if (base?.op === "set") {
        document = decodeStoredDocumentPayload(
          decodeMemoryBoundary,
          payload(base),
        );
      }
      for (const patch of patches) {
        const operations = decodeStoredPatchListPayload(
          decodeMemoryBoundary,
          payload(patch),
        );
        for (const operation of operations) {
          for (
            const path of [
              operation.path,
              "from" in operation ? operation.from : "",
            ]
          ) {
            if (
              path.split("/").length > LEGACY_READ_LIMITS.depth ||
              path.split("/").some((part) =>
                /^[0-9]+$/.test(part) && Number(part) > LEGACY_READ_LIMITS.nodes
              )
            ) throw new LegacyReadRefused();
          }
          document = applyPatchToDocument(document, [operation]);
          guardWire(encodeMemoryBoundary(document));
        }
      }
      return document;
    } catch {
      throw new LegacyReadRefused();
    }
  }).deferred();
}
