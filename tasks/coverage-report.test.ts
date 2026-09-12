import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as path from "@std/path";
import {
  type Figure,
  joinReports,
  main,
  measuredSetFigures,
  parseReportArgs,
  summarize,
} from "./coverage-report.ts";
import { COVERAGE_METRIC_PREFIX } from "./coverage-metrics.ts";
import { measuredSetCoverageMetric } from "./ci-check-lib.ts";
import { COVERAGE_REPORT_DIR, COVERAGE_REPORT_FILE } from "./ci-lane.ts";
import { loadTopology } from "./test-topology.ts";
import {
  measuredSetDirectory,
  measuredSets,
} from "./test-selection/coverage.ts";

/** The repository these tests read the workspace and its sources from. */
const REPOSITORY = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** The workspace member the figure tests write a set report for. */
const MEMBER = "packages/leb128";

/** The suite whose units measure that member. */
const SUITE = "workspace-unit";

/** A directory holding one file per entry, at a path relative to its root. */
async function reportsIn(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "coverage-report-" });
  for (const [at, content] of Object.entries(files)) {
    const file = path.join(root, at);
    await Deno.mkdir(path.dirname(file), { recursive: true });
    await Deno.writeTextFile(file, content);
  }
  return root;
}

/**
 * A reports directory holding one lane's report for `MEMBER`'s set,
 * carrying the LCOV records given.
 *
 * The directory that report goes in comes from the topology rather than
 * from a name written here, because the topology is where the lane that
 * writes one gets it and a second answer could disagree with the first.
 */
async function reportFor(records: string): Promise<string> {
  const ref = measuredSets(await loadTopology(REPOSITORY))
    .find((candidate) =>
      candidate.suite === SUITE && candidate.set.member === MEMBER
    );
  if (ref === undefined) throw new Error(`no ${SUITE} set for ${MEMBER}`);
  const at = path.join(
    "lane-1",
    COVERAGE_REPORT_DIR,
    measuredSetDirectory(ref),
    COVERAGE_REPORT_FILE,
  );
  return await reportsIn({ [at]: records });
}

/** The measured-set figures a reports directory yields. */
function figuresFrom(reports: string): Promise<Figure[]> {
  return measuredSetFigures({
    reports,
    out: "/dev/null",
    runId: 1,
    sha: "abc",
    createdAt: "2026-09-01T00:00:00Z",
    root: REPOSITORY,
  });
}

describe("coverage-report", () => {
  describe("parseReportArgs()", () => {
    it("returns the defaults for the flags a command line omits", () => {
      const options = parseReportArgs(["--reports", "artifacts"], "/root");
      expect(options?.reports).toBe("artifacts");
      expect(options?.out).toBe("perf-metrics.json");
      expect(options?.root).toBe("/root");
    });

    it("returns `undefined` for a flag with no value", () => {
      expect(parseReportArgs(["--reports"], "/root")).toBeUndefined();
    });

    it("returns `undefined` for a flag nothing reads", () => {
      expect(parseReportArgs(["--nonsense", "1"], "/root")).toBeUndefined();
    });
  });

  describe("joinReports()", () => {
    it("returns every LCOV report under the directory it is given", async () => {
      const root = await reportsIn({
        "lane-1/lcov/sets/workspace-unit/packages_memory/coverage.lcov":
          "SF:/a.ts\nend_of_record\n",
        "lane-2/lcov/sets/runner-unit/packages_runner/coverage.lcov":
          "SF:/b.ts\nend_of_record\n",
        "lane-2/notes.txt": "not a report",
      });
      try {
        const joined = await joinReports(root);
        expect(joined).toContain("SF:/a.ts");
        expect(joined).toContain("SF:/b.ts");
        expect(joined).not.toContain("not a report");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns an empty report for a directory nothing was downloaded into", async () => {
      // What follows scores an empty report, which charges every tracked
      // line as uncovered and is the honest reading of a run whose lanes
      // reported nothing.

      expect(await joinReports("/nonexistent-coverage-artifacts")).toBe("");
    });
  });

  describe("measuredSetFigures()", () => {
    it("returns a figure for the set a lane reported and for no other", async () => {
      // Every other set the topology declares went unreported, and a set
      // with no report is left out. The gate reads the newest baseline
      // the branch holds, so leaving it out leaves the previous run's
      // figure standing, where publishing one would tell every later
      // pull request that the member's whole source had gone uncovered.

      const source = path.join(REPOSITORY, MEMBER, "src/index.ts");
      const root = await reportFor(`SF:${source}\nDA:1,1\nend_of_record\n`);
      try {
        const figures = await figuresFrom(root);
        expect(figures.map((figure) => figure.name)).toEqual([
          measuredSetCoverageMetric(`${SUITE}/${MEMBER}`),
        ]);
        expect(figures[0].uncoveredLines).toBeGreaterThanOrEqual(0);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns no figure where the report reached none of the member's files", async () => {
      // A report with a record for none of the member's files measured
      // nothing, whatever it says about the lines it does carry, and a
      // baseline from it is one no run of the set stands behind.

      const root = await reportFor("SF:/elsewhere.ts\nDA:1,1\nend_of_record\n");
      try {
        expect(await figuresFrom(root)).toEqual([]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("summarize()", () => {
    it("returns a summary naming the workspace figure", () => {
      const figures: Figure[] = [
        {
          name: `${COVERAGE_METRIC_PREFIX} workspace uncovered lines`,
          uncoveredLines: 12,
        },
        {
          name: `${COVERAGE_METRIC_PREFIX} packages/memory uncovered lines`,
          uncoveredLines: 3,
        },
      ];
      const summary = summarize(figures);
      expect(summary).toContain("12 uncovered lines");
      expect(summary).toContain("2 figures published");
    });

    it("returns a summary saying so where no report covered the workspace", () => {
      expect(summarize([])).toContain("No report covered the workspace");
    });
  });

  describe("main()", () => {
    it("returns zero having published a baseline where no lane reported", async () => {
      // The run this reports on has already decided whether it passed.
      // Coverage is a trend on the default branch, so however the
      // figures came out, and however few of them there are, this exits
      // zero.

      const out = await Deno.makeTempFile({ prefix: "coverage-report-" });
      const summaryFile = await Deno.makeTempFile({ prefix: "step-summary-" });
      const before = Deno.env.get("GITHUB_STEP_SUMMARY");
      Deno.env.set("GITHUB_STEP_SUMMARY", summaryFile);
      try {
        const status = await main(
          ["--reports", "/nonexistent-coverage-artifacts", "--out", out],
          REPOSITORY,
        );
        expect(status).toBe(0);
        const published = JSON.parse(await Deno.readTextFile(out));
        expect(published.metrics.map((metric: { name: string }) => metric.name))
          .toContain(`${COVERAGE_METRIC_PREFIX} workspace uncovered lines`);
        expect(await Deno.readTextFile(summaryFile)).toContain("## Coverage");
      } finally {
        if (before === undefined) Deno.env.delete("GITHUB_STEP_SUMMARY");
        else Deno.env.set("GITHUB_STEP_SUMMARY", before);
        await Deno.remove(out);
        await Deno.remove(summaryFile);
      }
    });

    it("returns two for a command line it cannot read", async () => {
      expect(await main(["--nonsense", "1"], REPOSITORY)).toBe(2);
    });
  });
});
