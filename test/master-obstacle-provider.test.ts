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

  assert.deepEqual(await provider.getPolicy("race-1", 1), {
    ...selected,
    targetRole: "primary-action",
  });
  assert.deepEqual(await provider.apply("racer-1", selected), {
    applied: true,
    policy: { ...selected, targetRole: "primary-action" },
  });
});

test("cycles to a different hazard when the selected target is unavailable", async () => {
  const attempts: DisruptionCommand[] = [];
  const cyclingExecutor: Pick<ObstacleProvider, "apply"> = {
    async apply(_racerId, policy) {
      attempts.push(policy);
      return attempts.length === 1
        ? { applied: false, reason: "target_not_found" }
        : { applied: true };
    },
  };
  const provider = new MasterObstacleProvider(
    { async selectObstacle() {
      return { hazardType: "move_primary_action", targetRole: "primary-action", durationMs: 4_000, intensity: 1 };
    } },
    observations,
    cyclingExecutor,
  );

  const result = await provider.apply("racer-1", {
    hazardType: "move_primary_action",
    targetRole: "primary-action",
    durationMs: 4_000,
    intensity: 1,
  });

  assert.equal(result.applied, true);
  assert.equal(result.policy?.hazardType, "blocking_modal");
  assert.deepEqual(attempts.map((attempt) => attempt.hazardType), [
    "move_primary_action",
    "blocking_modal",
  ]);
});

test("cycles after an executor exception instead of losing the sabotage attempt", async () => {
  const attempts: DisruptionCommand[] = [];
  const provider = new MasterObstacleProvider(
    { async selectObstacle() {
      return { hazardType: "move_primary_action", targetRole: "primary-action", durationMs: 4_000, intensity: 1 };
    } },
    observations,
    {
      async apply(_racerId, policy) {
        attempts.push(policy);
        if (attempts.length === 1) throw new Error("CDP session disconnected");
        return { applied: true, policy };
      },
    },
  );

  const result = await provider.apply("racer-1", {
    hazardType: "move_primary_action",
    targetRole: "primary-action",
    durationMs: 4_000,
    intensity: 1,
  });

  assert.equal(result.applied, true);
  assert.equal(result.policy?.hazardType, "blocking_modal");
  assert.deepEqual(attempts.map((attempt) => attempt.hazardType), [
    "move_primary_action",
    "blocking_modal",
  ]);
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
