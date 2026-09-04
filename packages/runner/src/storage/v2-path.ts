import type { FabricValue } from "@commonfabric/api";
import {
  FabricInstance,
  isWalkableObjectOrArray,
} from "@commonfabric/data-model";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";

export type ReadPathOptions = {
  allowArrayLength?: boolean;
};

export const isArrayIndexSegment = (segment: string): boolean =>
  isArrayIndexPropertyName(segment);

export const createPathContainer = (nextSegment: string): FabricValue =>
  isArrayIndexSegment(nextSegment) ? [] : {};

const hasOwnPathSegment = (
  value: Record<string, unknown> | unknown[],
  segment: string | number,
): boolean => Object.hasOwn(value, segment);

// Both descents below stop at a `FabricSpecialObject`, so a path into one
// reports absent / `undefined` -- the same answer `getAtPath` in `traverse.ts`
// gives for the same address, and the whole story for a leaf that no path
// addresses anything inside of.
//
// A `FabricInstance` is tested for ahead of the walk question so that it takes
// that answer too, rather than the refusal the question raises. These two are
// read helpers on the write path: `normalizeAndDiff` reads the current value
// at every slot it is about to write, so a write anywhere below a stored
// instance reaches them. Reporting the slot absent lets the write proceed to
// the storage layer, which refuses it with a `TypeMismatchError` naming the
// path and the class it found; refusing here would replace that in-band,
// typed error with an exception escaping `Cell.set()`.
//
// TODO(danfuzz): "absent" is an incomplete answer for an instance, whose codec
// contents are real and simply not addressable by a path segment yet. When
// that descent lands, this test goes and the contents speak for themselves.
const isKeyable = (value: unknown): boolean =>
  !(value instanceof FabricInstance) && isWalkableObjectOrArray(value);

export const hasValueAtPath = (
  root: FabricValue | undefined,
  path: readonly string[],
  options: ReadPathOptions = {},
): boolean => {
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (options.allowArrayLength === true && segment === "length") {
        current = current.length;
        continue;
      }
      if (!isArrayIndexSegment(segment)) {
        return false;
      }
      const index = Number(segment);
      if (!hasOwnPathSegment(current, index)) {
        return false;
      }
      current = current[index];
      continue;
    }
    if (!isKeyable(current)) {
      return false;
    }
    const record = current as Record<string, unknown>;
    if (!hasOwnPathSegment(record, segment)) {
      return false;
    }
    current = record[segment];
  }
  return true;
};

export const readValueAtPath = (
  root: FabricValue | undefined,
  path: readonly string[],
  options: ReadPathOptions = {},
): FabricValue | undefined => {
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (options.allowArrayLength === true && segment === "length") {
        current = current.length;
        continue;
      }
      if (!isArrayIndexSegment(segment)) {
        return undefined;
      }
      const index = Number(segment);
      if (!hasOwnPathSegment(current, index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isKeyable(current)) {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    if (!hasOwnPathSegment(record, segment)) {
      return undefined;
    }
    current = record[segment];
  }
  return current as FabricValue | undefined;
};
