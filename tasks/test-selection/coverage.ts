/**
 * Which measured sets a change reaches, and what each of them is called
 * on disk.
 *
 * A measured set is one suite's units over one workspace member's lines.
 * Everything about the coverage gate starts here: the lanes read this to
 * decide what to run whole and what to turn coverage on for, and the job
 * that joins the lanes reads the same function over the same diff rather
 * than trusting what a lane reported.
 */

import {
  coverageMemberDirectory,
  type MeasuredSet,
  reachedByChange,
  type Suite,
  unavailableUnits,
} from "../test-topology/suite.ts";
import { memberScope } from "../test-topology/unit.ts";
import type { Calibration, Manifest, ManifestEntry } from "./manifest.ts";
import {
  COST_WINDOW_DAYS,
  EXCLUDED_FROM_COVERAGE_GATE,
  exclusionKind,
  LANE_BUDGET_SECONDS,
  LANES,
  LOCAL_COVERAGE_MAX_SECONDS,
  LOCAL_COVERAGE_MAX_SETS,
} from "./policy.ts";

/** One measured set, and the suite that declared it. */
export interface MeasuredSetRef {
  suite: string;
  set: MeasuredSet;
}

/**
 * Every measured set the topology declares that this configuration can
 * run, in a stable order.
 *
 * A set every one of whose units the suite declares unavailable is left
 * out. Keeping it would mean scoring a set nothing was required to run,
 * so the count would be whatever some other lane happened to leave in
 * the directory.
 */
export function measuredSets(
  suites: readonly Suite[],
): MeasuredSetRef[] {
  const sets: MeasuredSetRef[] = [];
  for (const suite of suites) {
    const unavailable = unavailableUnits(suite);
    for (const set of suite.measured ?? []) {
      if (set.units.every((unit) => unavailable.has(unit))) continue;
      sets.push({ suite: suite.id, set });
    }
  }
  return sets.sort((a, b) =>
    a.suite.localeCompare(b.suite) || a.set.member.localeCompare(b.set.member)
  );
}

/** Where one measured set's coverage profiles and report live. */
export function measuredSetDirectory(ref: MeasuredSetRef): string {
  return `${ref.suite}/${coverageMemberDirectory(ref.set.member)}`;
}

/** How a measured set is named in a summary or a metric. */
export function measuredSetName(ref: MeasuredSetRef): string {
  return `${ref.suite}/${ref.set.member}`;
}

/** What the coverage gate decided about one change. */
export interface CoverageGateSelection {
  /** The sets the gate runs and scores. Empty where it does not run. */
  sets: MeasuredSetRef[];

  /**
   * Every set the change reached, whether or not the gate runs. The cap
   * below turns the gate off without changing what the change reached,
   * and a summary that could not say what it reached would leave nobody
   * able to tell a capped change from an untouched one.
   */
  reached: MeasuredSetRef[];

  /** Why the gate did not run, where it did not. */
  off?: string;
}

/**
 * Which measured sets a change reaches, and whether the gate runs.
 *
 * The gate is off entirely past the cap rather than off for some of the
 * sets: gating two of the four a change reached would mean quietly
 * ignoring the other two. A cliff is also predictable, so an author can
 * tell from the diff whether the gate applies without knowing what any
 * set's tests cost.
 */
export function coverageGateFor(
  suites: readonly Suite[],
  changed: ReadonlySet<string>,
): CoverageGateSelection {
  const reached = measuredSets(suites)
    .filter((ref) => reachedByChange(ref.set.reachedBy, changed));
  if (reached.length > LOCAL_COVERAGE_MAX_SETS) {
    return {
      sets: [],
      reached,
      off: `the change reaches ${reached.length} measured sets, more than ` +
        `the ${LOCAL_COVERAGE_MAX_SETS} a gated change may reach`,
    };
  }
  return { sets: reached, reached };
}

