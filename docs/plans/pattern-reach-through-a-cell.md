# Pattern reach through a cell

A handler holds the cells its pattern was given. A cell carries the runtime and
the transaction it is bound to, and `Runner.run` wires whatever result cell it
is handed to whatever program it is handed. So a handler that holds a cell for
a second running piece can choose the program that piece runs:

```ts
// Shown for illustration only.
// Inside a handler, where `victim` is a cell the pattern was given.
const reachable = victim as unknown as {
  runtime: { run: (...args: unknown[]) => unknown };
  tx: unknown;
};
reachable.runtime.run(reachable.tx, Evil, {}, reachable);
```

The meta seam's write gate does not cover this and was never meant to. That
gate governs writes to the seam; this is the runtime writing the seam while
doing its own work, at the caller's request, through the authorized entry
point. `packages/runner/test/meta-seam-write-authorization.test.ts` records the
reach as a passing test, "can still ask the runtime to run its own pattern on
that piece", so that closing it is visible.

This plan settles where the boundary goes.

## What is established

The reach is two independent links, and either one closes it.

**A cell hands out the runtime.** `runtime` and `tx` are declared as
constructor parameter properties on the cell implementation
(`packages/runner/src/cell.ts`), so they are own enumerable properties of every
cell object. Enumerable matters beyond this reach: `Object.keys` on a cell
names them, and anything that walks or spreads a cell walks the runtime.

**`run` wires any cell it is handed.** `Runner.run`
(`packages/runner/src/runner.ts`) takes the result cell as a parameter and asks
nothing about the caller's relationship to it.

Two further findings narrow the options.

**The builder frame cannot carry the guard.** `getTopFrame()` reports the
innermost pattern frame, and `safe-builtins.ts` already gates `Date.now()`,
`Math.random()` and `fetch` on it. It cannot gate this one. The frames live in
a plain module-level array (`const frames: Frame[] = []` in
`packages/runner/src/builder/pattern.ts`) with no binding to the async context,
while an async handler's frame stays pushed until its promise settles. The
existing gates survive that because they fail closed — a lost or foreign frame
denies a capability. A gate that refuses when a pattern frame is present fails
open instead: it grants the capability whenever the frame is missing or
belongs to someone else. The runtime already has the tool for a sound version
of this — `WriteDebugContextStorage` in `runtime.ts` is `AsyncLocalStorage`
where the platform has it — but the frame stack does not use it, and making it
do so is its own change with its own risks.

**`patternIdentity` is not the discriminator for "already running".** A
pattern evaluated without a content-addressed entry carries none, which is why
the recorded test asserts on the victim's result value rather than its
identity metadata. What does answer the question is the runner's own
registration: `Runner.cancels`, a map from a result cell's space, scope and URI
to its cancel, holding an entry for exactly the pieces the runner is running.

## Options

**Authorize every `run`.** Give `Runner.run` an authorization parameter the way
`setMetaRaw` has one, held by the runner's modules and by hosts, unnameable
from pattern code. Sound, and the idiom is already in the tree. The cost is the
sweep: 638 call sites against 156 for the meta seam. Fourteen are in `src` —
thirteen in `packages/runner`, one in `packages/piece` — six are in
`packages/cli/lib`, one is in `packages/generated-patterns`, and the remaining
617 are in tests, almost all of them in `packages/runner/test`. It also puts a
capability parameter on a host-facing entry point that hosts have every right
to call. I would expect most of those 617 to be instantiating a fresh cell of
the test's own, where nothing is at stake, but I have not read them.

**Authorize displacement only.** Leave `run` open for a result cell the runner
is not already running, and require the authorization to displace one it is —
to point a running piece at a different program. That is the operation the
attack performs and the only one that costs anything: creating a piece on a
cell you already hold takes nothing from anyone. `Runner.cancels` answers the
question in memory, with no read and no dependence on metadata a test-built
pattern may not carry. The sweep shrinks to the flows that legitimately
displace — `setsrc` in the piece controller, the space-root repair in
`ensure-space-root.ts`, the unloadable-root auto-update inside the runner, and
the tests that exercise those. The cost is a rule with a condition in it, where
the meta seam's rule is uniform, and a new question at every call site: is
this a creation or a displacement?

**Take the runtime off the pattern-facing cell.** The principled place, and
what the recorded residual points at: a handler needs a cell to read, write and
sink, not to reach the runtime that hands it out. It closes the reach whatever
the entry point, so it also covers whatever else on `Runtime` turns out to be
worth reaching. The cost is the object graph: one cell class serves the runtime
and pattern code alike, and separating them means either a second pattern-facing
type or a per-call decision about which surface a cell is handed across.

## Recommendation

Do the second and the third, in that order, and treat them as separate
changes.

Displacement authorization is the one that closes the recorded hole, and it is
bounded enough to land on its own. It stands on the runner's own registration
rather than on ambient context or on metadata, and it leaves untouched every
call site where nothing is at stake.

Taking the runtime off the pattern-facing cell is the boundary the residual
actually names, and it wants its own design pass rather than being folded into
a gate. Until it lands, `cell.runtime` remains reachable, so the gate above is
the load-bearing part and should be written as though nothing else guards it.

Making `runtime` and `tx` `#` fields with getters is worth doing regardless and
belongs to neither: it does not close the reach, since a getter reads the same
as a property, but it takes them out of enumeration, which is a separate leak
and a standing convention in this repository (`.claude/rules/source-code.md`,
"no enumerable properties on a class").

## Stages

1. **Displacement gate.** `Runner.run` refuses to point a result cell the
   runner is already running at a different program unless the call carries an
   authorization. The authorization follows `rawMetaWriteAuthorization`: a
   value keyed by a symbol, held by the runner's modules, exported on a
   subpath rather than the barrel. Rewrite the recorded test from "can still"
   to "cannot", and keep a test for the reach that remains.
2. **Legitimate displacers.** Hand the authorization to `setsrc`, the
   space-root repair, and the runner's own unloadable-root auto-update, plus
   the tests that drive those flows. Kept as its own commit, as the meta seam's
   sweep was.
3. **`#runtime` and `#tx`.** Convert the two parameter properties to private
   fields with getters.
4. **The pattern-facing cell surface.** Design pass on what a handler needs
   from a cell, and what hands it one. Not sequenced here.

## Not in scope

The other residual recorded beside this one in
[`runner_cfc_implementation.md`](runner_cfc_implementation.md) — a
document-root write whose envelope embeds a `cfc` record reaching the label map
with nothing recorded — is a separate line of work.
