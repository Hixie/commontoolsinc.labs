import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  commitMoment,
  daySeed,
  parseSeed,
  shuffled,
  shuffleFlag,
  shuffleNotice,
} from "./shuffle.ts";

describe("shuffle", () => {
  describe("daySeed()", () => {
    it("reads the date in the Pacific zone rather than in UTC", () => {
      // Midnight UTC on the 22nd is five in the afternoon on the 21st
      // in the Pacific zone.
      expect(daySeed(new Date("2026-09-22T00:00:00Z"))).toBe(20260921);
      expect(daySeed(new Date("2026-09-22T08:00:00Z"))).toBe(20260922);
    });

    it("follows the zone's offset across both of its changes", () => {
      // Summer time runs from March 8th to November 1st in 2026, so the
      // zone is seven hours behind UTC between those dates and eight
      // hours behind outside them. Each pair below straddles one Pacific
      // midnight, so a fixed offset would misplace one of the two.
      expect(daySeed(new Date("2026-01-15T07:59:00Z"))).toBe(20260114);
      expect(daySeed(new Date("2026-01-15T08:01:00Z"))).toBe(20260115);
      expect(daySeed(new Date("2026-07-15T06:59:00Z"))).toBe(20260714);
      expect(daySeed(new Date("2026-07-15T07:01:00Z"))).toBe(20260715);
    });

    it("holds for a whole Pacific day", () => {
      const start = daySeed(new Date("2026-09-22T07:00:00Z"));
      const end = daySeed(new Date("2026-09-23T06:59:00Z"));
      expect(start).toBe(20260922);
      expect(end).toBe(start);
    });
  });

  describe("commitMoment()", () => {
    it("reads when the checked-out commit was committed", async () => {
      const dir = await Deno.makeTempDir({ prefix: "shuffle-commit-" });
      try {
        const git = (...args: string[]) =>
          new Deno.Command("git", {
            args: [
              "-c",
              "user.name=probe",
              "-c",
              "user.email=probe@example.com",
              ...args,
            ],
            cwd: dir,
            env: {
              // Late on the 21st in the Pacific zone, early on the 22nd
              // in UTC, so reading the wrong zone gives the wrong day.
              GIT_COMMITTER_DATE: "2026-09-21T23:30:00-07:00",
              GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
            },
            stdout: "null",
            stderr: "null",
          }).outputSync();
        expect(git("init", "-q").success).toBe(true);
        await Deno.writeTextFile(join(dir, "a.txt"), "a");
        expect(git("add", "a.txt").success).toBe(true);
        expect(git("commit", "-q", "-m", "probe").success).toBe(true);

        const moment = commitMoment(dir);
        expect(moment?.toISOString()).toBe("2026-09-22T06:30:00.000Z");
        // The committer's date, not the author's, and its Pacific day.
        expect(daySeed(moment!)).toBe(20260921);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("answers nothing outside a git checkout", async () => {
      const dir = await Deno.makeTempDir({ prefix: "shuffle-no-commit-" });
      try {
        expect(commitMoment(dir)).toBeUndefined();
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("parseSeed()", () => {
    it("takes an override in place of the day", () => {
      expect(parseSeed("7", new Date("2026-09-22T12:00:00Z"))).toBe(7);
      expect(parseSeed("0", new Date("2026-09-22T12:00:00Z"))).toBe(0);
    });

    it("falls back to the day where nothing overrides it", () => {
      expect(parseSeed(undefined, new Date("2026-09-22T12:00:00Z")))
        .toBe(20260922);
      expect(parseSeed("", new Date("2026-09-22T12:00:00Z"))).toBe(20260922);
    });

    it("refuses an override that is not a non-negative integer", () => {
      expect(() => parseSeed("-1", new Date())).toThrow("CF_TEST_SHUFFLE_SEED");
      expect(() => parseSeed("today", new Date())).toThrow(
        "CF_TEST_SHUFFLE_SEED",
      );
      expect(() => parseSeed("1.5", new Date())).toThrow(
        "CF_TEST_SHUFFLE_SEED",
      );
    });
  });

  describe("shuffleFlag()", () => {
    it("spells the seed the way `deno test` takes it", () => {
      expect(shuffleFlag(20260922)).toBe("--shuffle=20260922");
    });
  });

  describe("shuffleNotice()", () => {
    it("names the seed and the variable that reproduces it", () => {
      const notice = shuffleNotice(20260922);
      expect(notice).toContain("20260922");
      expect(notice).toContain("CF_TEST_SHUFFLE_SEED=20260922");
    });
  });

  describe("shuffled()", () => {
    const items = Array.from({ length: 50 }, (_, index) => index);

    it("holds every item exactly once", () => {
      expect([...shuffled(items, 20260922)].sort((a, b) => a - b))
        .toEqual(items);
    });

    it("gives one order for one seed", () => {
      expect(shuffled(items, 20260922)).toEqual(shuffled(items, 20260922));
    });

    it("gives different orders for different seeds", () => {
      expect(shuffled(items, 20260922)).not.toEqual(
        shuffled(items, 20260923),
      );
    });

    it("moves items rather than handing back what it was given", () => {
      expect(shuffled(items, 20260922)).not.toEqual(items);
    });

    it("leaves its input alone", () => {
      const original = [...items];
      shuffled(items, 20260922);
      expect(items).toEqual(original);
    });

    it("handles the sizes a permutation cannot change", () => {
      expect(shuffled([], 20260922)).toEqual([]);
      expect(shuffled(["only"], 20260922)).toEqual(["only"]);
    });
  });
});
