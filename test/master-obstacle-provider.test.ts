import assert from "node:assert/strict";
import test from "node:test";
import {
  MasterObstacleProvider,
  type MasterPolicyModel,
  type RaceObservationSource,
} from "../src/agents/master-obstacle-provider.js";
import type {
  DisruptionCommand,
  ObstacleProvider,
} from "../src/domain/types.js";

const fallback: DisruptionCommand = {
  hazardType: "blocking_modal",
  targetRole: "primary-action",
  durationMs: 5_000,
  intensity: 1,
};

const observations: RaceObservationSource = {
  async observe(raceId, checkpoint) {
    return {
      raceId,
      checkpoint,
      racers: [{ racerId: "racer-1", checkpoint, status: "running" }],
    };
  },
};

const executor: Pick<ObstacleProvider, "apply"> = {
  async apply() {
    return { applied: true };
  },
};

test("returns and applies a validated master policy", async () => {
  const selected: DisruptionCommand = {
    hazardType: "move_primary_action",
    targetRole: "checkout-submit",
    durationMs: 10_000,
    intensity: 2,
  };
  const model: MasterPolicyModel = {
    async selectObstacle() { return selected; },
  };
  const provider = new MasterObstacleProvider(model, observations, executor);

  assert.deepEqual(await provider.getPolicy("race-1", 1), selected);
  assert.deepEqual(await provider.apply("racer-1", selected), { applied: true });
});

test("uses a deterministic fallback when the model fails", async () => {
  const model: MasterPolicyModel = {
    async selectObstacle() { throw new Error("model unavailable"); },
  };
  const provider = new MasterObstacleProvider(
    model,
    observations,
    executor,
    { 1: fallback },
  );

  assert.deepEqual(await provider.getPolicy("race-1", 1), fallback);
});

test("uses fallback when master selection times out", async () => {
  const model: MasterPolicyModel = {
    async selectObstacle() {
      return new Promise<DisruptionCommand>(() => undefined);
    },
  };
  const provider = new MasterObstacleProvider(
    model,
    observations,
    executor,
    { 1: fallback },
    { timeoutMs: 5 },
  );

  assert.deepEqual(await provider.getPolicy("race-1", 1), fallback);
});
