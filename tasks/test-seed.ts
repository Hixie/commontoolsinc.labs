#!/usr/bin/env -S deno run --allow-env=CF_TEST_SHUFFLE_SEED --allow-run=git

/**
 * Prints the seed every test runner in this repository shuffles by, so
 * that a `deno test` spelled in a task can be handed it.
 *
 * The seed goes to standard output alone, which is what a command
 * substitution reads. The line naming it goes to standard error, so that
 * a run reports the order it took whether or not anyone thought to ask.
 */

import { shuffleNotice, shuffleSeed } from "@commonfabric/test-support/shuffle";

if (import.meta.main) {
  const seed = shuffleSeed();
  console.error(shuffleNotice(seed));
  console.log(seed);
}
