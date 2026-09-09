import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  coverageCosts,
  coverageGate,
  coveredMembers,
  measuredUnits,
  memberCosts,
  memberSlug,
  membersTouched,
} from "./coverage.ts";
import { EXCLUDED_FROM_COVERAGE_GATE } from "./policy.ts";
import { sampleEntry, sampleManifest } from "./testing.ts";
import type { Manifest } from "./manifest.ts";
import type { Suite } from "../test-topology/suite.ts";

const MEMBERS = [
  "./packages/memory",
  "./packages/connectors/github",
  "./packages/runner",
  "./tasks",
];

/** A unit suite enumerating exactly these units. */
function suiteHolding(id: string, units: readonly string[]): Suite {
  return {
    id,
    recordSurfaces: [],
    needs: ["deno"],
    units: [...units],
    unavailable: [],
    locate: () => undefined,
    command: () => Promise.resolve([]),
  };
}

/** A manifest costing each of these units the seconds beside it. */
function costing(
  units: Record<string, number>,
  fields: Partial<Manifest> = {},
): Manifest {
  return sampleManifest({
    entries: Object.entries(units).map(([unit, cost], at) =>
      sampleEntry({ k: "unit", s: "memory", n: `test ${at}` }, { unit, cost })
    ),
    ...fields,
  });
}

/** A manifest whose identities all ran through the browser harness. */
function browserCosting(units: Record<string, number>): Manifest {
  const manifest = costing(units);
  for (const entry of manifest.entries) entry.test.k = "browser";
  return manifest;
}

const COST_MEMBERS = [
  "./packages/memory",
  "./packages/runner",
  "./packages/identity",
  "./tasks",
];

