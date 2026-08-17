# deno coverage: an emoji shifts every later coverage range

A source file that contains a Unicode scalar value outside the Basic
Multilingual Plane — one that UTF-16 has to encode as a surrogate pair, which
in practice means an emoji — has every `deno coverage` range after it compared
against the wrong line boundaries. Each such scalar value moves the comparison
one scalar value to the right. A single emoji is often two of them: a face
followed by a skin-tone modifier is one extended grapheme cluster made of two
scalar values, both outside that plane. Two is enough for a range that ends at a
line's last scalar value to appear to reach into the line that follows.

The visible result is a function declaration line reported as **0 hits**
whenever the function declared immediately before it was not called, even
though the function on that line ran and its whole body is reported as covered.

## Why it happens

V8 reports coverage ranges as offsets in UTF-16 code units, which is how a
JavaScript engine counts positions in a string. Deno reads those offsets and
compares them against scalar-value offsets computed from the source text — the
unit Rust's `char` counts in. A scalar value outside the Basic Multilingual
Plane is one scalar value but two UTF-16 code units, so after the first one
every range appears one scalar value further right than it is, after the second
one two further, and so on.

Deno decides a line's hit count in two passes. First it takes the count of the
smallest coverage range that fully contains the line. Then it resets the count
to zero if a range with a count of zero covers the line's code, judged three
ways; one of the three is that a function which was never called reports a
single zero-count range, and that range covers the function's own declaration
line even though it starts a few scalar values into it, after `export` and
`async`.

An uncovered function's range ends just past its closing brace, which is the
last scalar value of that line. Shifted two scalar values right, the range's end
now sits past the start of the next line. The next line is the following
function's declaration, so that declaration is treated as part of the uncovered
function and reset to zero.

The shift reaches every range after the surrogate pair, but it only changes an
outcome where a range's edge sits within two scalar values of a line boundary.
An edge in the middle of a line still lands in the middle of that line.

## Reproduction

`astral.ts`, whose string holds one emoji — two scalar values:

```ts
export const BADGE = "🕵🏻";

export function first(a: number): number {
  return a + 1;
}
export function second(a: number): number {
  return a + 2;
}
```

`astral.test.ts`, which calls only the second of them:

```ts
// Shown for illustration only.
import { second } from "./astral.ts";

Deno.test("calls the second, never the first", () => {
  second(1);
});
```

```
deno test --coverage=cov astral.test.ts
deno coverage cov --lcov | grep '^DA:'
```

```
DA:1,1
DA:3,0   // export function first(a: number): number {
DA:4,0   // return a + 1;
DA:5,0   // }
DA:6,0   // export function second(a: number): number {  <- ran, reported 0
DA:7,1   // return a + 2;
DA:8,1   // }
```

Replacing the emoji with an ASCII letter, or reducing it to the bare face with
no skin-tone modifier so that only one scalar value needs a surrogate pair,
reports line 6 as covered.

## Where it bites us

`tasks/ci-check-lib.ts` builds the coverage gate's pull request comments, and
one of those templates carries a detective emoji. Every function declared after
it is coupled to the function declared before it: the declaration line counts as
covered only in a coverage profile where both of them ran.

That coupling turns into a flapping coverage measurement whenever the two
functions are reached from different test files, because the task tests are
split across three shards by measured test cost and each shard writes its own
LCOV report. Two functions in the same shard are merged at the V8 range level
and the declaration line is covered; in different shards each report has the
line at zero, and combining the reports adds zero to zero. The shard split moves
when the timing weights are regenerated, so the line's coverage moves with it.

The fix is to keep the tests for consecutive functions in one test file, so a
single file covers the declaration whichever shard it lands in.
`tasks/ci-check-lib.test.ts` covers `fetchPRFiles`, `fetchIssueComments`,
`pullRequestBodyFromEvent` and `fetchCurrentPRBody` for that reason, and says so
where those tests sit.
[The August 2026 investigation](../history/development/coverage-flake-declaration-lines-2026-08-17.md)
follows the four lines this was found through.

## Handling

A line moved by this artifact is not a line to leave uncovered, and not one to
spend an `ACCEPT_COVERAGE_DEBT` marker on. It is a real line of a real function,
and a test that calls both the function and the one declared before it covers it
on every run. [COVERAGE.md](COVERAGE.md) states the policy that applies to it,
alongside the other causes of a coverage measurement that moves with the
environment.

Removing the emoji from the source would also remove the shift, but the emoji is
part of what the gate posts on a pull request, so the tests carry the fix
instead.
