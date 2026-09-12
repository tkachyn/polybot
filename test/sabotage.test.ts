import assert from "node:assert/strict";
import test from "node:test";
import {
  HAZARD_TYPES,
  SabotageObstacleProvider,
  describeHazard,
  describeHazardDetail,
  sabotagePlaceholder,
} from "../src/domain/sabotage.js";
import type {
  DisruptionCommand,
  DisruptionResult,
  ObstacleProvider,
} from "../src/domain/types.js";

const chosen: DisruptionCommand = {
  hazardType: "insert_decoy",
  targetRole: "checkout-submit",
  durationMs: 6_000,
  intensity: 2,
};

class FakeInner implements ObstacleProvider {
  policyCalls: Array<[string, number]> = [];
  applied: Array<[string, DisruptionCommand]> = [];

  constructor(private readonly policy: () => Promise<DisruptionCommand | null>) {}

  async getPolicy(raceId: string, checkpoint: number): Promise<DisruptionCommand | null> {
    this.policyCalls.push([raceId, checkpoint]);
    return this.policy();
  }

  async apply(racerId: string, policy: DisruptionCommand): Promise<DisruptionResult> {
    this.applied.push([racerId, policy]);
    return { applied: true };
  }
}

test("arms a fixed plan policy without asking the inner provider", async () => {
  const inner = new FakeInner(async () => chosen);
  const fixed: DisruptionCommand = {
    hazardType: "blocking_modal",
    targetRole: "primary-action",
    durationMs: 5_000,
    intensity: 1,
  };
  const provider = new SabotageObstacleProvider(inner, {
    checkpoint: 2,
    summary: "Blocking modal covers the page at Checkout",
    policy: fixed,
  });

  assert.equal(provider.armedPolicy(), undefined);
  assert.deepEqual(await provider.arm("race-1"), fixed);
  assert.deepEqual(provider.armedPolicy(), fixed);
  assert.deepEqual(inner.policyCalls, []);
});

test("asks the inner provider once for the plan checkpoint", async () => {
  const inner = new FakeInner(async () => chosen);
  const provider = new SabotageObstacleProvider(inner, { checkpoint: 3, summary: "x" });

  const [first, second] = await Promise.all([provider.arm("race-1"), provider.arm("race-1")]);
  assert.deepEqual(first, chosen);
  assert.deepEqual(second, chosen);
  assert.deepEqual(await provider.getPolicy("race-1", 3), chosen);
  assert.deepEqual(inner.policyCalls, [["race-1", 3]]);
});

test("returns the armed policy only at the plan checkpoint", async () => {
  const inner = new FakeInner(async () => chosen);
  const provider = new SabotageObstacleProvider(inner, { checkpoint: 2, summary: "x" });
  assert.equal(await provider.getPolicy("race-1", 1), null);
  assert.equal(provider.armedPolicy(), undefined);
  assert.deepEqual(await provider.getPolicy("race-1", 2), chosen);
  assert.equal(await provider.getPolicy("race-1", 3), null);
  assert.deepEqual(await provider.apply("racer-4", chosen), { applied: true });
  assert.deepEqual(inner.applied, [["racer-4", chosen]]);
});

test("arms null when the inner provider fails", async () => {
  const inner = new FakeInner(async () => {
    throw new Error("master unavailable");
  });
  const provider = new SabotageObstacleProvider(inner, { checkpoint: 1, summary: "x" });
  assert.equal(await provider.arm("race-1"), null);
  assert.equal(provider.armedPolicy(), null);
  assert.equal(await provider.getPolicy("race-1", 1), null);
  assert.equal(inner.policyCalls.length, 1);
});

test("arms null for an invalid policy", async () => {
  const tooLong = new SabotageObstacleProvider(new FakeInner(async () => null), {
    checkpoint: 1,
    summary: "x",
    policy: { ...chosen, durationMs: 60_000 },
  });
  assert.equal(await tooLong.arm("race-1"), null);

  const unknownHazard = new SabotageObstacleProvider(
    new FakeInner(async () => ({ ...chosen, hazardType: "explode" as "insert_decoy" })),
    { checkpoint: 1, summary: "x" },
  );
  assert.equal(await unknownHazard.arm("race-1"), null);

  const none = new SabotageObstacleProvider(new FakeInner(async () => null), {
    checkpoint: 1,
    summary: "x",
  });
  assert.equal(await none.arm("race-1"), null);
  assert.equal(none.armedPolicy(), null);
});

test("describes hazards in at most 70 characters", () => {
  assert.equal(
    describeHazard(
      { hazardType: "blocking_modal", targetRole: "primary-action", durationMs: 4_000, intensity: 1 },
      "Checkout",
    ),
    "Blocking modal covers the page at Checkout",
  );
  for (const hazardType of HAZARD_TYPES) {
    const summary = describeHazard({ ...chosen, hazardType }, "Checkout");
    assert.ok(summary.length <= 70, summary);
    assert.match(summary, /Checkout$/);
  }
  assert.match(describeHazard(chosen, "Checkout"), /checkout submit/);

  const long = describeHazard(chosen, "A".repeat(100));
  assert.equal(long.length, 70);
  assert.ok(long.endsWith("…"));

  assert.ok(describeHazardDetail(chosen, "Checkout").length <= 280);
  assert.match(describeHazardDetail(chosen, "Checkout"), /6s/);
  assert.equal(sabotagePlaceholder("Checkpoint 2"), "Sabotage armed at Checkpoint 2");
  assert.equal(sabotagePlaceholder("B".repeat(80)).length, 70);
});
