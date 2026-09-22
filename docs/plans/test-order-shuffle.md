# Shuffled test order — what is left to build

Every test run in this repository reorders the tests it runs, seeded by the
Pacific day the commit under test was committed on.
[TESTING.md](../development/TESTING.md#every-test-run-shuffles-its-order) is
the reference for how that works and what it reaches. This plan carries the
two pieces that are not built. Neither is implemented; nothing below
describes current behavior.

## Stage 1: a day-ahead run, at 1am Pacific

Status: not built.

The seed is the Pacific day the commit under test was committed on, so the
order changes with the first commit of each Pacific day. A test that the new
order breaks therefore starts failing at the beginning of a working day, on
whatever change happens to land first, and the team meets it as a broken
morning rather than as a piece of news.

A scheduled job running at 1am Pacific each day converts that into a day of
warning. It checks out the head of `main` and runs the suites under the seed
the next day's commits will take, which is the day after the one it runs on.
When it fails, the team knows before the order arrives which tests it will
break, and can fix them, or decide to, while the current day's runs are
still green.

What it needs:

- A way to ask for that seed. `tasks/test-seed.ts` prints the seed of the
  commit checked out; the day-ahead job needs the Pacific day after the one
  it runs on instead. A flag on that task is the smallest form of it, and
  the job then exports `CF_TEST_SHUFFLE_SEED` from what it prints, which
  every runner already honors.
- A schedule that lands on 1am Pacific in both halves of the year. GitHub
  Actions cron is Coordinated Universal Time only, and the Pacific zone is
  seven hours behind it from March to November and eight hours behind it
  otherwise, so one cron entry drifts by an hour twice a year. Two entries —
  08:00 and 09:00 UTC — with a first step that exits unless the Pacific hour
  is 1 gives exactly one run a day at the right local hour.
- A result that reads as a warning rather than as a failure. The run is
  about an order no commit has run in yet, so its failures must not be
  counted against the commit it ran at, and must not feed the flake
  statistics that decide what is withheld from pull requests. Recording its
  seed already keeps both apart: its records carry a seed that differs from
  the commit's own, and test selection compares outcomes only between runs
  in one order, so a failure there is neither a flake of that commit nor a
  catch. Whether it should record at all, where its output goes, and who
  reads it are the open questions in this stage.

## Stage 2: reordering the cases inside a file

Status: not built. Measure before building.

`deno test --shuffle` reorders a run's files and each file's top-level
registrations. An `it()` inside a `describe()` is a step of the registration
that `describe()` made, and steps are not reordered. This repository asks for
one top-level `describe()` per file, so for most files the shuffle is a file
shuffle. Of 2591 test files in the tree, 1857 have exactly one top-level
`describe()` and no top-level `Deno.test()`; 213 have several top-level
`describe()` calls, and 514 register at least one `Deno.test()` directly.
Only the latter two groups have anything within a file for the flag to
reorder.

That matters more than a file count suggests, because Deno gives each test
file a realm of its own. Module-level state, singletons, globals and built-in
objects never pass from one file to another, so a file shuffle reaches only
what the process holds — environment variables, files, native libraries.
Everything else a test can leave behind for another test lives inside one
file. The first run under the shuffle bears that out: every order-dependent
test it found in the unit suites sat in a file with several top-level
registrations, and each failed because a sibling registration in the same
file ran first. For the 1857 files holding a single `describe()`, the same
kind of dependence between two `it()` calls is out of the shuffle's reach
today.

The place that would reach the rest already exists.
[`packages/test-support/src/records/bdd.ts`](../../packages/test-support/src/records/bdd.ts)
is what every test file's `import { describe, it } from "@std/testing/bdd"`
resolves to: the root import map points that specifier at this repository's
own module and gives the standard library's a second name,
`@std/testing/bdd/real`. The module already wraps both functions, tracks the
chain of names enclosing each registration, and can register a case as ignored
in place of running it. So no test file's import has to change, and the
question is only what to add to that module.

What to add: `describe` collects the registrations its body makes — its `it()`
calls and its nested `describe()` calls — and replays them in the seed's order
once the body has run, instead of letting each one register as the body
reaches it. The hooks need no such treatment, since where a `beforeEach()`
sits in the body does not decide when it runs. A case's identity is the chain
of names around it joined with its own, which does not depend on the order, so
the run-record store and the skip list keep working across the change.

Three things to get right, and the reason to measure before starting:

- The module hands back the standard library's own functions untouched when no
  record capture is installed, and a run in that state has to shuffle too.
  Whatever holds the seed therefore sits outside the capture, not inside it.
- The wrapper has to keep carrying everything the two functions already do —
  `it.only`, `it.ignore`, `describe.only`, `describe.ignore`, the
  named-suite handle a call can pass instead of nesting inside it, and the
  object-form overloads. It carries them today; collecting and replaying
  registrations must not drop one.
- A reader of a failing run sees cases in an order the file does not have.
  Each runner already prints its seed, which is what makes that order
  reproducible; whether it is also legible is worth checking on a real failure
  before committing to the change.

The measurement that decides it: run the suite once under a throwaway version
of that wrapper which shuffles within a file, and count the tests that fail.
That number is the size of the debt the change would open, and it has to be
paid before the shuffle can be on by default. If it is a handful, fixing those
by hand and holding the line with the rule in
[unit-test-coding-style.md](../development/unit-test-coding-style.md#each-case-stands-on-its-own)
costs less than the wrapper does. If it is large, the wrapper is what stops
the next one arriving.
