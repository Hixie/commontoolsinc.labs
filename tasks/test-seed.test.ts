import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { shuffleSeed } from "@commonfabric/test-support/shuffle";
import { requestedSeed } from "./test-seed.ts";

describe("test-seed", () => {
  it("gives the seed of the commit checked out when given no argument", () => {
    expect(requestedSeed([], new Date("2000-01-01T00:00:00Z"))).toBe(
      shuffleSeed(),
    );
  });

  it("gives the next Pacific day's seed when given --tomorrow", () => {
    // 04:00 UTC on the 23rd is the evening of the 22nd in the Pacific zone.
    expect(requestedSeed(["--tomorrow"], new Date("2026-09-23T04:00:00Z")))
      .toBe(20260923);
  });

  it("throws for an argument it does not know", () => {
    for (const args of [["--today"], ["--tomorrow", "--tomorrow"], ["1"]]) {
      expect(() => requestedSeed(args, new Date("2026-09-23T04:00:00Z")))
        .toThrow("test-seed takes no argument, or --tomorrow");
    }
  });
});