/**
 * The units one selection makes mandatory, as `suite\tunit` keys.
 *
 * A unit the suite declares unavailable is left out: it does not run, so
 * requiring it would place an identity no invocation would execute.
 */
export function measuredUnitKeys(
  suites: readonly Suite[],
  selection: CoverageGateSelection,
): Set<string> {
  const bySuite = new Map(suites.map((suite) => [suite.id, suite]));
  const keys = new Set<string>();
  for (const ref of selection.sets) {
    const suite = bySuite.get(ref.suite);
    if (suite === undefined) continue;
    const unavailable = unavailableUnits(suite);
    for (const unit of ref.set.units) {
      if (unavailable.has(unit)) continue;
      keys.add(`${ref.suite}\t${unit}`);
    }
  }
  return keys;
}

/** The members one suite measures under a selection. */
export function measuredMembersOf(
  selection: CoverageGateSelection,
  suiteId: string,
): Set<string> {
  return new Set(
    selection.sets
      .filter((ref) => ref.suite === suiteId)
      .map((ref) => ref.set.member),
  );
}

/**
 * Whether a run measures any of a suite's members. The full run measures
 * every suite, because the baselines and the repository-wide trend both
 * come out of it; a pull request measures the suites of the sets its gate
 * scores, and no others.
 */
export function measuresSuite(
  selection: CoverageGateSelection,
  suiteId: string,
  full: boolean,
): boolean {
  return full || measuredMembersOf(selection, suiteId).size > 0;
}

/**
 * What running some entries whole costs a run with coverage on, read from
 * what their suites' batches have cost with coverage on, in the two parts
 * a lane is charged them in.
 */
export interface MeasuredCost {
  /** Each suite's overhead, which every lane holding it pays once. */
  overhead: number;

  /**
   * Each entry's own cost through its suite's correction, and each
   * unit's charge, which are paid once however the entries are spread.
   */
  spread: number;
}

/**
 * What running `entries` whole costs a run with coverage on.
 *
 * Undefined where a suite among them has no such figure, which is every
 * suite until a lane has run one of its batches with coverage on. What
 * it costs without is no answer, being short by whatever instrumenting
 * it costs, and that is the whole of the question.
 */
export function measuredCost(
  calibration: Calibration,
  entries: readonly ManifestEntry[],
): MeasuredCost | undefined {
  const bySuite = new Map<string, ManifestEntry[]>();
  for (const entry of entries) {
    bySuite.set(entry.suite, [...bySuite.get(entry.suite) ?? [], entry]);
  }
  const cost = { overhead: 0, spread: 0 };
  for (const [suite, held] of bySuite) {
    const fitted = calibration.suitesWithCoverage?.[suite];
    if (fitted === undefined) return undefined;
    const units = new Set(held.map((entry) => entry.unit)).size;
    const tests = held.reduce((sum, entry) => sum + entry.cost, 0);
    cost.overhead += fitted.overhead;
    cost.spread += fitted.correction * tests + fitted.unitOverhead * units;
  }
  return cost;
}

/**
 * How many of a run's lanes it takes to hold `cost`, where each lane
 * holding any of it also pays `setup` for the capabilities it needs, or
 * undefined where the run's lanes cannot hold it.
 *
 * Each lane pays the suites' overheads and the setup before running any
 * of it, so the question is whether what is left of the lanes' budgets
 * after those holds the rest. A lane's prologue is already outside its
 * budget.
 */
function lanesHolding(
  cost: MeasuredCost,
  setup: number,
): number | undefined {
  const room = LANE_BUDGET_SECONDS - cost.overhead - setup;
  if (room <= 0) return undefined;
  const lanes = Math.max(1, Math.ceil(cost.spread / room));
  return lanes <= LANES ? lanes : undefined;
}

