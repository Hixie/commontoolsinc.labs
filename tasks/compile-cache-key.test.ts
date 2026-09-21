import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { currentCompilerFingerprint } from "./compile-cache-key.ts";
import {
  computeCurrentCompilerVersion,
  VERSION_NAMESPACE,
} from "../packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts";

describe("compile-cache-key", () => {
  it("returns the fingerprint the runtime's version axis carries", async () => {
    // CI names a compile byte cache entry by this value, and the runtime reads
    // compiled documents back under `compileCache:<version>/<identity>` with
    // the same fingerprint inside `<version>`. Were the two to part, a restored
    // entry would be one the runtime never looks for, and the cache would
    // silently stop doing anything.

    expect(await computeCurrentCompilerVersion()).toBe(
      `${VERSION_NAMESPACE}/${await currentCompilerFingerprint()}`,
    );
  });

  it("returns a value every character of which is safe in a cache key", async () => {
    // The workflow interpolates it into a key with no quoting or escaping
    // around it.

    expect(await currentCompilerFingerprint()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
