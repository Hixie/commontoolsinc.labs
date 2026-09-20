#!/usr/bin/env -S deno run --allow-read
/**
 * Prints the compiler-input fingerprint, for CI to key a pattern compile byte
 * cache on.
 *
 * The fingerprint is the value the runtime puts in the `<version>` segment of
 * its own `compileCache:<version>/<identity>` keys, so a cache entry named by
 * it holds bytes this compiler produced. `.github/actions/compile-cache-key`
 * runs this and hands the value to the cache steps as a step output.
 *
 * Base64url, so every character is safe in a GitHub Actions cache key.
 */
import { fromFileUrl } from "@std/path";

import { computeCompilerFingerprint } from "../packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts";

if (import.meta.main) {
  const repoRoot = fromFileUrl(new URL("../", import.meta.url));
  console.log(await computeCompilerFingerprint(repoRoot));
}