/**
 * What a publisher says about what measured sets cost with coverage on:
 * each set past `LOCAL_COVERAGE_MAX_SECONDS`, and each member on the
 * exclusion list for its size whose tests would now fit the run's
 * budget. Neither is acted on. Both are decisions about the repository,
 * so they are put in front of a person rather than taken by a threshold.
 *
 * What a set has to fit is the whole run rather than one lane, since its
 * units are packed across lanes like any other mandatory work and the
 * totals meet again afterwards. A set spread over several lanes pays its
 * suites' overheads and its capabilities' setup in each of them, so that
 * is what it is charged.
 *
 * Both read what the lanes have measured batches with coverage on to
 * cost, and until the lanes have run a suite that way nothing here can
 * say what its tests cost, so this says as much rather than judging
 * from a figure that is short by an unknown amount. A set or member with
 * no recorded test is passed over, since nothing is known of its cost
 * either way.
 */
export function measuredCostLines(
  manifest: Manifest,
  suites: readonly Suite[],
): string[] {
  const lines: string[] = [];
  const unfitted = new Set<string>();
  let unjudged = 0;
  const judged = (
    entries: readonly ManifestEntry[],
  ): MeasuredCost | undefined => {
    if (entries.length === 0) return undefined;
    const cost = measuredCost(manifest.calibration, entries);
    if (cost !== undefined) return cost;
    unjudged += 1;
    for (const { suite } of entries) {
      if (manifest.calibration.suitesWithCoverage?.[suite] === undefined) {
        unfitted.add(suite);
      }
    }
    return undefined;
  };
  for (const ref of measuredSets(suites)) {
    const units = new Set(ref.set.units);
    const cost = judged(
      manifest.entries.filter((entry) =>
        entry.suite === ref.suite && units.has(entry.unit)
      ),
    );
    if (cost === undefined) continue;
    const seconds = cost.overhead + cost.spread;
    if (seconds <= LOCAL_COVERAGE_MAX_SECONDS) continue;
    lines.push(
      `${measuredSetName(ref)} costs ${seconds.toFixed(1)}s with coverage ` +
        `on, past LOCAL_COVERAGE_MAX_SECONDS of ` +
        `${LOCAL_COVERAGE_MAX_SECONDS}s. Its member's tests could be ` +
        `split, the run could carry the cost, or the member could go on ` +
        `EXCLUDED_FROM_COVERAGE_GATE.`,
    );
  }
  const needs = new Map(suites.map((suite) => [suite.id, suite.needs]));
  for (const member of EXCLUDED_FROM_COVERAGE_GATE.keys()) {
    if (exclusionKind(member) !== "size") continue;
    // A member's Deno-only tests are the ones its unit suite records
    // under its own scope, and those are what its set would hold.
    const scope = memberScope(member);
    const entries = manifest.entries.filter((entry) =>
      entry.test.k === "unit" && entry.test.s === scope
    );
    const cost = judged(entries);
    if (cost === undefined) continue;
    const capabilities = new Set(
      entries.flatMap((entry) => needs.get(entry.suite) ?? []),
    );
    const setup = [...capabilities].reduce(
      (sum, capability) =>
        sum + (manifest.calibration.setupCost[capability] ?? 0),
      0,
    );
    const lanes = lanesHolding(cost, setup);
    if (lanes === undefined) continue;
    const seconds = cost.spread + lanes * (cost.overhead + setup);
    lines.push(
      `${member} is on EXCLUDED_FROM_COVERAGE_GATE for its size, and its ` +
        `tests now cost ${seconds.toFixed(1)}s with coverage on across ` +
        `${lanes} lane(s), inside the run's ${LANES} lanes of ` +
        `${LANE_BUDGET_SECONDS}s, so its line can come off.`,
    );
  }
  if (unjudged > 0) {
    lines.push(
      `What ${unjudged} measured set(s) or exclusion-list entries cost ` +
        `with coverage on cannot be said yet: no lane has run ` +
        `${[...unfitted].sort().join(", ")} with coverage on in the last ` +
        `${COST_WINDOW_DAYS} day(s).`,
    );
  }
  return lines;
}
