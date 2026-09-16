---
status: historical
created: 2026-09-16
archived: 2026-09-16
reason: "Investigation findings: why the display ceiling replaces a sub-piece's whole card with a blocked placeholder under the strict CFC dials, and two fix directions measured and rejected."
---

# A pointer label hides the piece that holds the reference

Measured on 2026-09-16 against labs `dd23b59eea` and `c3153d54b0`, with
the CFC dials at the rungs [#7389](https://github.com/commontoolsinc/labs/pull/7389)
makes default and `EXPERIMENTAL_SERVER_EXECUTION=true`, on one
workstation (Apple silicon, Deno 2.9.4) driving local dev servers.

The subject is the second case of
`packages/patterns/integration/cfc-render-policy-demo.test.ts`, "denies
the trusted surface's declassification under the render ceiling", which
fails on `Pattern Integration Tests / opposite server-execution (9/10)`
on the `cfc-dials-at-strictest` branch and not on the trunk. It is the
last blocker measured on that pull request that is not the §8.12.4
whole-object-`set` refusal tracked separately.

## What fails

The reported symptom is that the test cannot click a trusted action. The
page underneath it says something narrower:

```
<cf-screen title=CFC render policy demo>
  <cf-card>                                        the intro card, rendered
  <cf-cfc-blocked data-cfc-blocked-reason=policy>  {rawAttempt}
  <cf-cfc-blocked data-cfc-blocked-reason=policy>  {trustedDisclosure}
```

Both sub-piece cards are replaced wholesale — the trusted surface and
the untrusted one alike — so the trusted action is not singled out; the
card that holds it is gone. The demo's own comment states the contrary
expectation: "the ceiling reaches the value inside each rather than the
card around it".

This is the shape [#7220](https://github.com/commontoolsinc/labs/pull/7220)
removed from the pattern builder, reached by a second route.

## The chain

Each step was read out of a failing run rather than inferred.

1. The reconciler denies two cells that a passing run does not deny. A
   passing run denies exactly the two `cf-cfc-render-boundary` contents,
   against the boundaries' own empty `maxConfidentiality`. A failing run
   denies those plus the two sub-piece documents, at path `[]`, against
   the acting user's ceiling.

2. Those documents carry a stored `origin:"declared"` entry at path `[]`
   naming `Resource(SensitiveHealthRecord)`. In a passing run they carry
   no CFC envelope at all. A root entry covers `value`, so it covers
   `$UI`, and the display ceiling fits a nested piece's result cell
   before the reconciler walks into it.

3. That entry is the §8.12.5 route-2 declaration, minted by the serving
   runtime. The document's history shows the entry arriving on a second
   write by the serving identity — the re-instantiation the serving loop
   performs when a piece-start commit loses its basis — which is why the
   failure is intermittent rather than constant.

4. The clause reached that transaction's flow join through exactly one
   observation, repeated: a `followRef` read at `['/', 'link@1']`,
   carrying the wiring machinery's `machineryRead` marker, consuming an
   `origin:"link"` entry. No content observation carried it. (A fifth
   route-2 mint in the same run, on a different document, did come from
   `value` and `shape` reads of `revealSensitive`.)

So the runtime resolves the health record's reference while wiring the
graph, consumes the pointer's own label doing it (§4.6.3, which is what
the label is for), and the per-transaction join then stamps that clause
on the piece's result document as content.

## Reproduction

`deno task integration patterns cfc-render-policy` with
`PORT_OFFSET` set, `EXPERIMENTAL_SERVER_EXECUTION=true` and `HEADLESS=1`,
against dev servers started under the same flag, on a tree carrying the
strict dials. The single file reproduces it; the shard's other files are
not needed. Rates below are over that file alone.

| Tree | Failures |
| --- | --- |
| strict dials | 3 in 9 |
| strict dials + `cfc-reference-identity-reads` | 2 in 12 |

The second row is the measurement its author recorded as not taken: that
branch marks the two reads in `readMaybeLink` and the write-redirect walk
as reference-identity probes, and it does not clear this failure. It
narrows what those reads consume; the read that carries the clause here
is a probe of a different kind, and consuming a pointer label is what
§4.6.3 asks of it either way.

## Two fix directions, measured and rejected

**Stamp the join's clauses by the class that carried them.** Report the
content-observed join beside the whole one; let the content-class stamps
and the route-2 declaration carry the first, and stamp the pointer-only
remainder as an `observes:"followRef"` entry; narrow the display gate to
the entries a value read consumes. This renders the demo and passes the
whole `packages/runner` suite (1428 tests) and `packages/html` (30), and
it is unsound. Two independent reviews reproduced leaks from it:

- A transaction that probes a reference and writes plain content derived
  from it stamps the clause where nothing content-facing consumes it, so
  the content renders in the clear under a ceiling that admits nothing,
  and a second hop writes a document with no entries at all. The
  observation class of a read says which entry that read consumes at its
  source; it says nothing about which channel of the destination the
  resulting taint belongs in.
- `alias.set(secretCell)` mints one `origin:"link"` entry at the alias
  document's root, and that entry is the whole of the protection: a label
  view rebased at a document root holds the entry, so the gate never
  falls back to asking the target. Narrowing the display gate to the
  value class renders the target's value in the clear.

Both leaks are now guarded — `cfc-persist-split.test.ts` pins that a
probe-borne clause reaches a value reader of what the transaction wrote,
and `worker-reconciler-cfc-render-policy.test.ts` pins that a root link
entry blocks. Neither property was pinned before, which is why a full
green suite said nothing about either.

**Classify the wiring probe as resolution machinery.** §6.1 of
`docs/specs/cfc-observation-classes.md` already puts a probe issued while
following a reference on the row-4 side of the boundary, and
`machineryRead`'s own contract says the machinery reading a plumbing
container's child paths "is the runtime wiring up operations, not an
application observing a slot". Extending that boundary to the marked
probes would drop the clause at the read, where the over-approximation
is introduced, rather than at the write, and the precise carrier would
remain: the reference the wiring stores is a link, and the link write
mints the pointer label at the slot that holds it.

What that direction has to settle first is the list coordinators. They
probe slots under the same marker and then write membership
(`origin:"structure"`, `observes:"enumerate"`) computed from slot
identity, so a container's membership stamp may be exactly the place a
probe-borne pointer label belongs. The marker's contract is explicit
that over-marking under-taints and is the forbidden direction, so this
needs measuring against the phase-B pointwise suite before it is taken.

## Not this defect

One failure in the reproduction has a different shape: the whole page
renders, and a computed label inside the trusted surface
(`#reveal-state`, and the reveal button's own label) is blocked. Its
clause reaches the join through `value` and `shape` reads of
`revealSensitive`, which is a content observation. It is a separate
question from the one above.