describe("coverage", () => {
  it("covers every workspace member under packages that is not excluded", () => {
    // Membership follows the workspace rather than a path depth, so a
    // package nested two deep is covered on the same terms as one nested
    // one, and a package outside `packages/` is not covered at all.
    expect(coveredMembers(MEMBERS)).toEqual([
      "packages/connectors/github",
      "packages/memory",
    ]);
    expect(EXCLUDED_FROM_COVERAGE_GATE.has("packages/runner")).toBe(true);
  });

  it("charges a file to the deepest member that holds it", () => {
    // `packages/connectors/github/src/x.ts` belongs to the connector
    // rather than to a `packages/connectors` that happens to be a member
    // too, so a change there scores the package somebody edited.
    expect(
      membersTouched(
        [...MEMBERS, "./packages/connectors"],
        new Set(["packages/connectors/github/src/api.ts"]),
      ),
    ).toEqual(["packages/connectors/github"]);
  });

  it("names no member for a change that reaches none of them", () => {
    expect(membersTouched(MEMBERS, new Set(["docs/README.md"]))).toEqual([]);
    expect(coverageGate(MEMBERS, new Set(["docs/README.md"])))
      .toEqual({ members: [] });
  });

  it("turns the gate off for a change touching more than the cap", () => {
    // Off entirely rather than off for some of them: gating two of the
    // four packages a change touched would mean quietly ignoring the
    // other two, and a cliff is at least predictable from the diff.
    const gate = coverageGate(
      MEMBERS,
      new Set([
        "packages/memory/src/a.ts",
        "packages/connectors/github/src/b.ts",
      ]),
      1,
    );
    expect(gate.members).toEqual([]);
    expect(gate.off).toContain("2 covered packages");
  });

  it("gates a change that stays within the cap", () => {
    const gate = coverageGate(
      MEMBERS,
      new Set(["packages/memory/src/a.ts", "packages/runner/src/b.ts"]),
      1,
    );
    expect(gate.members).toEqual(["packages/memory"]);
    expect(gate.off).toBeUndefined();
  });

  it("makes a gated member's own tests the measured set", () => {
    // The browser half measures none of the source the gate scores, so
    // making it mandatory would start a browser for a figure it cannot
    // move.
    const units = [
      "packages/memory/test/a.test.ts",
      "packages/memory/test/b.test.ts",
      "packages/memory#browser-test",
      "packages/other/test/c.test.ts",
    ];
    expect(
      measuredUnits("workspace-unit", units, new Set(["packages/memory"])),
    ).toEqual([
      "packages/memory/test/a.test.ts",
      "packages/memory/test/b.test.ts",
    ]);
  });

  it("measures nothing outside the suites a member's own tests run in", () => {
    expect(
      measuredUnits(
        "pattern-integration",
        ["packages/memory/test/a.test.ts"],
        new Set(["packages/memory"]),
      ),
    ).toEqual([]);
    expect(
      measuredUnits(
        "workspace-unit",
        ["packages/memory/test/a.test.ts"],
        new Set(),
      ),
    ).toEqual([]);
  });

  it("names a member's report the way its coverage directory is named", () => {
    expect(memberSlug("packages/memory")).toBe("memory");
    expect(memberSlug("./packages/connectors/github")).toBe(
      "connectors__github",
    );
  });

  describe("memberCosts()", () => {
    it("charges a member what its own units cost", () => {
      const suites = [suiteHolding("workspace-unit", [
        "packages/memory/test/a.test.ts",
        "packages/memory/test/b.test.ts",
      ])];
      const manifest = costing({
        "packages/memory/test/a.test.ts": 4,
        "packages/memory/test/b.test.ts": 6,
      });
      const cost = memberCosts(manifest, COST_MEMBERS, suites)
        .get("packages/memory")!;
      expect(cost).toEqual({
        member: "packages/memory",
        seconds: 10,
        units: 2,
        measured: 2,
      });
    });

    it("costs a set the way the packer costs the batch that holds it", () => {
      // The identities' own time through the suite's fitted correction,
      // plus that suite's overhead and each unit's own overhead, which is
      // the model every other cost in this design is fitted to.
      const suites = [suiteHolding("workspace-unit", [
        "packages/memory/test/a.test.ts",
      ])];
      const manifest = costing({ "packages/memory/test/a.test.ts": 10 }, {
        calibration: {
          setupCost: {},
          suites: { "workspace-unit": { overhead: 3, correction: 0.5 } },
          unitOverhead: { "packages/memory/test/a.test.ts": 1 },
          prologue: 0,
        },
      });
      expect(
        memberCosts(manifest, COST_MEMBERS, suites).get("packages/memory")!
          .seconds,
      ).toBe(9);
    });

    it("leaves out the browser half and the units of other suites", () => {
      // The browser half produces no coverage of the source the gate
      // scores, and an integration suite's units are not a member's own
      // tests whatever they exercise.
      const suites = [
        suiteHolding("workspace-unit", [
          "packages/memory/test/a.test.ts",
          "packages/memory#browser-test",
        ]),
        suiteHolding("pattern-integration", ["packages/memory/x.test.ts"]),
      ];
      const manifest = costing({
        "packages/memory/test/a.test.ts": 4,
        "packages/memory#browser-test": 100,
        "packages/memory/x.test.ts": 100,
      });
      const cost = memberCosts(manifest, COST_MEMBERS, suites)
        .get("packages/memory")!;
      expect(cost.seconds).toBe(4);
      expect(cost.units).toBe(1);
    });

    it("tells a member nothing has recorded from one with no units", () => {
      // A member the store has never recorded has units and no
      // measurement; a member whose Deno-only half is empty has neither.
      const suites = [suiteHolding("workspace-unit", [
        "packages/memory/test/a.test.ts",
      ])];
      const costs = memberCosts(
        sampleManifest({ entries: [] }),
        COST_MEMBERS,
        suites,
      );
      expect(costs.get("packages/memory")).toEqual({
        member: "packages/memory",
        seconds: 0,
        units: 1,
        measured: 0,
      });
      expect(costs.get("packages/identity")).toEqual({
        member: "packages/identity",
        seconds: 0,
        units: 0,
        measured: 0,
      });
    });

    it("leaves out a test the browser harness ran, whatever unit it is on", () => {
      // A member that names a browser half has a unit of its own to place
      // those in. A member whose whole test task is the harness does not,
      // and the topology reads that task as its Deno half, so the kind the
      // record carries is the only thing that says otherwise.
      const suites = [suiteHolding("workspace-unit", ["packages/identity"])];
      const cost = memberCosts(
        browserCosting({ "packages/identity": 4 }),
        ["./packages/identity"],
        suites,
      ).get("packages/identity")!;
      expect(cost).toEqual({
        member: "packages/identity",
        seconds: 0,
        units: 1,
        measured: 0,
      });
    });

    it("leaves out a unit this configuration declares unavailable", () => {
      // A unit that does not run is not part of the set the gate would make
      // mandatory, so counting it would leave the member measured in part
      // for good.
      const suite = suiteHolding("workspace-unit", [
        "packages/memory/test/a.test.ts",
        "packages/memory/test/off.test.ts",
      ]);
      suite.unavailable = [{
        unit: "packages/memory/test/off.test.ts",
        reason: "this configuration does not run it",
      }];
      const cost = memberCosts(
        costing({ "packages/memory/test/a.test.ts": 4 }),
        COST_MEMBERS,
        [suite],
      ).get("packages/memory")!;
      expect(cost.units).toBe(1);
      expect(cost.measured).toBe(1);
    });

    it("charges nothing for a unit the tree no longer enumerates", () => {
      // A manifest is hours old, so it names units the tree has since
      // dropped, and no lane can be asked to run one.
      const suites = [suiteHolding("workspace-unit", [
        "packages/memory/test/a.test.ts",
      ])];
      const manifest = costing({
        "packages/memory/test/a.test.ts": 4,
        "packages/memory/test/gone.test.ts": 90,
      });
      expect(
        memberCosts(manifest, COST_MEMBERS, suites).get("packages/memory")!
          .seconds,
      ).toBe(4);
    });

    it("charges a unit to the deepest member that holds it", () => {
      const members = ["./packages/connectors", "./packages/connectors/github"];
      const suites = [suiteHolding("workspace-unit", [
        "packages/connectors/github/test/a.test.ts",
      ])];
      const costs = memberCosts(
        costing({ "packages/connectors/github/test/a.test.ts": 4 }),
        members,
        suites,
      );
      expect(costs.get("packages/connectors/github")!.seconds).toBe(4);
      expect(costs.get("packages/connectors")!.units).toBe(0);
    });
  });

  describe("coverageCosts()", () => {
    const suites = (units: readonly string[]) => [
      suiteHolding("workspace-unit", units),
    ];

    /** What the reports say about one manifest read against one tree. */
    const reportOn = (manifest: Manifest, units: readonly string[]) =>
      coverageCosts(memberCosts(manifest, COST_MEMBERS, suites(units)), 30);

    it("names a covered package whose own tests have grown expensive", () => {
      const report = reportOn(
        costing({ "packages/memory/test/a.test.ts": 45 }),
        ["packages/memory/test/a.test.ts"],
      );
      expect(report.expensive.map((cost) => cost.member))
        .toEqual(["packages/memory"]);
      expect(report.expensive[0]!.seconds).toBe(45);
      expect(report.fitting).toEqual([]);
    });

    it("says nothing about a covered package the run has room for", () => {
      const report = reportOn(
        costing({ "packages/memory/test/a.test.ts": 4 }),
        ["packages/memory/test/a.test.ts"],
      );
      expect(report.expensive).toEqual([]);
    });

    it("names an excluded package the run now has room for", () => {
      // `packages/runner` is listed for what its whole set costs, so a set
      // that now fits is the measurement that takes the line off.
      expect(EXCLUDED_FROM_COVERAGE_GATE.get("packages/runner")!.basis)
        .toBe("cost");
      const report = reportOn(
        costing({ "packages/runner/test/a.test.ts": 4 }),
        ["packages/runner/test/a.test.ts"],
      );
      expect(report.fitting.map((cost) => cost.member))
        .toEqual(["packages/runner"]);
    });

    it("leaves an excluded package alone while its set is still too big", () => {
      const report = reportOn(
        costing({ "packages/runner/test/a.test.ts": 900 }),
        ["packages/runner/test/a.test.ts"],
      );
      expect(report.fitting).toEqual([]);
      // Nothing follows from an excluded package being expensive either:
      // the gate already leaves it alone.
      expect(report.expensive).toEqual([]);
    });

    it("waits for the whole of an excluded package's set to be measured", () => {
      // A line would otherwise come off the list on the strength of a set
      // whose cost is not all known.
      const report = reportOn(
        costing({ "packages/runner/test/a.test.ts": 4 }),
        ["packages/runner/test/a.test.ts", "packages/runner/test/b.test.ts"],
      );
      expect(report.fitting).toEqual([]);
    });

    it("says nothing about an excluded package with no set to measure", () => {
      expect(reportOn(sampleManifest({ entries: [] }), []).fitting).toEqual([]);
    });

    it("waits for a browser-only package to gain a Deno test of its own", () => {
      // `packages/identity` is listed for having no Deno-only half. Its
      // browser tests are not one however cheap they are, so the line stays
      // until a `deno test` of its own is measured.
      expect(EXCLUDED_FROM_COVERAGE_GATE.get("packages/identity")!.basis)
        .toBe("absence");
      const units = ["packages/identity"];
      const browser = coverageCosts(
        memberCosts(
          browserCosting({ "packages/identity": 4 }),
          COST_MEMBERS,
          suites(units),
        ),
        30,
      );
      expect(browser.fitting).toEqual([]);
      const deno = reportOn(costing({ "packages/identity": 4 }), units);
      expect(deno.fitting.map((cost) => cost.member))
        .toEqual(["packages/identity"]);
    });

    it("names a package listed for having no tests whatever the one costs", () => {
      // The line claims the package has no Deno-only tests of its own, and
      // a measured one contradicts that however long it takes. Holding it to
      // the figure a covered package is reported at would leave the line
      // standing over a set the store has plainly measured.
      const report = reportOn(
        costing({ "packages/identity": 900 }),
        ["packages/identity"],
      );
      expect(report.fitting.map((cost) => cost.member))
        .toEqual(["packages/identity"]);
    });

    it("counts the covered packages nothing has measured", () => {
      // How much of the corpus the expensive list was chosen from. A covered
      // package the store has never measured cannot be named expensive
      // however much its tests cost.
      const report = reportOn(sampleManifest({ entries: [] }), [
        "packages/memory/test/a.test.ts",
      ]);
      expect(report.unmeasured.map((cost) => cost.member))
        .toEqual(["packages/memory"]);
      expect(report.expensive).toEqual([]);
    });

    it("leaves out a covered package with nothing to measure", () => {
      // A member the topology enumerates no unit for is waiting on no
      // measurement, so counting it would overstate how much of the corpus
      // the expensive list could not speak for.
      const report = reportOn(sampleManifest({ entries: [] }), []);
      expect(report.unmeasured).toEqual([]);
    });

    it("leaves a line resting on a judgement to a person", () => {
      // `packages/patterns` is excluded because its own `deno test` does
      // not measure the pattern files, which no measurement of what those
      // tests cost can contradict.
      expect(EXCLUDED_FROM_COVERAGE_GATE.get("packages/patterns")!.basis)
        .toBe("judgement");
      const unit = "packages/patterns/test/a.test.ts";
      const report = coverageCosts(
        memberCosts(
          costing({ [unit]: 4 }),
          ["./packages/patterns"],
          [suiteHolding("workspace-unit", [unit])],
        ),
        30,
      );
      expect(report.fitting).toEqual([]);
    });
  });
});
