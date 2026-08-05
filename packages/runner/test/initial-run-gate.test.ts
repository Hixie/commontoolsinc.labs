import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { createInitialRunGate } from "../src/scheduler/initial-run-gate.ts";

// A run given an initial-run gate defers every action registration it
// creates — its own action nodes and those of nested child runs — until the
// gate releases; event handler registration does not defer. A gate settles
// exactly once, as released or as cancelled. These tests drive the gate
// directly and observe the runner.

const signer = await Identity.fromPassphrase("initial run gate");
const space = signer.did();

describe("a run with an initial-run gate", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("schedules none of the run's actions until the gate releases", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    let liftRuns = 0;
    const doubler = lift((value: number) => {
      liftRuns++;
      return value * 2;
    });
    const rootPattern = pattern<{ source: number }>(({ source }) => ({
      doubled: doubler(source),
    }));

    const gate = createInitialRunGate();
    const setupTx = runtime.edit();
    const resultCell = runtime.getCell<{ doubled: number }>(
      space,
      "gated run",
      undefined,
      setupTx,
    );
    runtime.runner.run(setupTx, rootPattern, { source: 2 }, resultCell, {
      initialRunGate: gate.gate,
    });
    await setupTx.commit();

    // A consumer demanding the output while the gate is pending sees nothing:
    // the computation that would produce it is not registered yet.
    const seenDoubled = Promise.withResolvers<void>();
    const stopWatching = resultCell.key("doubled").sink((value) => {
      if (value === 4) seenDoubled.resolve();
    });
    await runtime.idle();
    expect(liftRuns).toBe(0);

    gate.release();
    await seenDoubled.promise;
    expect(liftRuns).toBeGreaterThan(0);
    stopWatching();
  });

  it("defers a nested child pattern's actions behind the same gate", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    let liftRuns = 0;
    const tripler = lift((value: number) => {
      liftRuns++;
      return value * 3;
    });
    const childPattern = pattern<{ source: number }>(({ source }) => ({
      tripled: tripler(source),
    }));
    const rootPattern = pattern<{ source: number }>(({ source }) => ({
      child: childPattern({ source }),
    }));

    const gate = createInitialRunGate();
    const setupTx = runtime.edit();
    const resultCell = runtime.getCell<{ child: { tripled: number } }>(
      space,
      "gated run with child",
      undefined,
      setupTx,
    );
    runtime.runner.run(setupTx, rootPattern, { source: 2 }, resultCell, {
      initialRunGate: gate.gate,
    });
    await setupTx.commit();

    const seenTripled = Promise.withResolvers<void>();
    const stopWatching = resultCell.key("child").key("tripled").sink(
      (value) => {
        if (value === 6) seenTripled.resolve();
      },
    );
    await runtime.idle();
    expect(liftRuns).toBe(0);

    gate.release();
    await seenTripled.promise;
    expect(liftRuns).toBeGreaterThan(0);
    stopWatching();
  });

  it("never runs a gated action when the gate is cancelled", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    let liftRuns = 0;
    const doubler = lift((value: number) => {
      liftRuns++;
      return value * 2;
    });
    const rootPattern = pattern<{ source: number }>(({ source }) => ({
      doubled: doubler(source),
    }));

    const gate = createInitialRunGate();
    const setupTx = runtime.edit();
    const resultCell = runtime.getCell<{ doubled: number }>(
      space,
      "cancelled gated run",
      undefined,
      setupTx,
    );
    runtime.runner.run(setupTx, rootPattern, { source: 2 }, resultCell, {
      initialRunGate: gate.gate,
    });
    await setupTx.commit();

    gate.cancel();
    // A settled gate stays settled: releasing afterwards changes nothing.
    gate.release();
    await runtime.idle();
    expect(liftRuns).toBe(0);
    expect(resultCell.key("doubled").get()).toBe(undefined);

    // The run itself still tears down through the normal path.
    runtime.runner.stop(resultCell);
    await runtime.idle();
    expect(liftRuns).toBe(0);
  });
});
