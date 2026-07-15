import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { shapableWakeGroupKey } from "../src/scheduler/invalidation.ts";

// deno-lint-ignore no-explicit-any
const anyOf = <T>(v: unknown) => v as T;

// The classifier that keys the cell-notification token bucket. Interactive input
// and passive server pushes must land in SEPARATE per-pattern buckets so a chatty
// background source cannot drain the interactive burst.
describe("shapableWakeGroupKey", () => {
  const rendererInputTx = { marker: "renderer-input" };
  const state = anyOf<Parameters<typeof shapableWakeGroupKey>[0]>({
    isRendererInputSource: (source: object | undefined) =>
      source === rendererInputTx,
  });
  const withPiece = anyOf<Parameters<typeof shapableWakeGroupKey>[2]>({
    schedulerObservationIdentity: { pieceId: "space:piece-1" },
  });
  const noPiece = anyOf<Parameters<typeof shapableWakeGroupKey>[2]>({});

  const notif = (type: string, source?: object) =>
    anyOf<Parameters<typeof shapableWakeGroupKey>[1]>({ type, source });

  it("routes a renderer-input commit to the pattern's |input bucket", () => {
    expect(
      shapableWakeGroupKey(state, notif("commit", rendererInputTx), withPiece),
    ).toBe("space:piece-1|input");
  });

  it("routes server pushes (pull / integrate) to a SEPARATE |push bucket", () => {
    expect(shapableWakeGroupKey(state, notif("pull"), withPiece)).toBe(
      "space:piece-1|push",
    );
    expect(shapableWakeGroupKey(state, notif("integrate"), withPiece)).toBe(
      "space:piece-1|push",
    );
  });

  it("does not shape an ordinary internal commit (no renderer-input mark)", () => {
    expect(
      shapableWakeGroupKey(state, notif("commit", { other: true }), withPiece),
    ).toBe(undefined);
  });

  it("does not shape a reader that is not a pattern instance (no pieceId)", () => {
    expect(shapableWakeGroupKey(state, notif("pull"), noPiece)).toBe(undefined);
    expect(
      shapableWakeGroupKey(state, notif("commit", rendererInputTx), noPiece),
    ).toBe(undefined);
  });
});
