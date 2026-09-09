/**
 * The one coverage gate a run of part of the corpus can still hold.
 *
 * Gating on the repository's whole coverage number cannot survive
 * selection: a pull request that runs a fifth of the test time measures a
 * fifth of the coverage, and there is no threshold that rescues that
 * comparison. Take a package that owns its own unit tests, score only
 * that package's source, and count as covered only what those tests
 * reached, and the comparison is honest again. Run every one of those
 * tests and the measurement is complete, whatever selection did anywhere
 * else in the run.
 *
 * This module decides which packages a change puts under that gate. What
 * the lanes then measure and what `Status` does with the totals rest on
 * the answer, and both ask this rather than each other.
 */

import { BROWSER_SUFFIX } from "../test-topology/unit.ts";
import { type Suite, unavailableUnits } from "../test-topology/suite.ts";
import type { Manifest } from "./manifest.ts";
import {
  EXCLUDED_FROM_COVERAGE_GATE,
  LOCAL_COVERAGE_MAX_PACKAGES,
  LOCAL_COVERAGE_MAX_SECONDS,
} from "./policy.ts";

/** The suites whose units are a member's own tests. */
export const UNIT_SUITES: readonly string[] = ["workspace-unit", "runner-unit"];

/** How a member's coverage report is named, from the member's path. */
export function memberSlug(member: string): string {
  return member.replace(/^\.\//, "").replace(/^packages\//, "")
    .replaceAll("/", "__");
}

/**
 * The workspace members the gate covers: every member under `packages/`
 * that the exclusion list does not name.
 *
 * Membership follows the workspace rather than a path depth, so a package
 * nested three deep is covered on the same terms as one nested one, and a
 * new package is covered from the moment it is a member.
 */
export function coveredMembers(members: readonly string[]): string[] {
  return packageMembers(members)
    .filter((member) => !EXCLUDED_FROM_COVERAGE_GATE.has(member));
}

/** Every workspace member under `packages/`, gated or not. */
export function packageMembers(members: readonly string[]): string[] {
  return members
    .map((member) => member.replace(/^\.\//, ""))
    .filter((member) => member.startsWith("packages/"))
    .sort();
}

/**
 * The member a path belongs to, which is the deepest member containing
 * it: `packages/connectors/github/src/x.ts` belongs to the connector
 * rather than to a `packages/connectors` that happens to be a member too.
 * A path that is a member is that member, which is how a member running
 * whole names its own unit.
 */
function owningMember(
  members: readonly string[],
  path: string,
): string | undefined {
  let deepest: string | undefined;
  for (const member of members) {
    if (path !== member && !path.startsWith(`${member}/`)) continue;
    if (deepest === undefined || member.length > deepest.length) {
      deepest = member;
    }
  }
  return deepest;
}

/**
 * The covered members a change reaches, by the files it touched.
 *
 * A file belongs to the deepest member that contains it, so a change to
 * `packages/connectors/github/src/x.ts` reaches
 * `packages/connectors/github` rather than a `packages/connectors` that
 * happens to be a member too.
 */
export function membersTouched(
  members: readonly string[],
  changed: ReadonlySet<string>,
): string[] {
  const covered = coveredMembers(members);
  const touched = new Set<string>();
  for (const file of changed) {
    const member = owningMember(covered, file);
    if (member !== undefined) touched.add(member);
  }
  return [...touched].sort();
}

/** What the gate has to say about one change. */
export interface CoverageGate {
  /** The members whose whole measured set runs, and which are gated. */
  members: string[];

  /** Why the gate did not run, where it did not. */
  off?: string;
}

/**
 * Which members a change puts under the gate.
 *
 * A change touching more than `LOCAL_COVERAGE_MAX_PACKAGES` covered
 * packages turns the gate off entirely rather than gating some of them.
 * The mandatory set a covered package adds is its whole measured test
 * set, so a sweeping change would spend most of a run re-running suites
 * it barely touched; and "did this leave more untested" stops being a
 * question about one thing somebody can look at once it spans four
 * packages. Gating two of the four would mean quietly ignoring the other
 * two, and a cliff is at least predictable: an author can tell from the
 * diff whether the gate applies.
 */
export function coverageGate(
  members: readonly string[],
  changed: ReadonlySet<string>,
  cap: number = LOCAL_COVERAGE_MAX_PACKAGES,
): CoverageGate {
  const touched = membersTouched(members, changed);
  if (touched.length > cap) {
    return {
      members: [],
      off: `the change touches ${touched.length} covered packages, more ` +
        `than the ${cap} a gated change may touch: ${touched.join(", ")}`,
    };
  }
  return { members: touched };
}

/**
 * The units that make up the measured set of the members under the gate.
 *
 * Only a member's own Deno-only tests measure it, so the browser half is
 * left out: it produces no coverage of the source the gate scores, and
 * making it mandatory would run a browser for a figure it cannot move.
 */
export function measuredUnits(
  suiteId: string,
  units: readonly string[],
  members: ReadonlySet<string>,
): string[] {
  if (!UNIT_SUITES.includes(suiteId) || members.size === 0) return [];
  return units.filter((unit) => {
    if (unit.endsWith(BROWSER_SUFFIX)) return false;
    for (const member of members) {
      if (unit === member || unit.startsWith(`${member}/`)) return true;
    }
    return false;
  });
}

/** What one workspace member's own measured test set costs. */
export interface MemberCost {
  member: string;

  /**
   * Seconds the batch holding exactly this set costs: the identities' own
   * measured time through their suite's fitted correction, plus that
   * suite's overhead and each unit's own overhead. The packer's own batch
   * cost, over the same measurements it packs against.
   *
   * A lane pays capability setup on top, once per capability it opens
   * however many batches want it, so that charge belongs to the lane
   * rather than to any one member's set and is not here. Units the store
   * has nothing for cost nothing, and `measured` beside `units` is how
   * far a figure reaches.
   */
  seconds: number;

  /** Deno-only units the topology enumerates for the member. */
  units: number;

  /** How many of those the newest manifest has a measurement for. */
  measured: number;
}

/**
 * What each workspace member under `packages/` costs, from the store.
 *
 * The units come from the tree and the seconds from the manifest, which
 * is what tells a member nothing has ever recorded apart from one whose
 * set is genuinely empty. A member with units the manifest holds nothing
 * for is measured in part, and the difference between the two counts is
 * how far.
 */
export function memberCosts(
  manifest: Manifest,
  members: readonly string[],
  suites: readonly Suite[],
): Map<string, MemberCost> {
  const packages = packageMembers(members);
  const costs = new Map<string, MemberCost>();
  for (const member of packages) {
    costs.set(member, { member, seconds: 0, units: 0, measured: 0 });
  }
  const owner = new Map<string, string>();
  for (const suite of suites) {
    if (!UNIT_SUITES.includes(suite.id)) continue;
    const unavailable = unavailableUnits(suite);
    for (const unit of suite.units) {
      if (unit.endsWith(BROWSER_SUFFIX) || unavailable.has(unit)) continue;
      const member = owningMember(packages, unit);
      if (member === undefined) continue;
      owner.set(unit, member);
      costs.get(member)!.units++;
    }
  }
  // Own time per member and suite, so that each suite's fitted correction
  // and overhead reach the part of the set that suite runs, beside the
  // units the member was measured over.
  const measured = new Map<
    string,
    { bySuite: Map<string, number>; units: Set<string> }
  >();
  for (const entry of manifest.entries) {
    if (!UNIT_SUITES.includes(entry.suite)) continue;
    // A test the browser harness ran is not part of the Deno-only half
    // whatever unit it was placed on. A member that names a browser half
    // has one of its own to place them in; a member whose whole test task
    // is the harness does not, and the gate has nothing to measure there.
    if (entry.test.k === "browser") continue;
    // A unit the manifest names and the tree no longer enumerates is work
    // no lane can be asked to do, so it costs the member nothing.
    const member = owner.get(entry.unit);
    if (member === undefined) continue;
    let held = measured.get(member);
    if (held === undefined) {
      held = { bySuite: new Map(), units: new Set() };
      measured.set(member, held);
    }
    held.bySuite.set(
      entry.suite,
      (held.bySuite.get(entry.suite) ?? 0) + entry.cost,
    );
    held.units.add(entry.unit);
  }
  for (const [member, held] of measured) {
    const cost = costs.get(member)!;
    for (const [suite, seconds] of held.bySuite) {
      const fitted = manifest.calibration.suites[suite];
      cost.seconds += (fitted?.overhead ?? 0) +
        seconds * (fitted?.correction ?? 1);
    }
    for (const unit of held.units) {
      cost.seconds += manifest.calibration.unitOverhead[unit] ?? 0;
    }
    cost.measured = held.units.size;
  }
  return costs;
}

/**
 * What a member's own tests cost, as a person reads it.
 *
 * A member the topology enumerates no Deno-only unit for has nothing for
 * the gate to measure at all, which is a different thing from a member it
 * does and the store holds nothing for. A figure that reaches part of a
 * set says how far, because that is what decides how much it is worth.
 */
export function costPhrase(cost: MemberCost | undefined): string {
  if (cost === undefined || cost.units === 0) return "no tests";
  if (cost.measured === 0) return "unmeasured";
  const seconds = `${cost.seconds.toFixed(1)}s`;
  return cost.measured === cost.units
    ? `${seconds} over ${cost.units} unit(s)`
    : `${seconds} over ${cost.measured} of ${cost.units} unit(s)`;
}

/** What the run's own measurements say about the exclusion list. */
export interface CoverageCostReport {
  /**
   * Covered members whose own tests cost more than a package should.
   * Somebody decides whether to split the tests, let the run carry the
   * cost, or add a line to the exclusion list.
   */
  expensive: MemberCost[];

  /**
   * Excluded members the store now contradicts. A line resting on what a
   * package costs is here once the whole of its set is measured and fits;
   * a line resting on the package having no Deno-only tests is here once
   * the store has measured one.
   */
  fitting: MemberCost[];

  /**
   * Covered members whose own units the store has no measurement of,
   * which is how much of the corpus `expensive` was chosen from. A member
   * the topology enumerates no Deno-only unit for is not here: it has
   * nothing to measure, which is a different thing from nothing having
   * measured it, and no measurement will ever arrive to take it off.
   */
  unmeasured: MemberCost[];
}

/**
 * What the newest measurements say about which packages carry the gate.
 *
 * A partly measured member is never reported as one the run has room for.
 * A line would otherwise come off the exclusion list on the strength of a
 * set whose cost is not all known. The other direction needs no such
 * care: a set already past the bound is past it whatever the unmeasured
 * rest costs.
 */
export function coverageCosts(
  costs: ReadonlyMap<string, MemberCost>,
  max: number = LOCAL_COVERAGE_MAX_SECONDS,
): CoverageCostReport {
  const report: CoverageCostReport = {
    expensive: [],
    fitting: [],
    unmeasured: [],
  };
  for (const cost of costs.values()) {
    const excluded = EXCLUDED_FROM_COVERAGE_GATE.get(cost.member);
    if (excluded === undefined) {
      if (cost.seconds > max) report.expensive.push(cost);
      else if (cost.units > 0 && cost.measured === 0) {
        report.unmeasured.push(cost);
      }
      continue;
    }
    const whole = cost.units > 0 && cost.measured === cost.units;
    const contradicted = excluded.basis === "cost"
      ? whole && cost.seconds <= max
      : excluded.basis === "absence" && cost.measured > 0;
    if (contradicted) report.fitting.push(cost);
  }
  return report;
}
