import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  commitMoment,
  daySeed,
  parseSeed,
  pinShuffleSeed,
  shuffled,
  shuffledPaths,
  shuffleFlag,
  shuffleNotice,
  shuffleSeed,
} from "./shuffle.ts";

/** Makes a git repository whose one commit was committed at `when`. */
async function repoCommittedAt(when: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "shuffle-commit-" });
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
        GIT_COMMITTER_DATE: when,
        GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      },
      stdout: "null",
      stderr: "null",
    }).outputSync();
  expect(git("init", "-q").success).toBe(true);
  await Deno.writeTextFile(join(dir, "a.txt"), "a");
  expect(git("add", "a.txt").success).toBe(true);
  expect(git("commit", "-q", "-m", "probe").success).toBe(true);
  return dir;
}

/** Runs `body` with the seed variable as `value`, restoring it after. */
async function withSeedVariable(
  value: string | undefined,
  body: () => void | Promise<void>,
): Promise<void> {
  const previous = Deno.env.get("CF_TEST_SHUFFLE_SEED");
  if (value === undefined) Deno.env.delete("CF_TEST_SHUFFLE_SEED");
  else Deno.env.set("CF_TEST_SHUFFLE_SEED", value);
  try {
    await body();
  } finally {
    if (previous === undefined) Deno.env.delete("CF_TEST_SHUFFLE_SEED");
    else Deno.env.set("CF_TEST_SHUFFLE_SEED", previous);
  }
}

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
      // Late on the 21st in the Pacific zone, early on the 22nd in UTC, so
      // reading the wrong zone gives the wrong day, and an author date
      // years earlier, so reading the wrong date gives the wrong year.
      const dir = await repoCommittedAt("2026-09-21T23:30:00-07:00");
      try {
        const moment = commitMoment(dir);
        expect(moment?.toISOString()).toBe("2026-09-22T06:30:00.000Z");
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
      // Past 2^53 a number cannot hold every integer, so this one would
      // round to a neighbor and name a seed nobody chose.
      expect(() => parseSeed("9007199254740993", new Date())).toThrow(
        "CF_TEST_SHUFFLE_SEED",
      );
      expect(parseSeed("9007199254740991", new Date())).toBe(
        Number.MAX_SAFE_INTEGER,
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

  describe("shuffleSeed()", () => {
    it("takes the day the checked-out commit was committed", async () => {
      const dir = await repoCommittedAt("2026-09-21T23:30:00-07:00");
      try {
        await withSeedVariable(undefined, () => {
          expect(shuffleSeed(dir)).toBe(20260921);
        });
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("takes the environment's seed over the commit's", async () => {
      const dir = await repoCommittedAt("2026-09-21T23:30:00-07:00");
      try {
        await withSeedVariable("7", () => {
          expect(shuffleSeed(dir)).toBe(7);
        });
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("takes today's outside a git checkout", async () => {
      const dir = await Deno.makeTempDir({ prefix: "shuffle-no-commit-" });
      try {
        await withSeedVariable(undefined, () => {
          const before = daySeed(new Date());
          const seed = shuffleSeed(dir);
          // Read either side of the call, so a Pacific midnight between
          // the two cannot make the case fail.
          expect([before, daySeed(new Date())]).toContain(seed);
        });
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("pinShuffleSeed()", () => {
    it("settles the seed in the environment and names it", async () => {
      await withSeedVariable("7", () => {
        const announced: string[] = [];
        expect(pinShuffleSeed((line) => announced.push(line))).toBe(7);
        expect(Deno.env.get("CF_TEST_SHUFFLE_SEED")).toBe("7");
        expect(announced).toEqual([shuffleNotice(7)]);
      });
    });

    it("writes a seed read from git where none was named", async () => {
      await withSeedVariable(undefined, () => {
        const seed = pinShuffleSeed(() => {});
        expect(Deno.env.get("CF_TEST_SHUFFLE_SEED")).toBe(String(seed));
      });
    });
  });

  describe("shuffledPaths()", () => {
    it("gives one order whatever order the paths arrived in", () => {
      const paths = Array.from({ length: 20 }, (_, index) => `f${index}.ts`);
      expect(shuffledPaths([...paths].reverse(), 20260922)).toEqual(
        shuffledPaths(paths, 20260922),
      );
      expect([...shuffledPaths(paths, 20260922)].sort()).toEqual(
        [...paths].sort(),
      );
    });
  });
});
