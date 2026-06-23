import type { CompiledModuleArtifact } from "../harness/types.ts";

/**
 * Content-addressed cache of compiled MODULE BYTES, injected via
 * `RuntimeOptions.moduleByteCache`. The ESM cell-cache compile path consults it
 * before the per-space storage read — a full hit skips both the storage read and
 * the whole transform-and-emit step (`compileToModules`) — and populates it after
 * a compile, so a module compiled in one runtime or space serves another
 * compiling the same module.
 *
 * Entries are keyed by a module's content identity scoped by the compiled-set
 * `runtimeVersion`; the emitted bytes are a deterministic function of that pair
 * (the emitter strips the whole-program path prefix, so a module's bytes are the
 * same in every program that contains it), so a hit always returns the bytes the
 * identity addresses.
 *
 * The runtime defines only this interface. The implementation, and its
 * persistence, live in test code, so the cache is instantiated only from tests
 * and never in production.
 */
export interface ModuleByteCache {
  /**
   * The cached bodies for `identities` iff EVERY identity is present, else
   * `undefined`. The transform-and-emit step is whole-program, so only a full
   * set lets a compile skip it.
   */
  getCompleteSet(
    runtimeVersion: string,
    identities: readonly string[],
  ): Map<string, CompiledModuleArtifact> | undefined;

  /**
   * Store a freshly compiled (or reused) module set, keyed by content identity
   * scoped by `runtimeVersion`. Idempotent and content-addressed.
   */
  putAll(
    runtimeVersion: string,
    modules: readonly { identity: string; js: string; sourceMap?: unknown }[],
  ): void;
}
