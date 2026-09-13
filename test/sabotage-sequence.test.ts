import assert from "node:assert/strict";
import test from "node:test";
import { MasterObstacleProvider, type MasterPolicyModel, type RaceObservationSource } from "../src/agents/master-obstacle-provider.js";
import { RaceEngine } from "../src/domain/race-engine.js";
import type { DisruptionCommand, DisruptionResult, ObstacleProvider, SabotagePlan } from "../src/domain/types.js";

const policies: DisruptionCommand[] = [
  { hazardType: "move_primary_action", targetRole: "primary-action", durationMs: 100, intensity: 1 },
  { hazardType: "insert_decoy", targetRole: "primary-action", durationMs: 100, intensity: 1 },
  { hazardType: "temporary_disable", targetRole: "primary-action", durationMs: 100, intensity: 2 },
];

class SequenceObstacles implements ObstacleProvider {
  readonly applied: Array<{ racerId: string; policy: DisruptionCommand }> = [];

  async getPolicy(): Promise<DisruptionCommand | null> {
    return null;
  }

  async apply(racerId: string, policy: DisruptionCommand): Promise<DisruptionResult> {
    this.applied.push({ racerId, policy });
    return { applied: true };
  }
}

function sequencePlan(): SabotagePlan {
  return {
    raceId: "sequence-race",
    tier: "basic",
    trigger: { kind: "target_opened", checkpoint: 2, milestone: "first_verified_checkpoint" },
    policy: policies[0],
    selectedAt: 0,
    source: "model",
    steps: policies.slice(0, 2).map((policy, index) => ({
      stepId: `preset-${index + 1}`,
      checkpoint: index + 2,
      tier: index === 2 ? "intermediate" : "basic",
      policy,
      selectedAt: 0,
    })),
  };
}

function readyRace(provider: ObstacleProvider): RaceEngine {
  const race = new RaceEngine({
    raceId: "sequence-race",
    courseId: "course",
    seed: "seed",
    checkpointCount: 4,
  }, { obstacleProvider: provider });
  race.armSabotage(sequencePlan(), 0);
  for (let index = 1; index <= 4; index += 1) race.markReady(`racer-${index}`, 0);
  race.start(0);
  return race;
}

test("ordered sabotage steps trigger independently and wait for recovery", async () => {
  const provider = new SequenceObstacles();
  const race = readyRace(provider);

  await race.reachCheckpoint("racer-1", 1, 1);
  await race.reachCheckpoint("racer-1", 2, 2);
  assert.equal(provider.applied[0]?.policy.disruptionId, "disruption-sequence-race-racer-1-1-preset-1");
  await assert.rejects(
    () => race.reachCheckpoint("racer-1", 3, 3),
    /cannot reach a checkpoint while recovering/,
  );

  race.markRecovered("racer-1", 102);
  await race.reachCheckpoint("racer-1", 3, 103);
  race.markRecovered("racer-1", 202);
  await race.reachCheckpoint("racer-1", 4, 203);
  await race.reachCheckpoint("racer-2", 1, 204);
  await race.reachCheckpoint("racer-2", 2, 205);

  assert.deepEqual(
    provider.applied.map(({ racerId, policy }) => [racerId, policy.disruptionId]),
    [
      ["racer-1", "disruption-sequence-race-racer-1-1-preset-1"],
      ["racer-1", "disruption-sequence-race-racer-1-2-preset-2"],
      ["racer-2", "disruption-sequence-race-racer-2-1-preset-1"],
    ],
  );
});

test("master chooses one bounded policy at the requested checkpoint", async () => {
  const observations: RaceObservationSource = {
    async observe(raceId, checkpoint) {
      return { raceId, checkpoint, racers: [] };
    },
  };
  const model: MasterPolicyModel = {
    async selectSabotage() {
      return { tier: "basic", policy: policies[0] };
    },
  };
  const provider = new MasterObstacleProvider(model, observations, {
    async apply() { return { applied: true }; },
  });
  const plan = await provider.armRace?.({
    raceId: "master-race",
    courseId: "course",
    seed: "seed",
    checkpointCount: 4,
    trigger: { kind: "target_opened", checkpoint: 2, milestone: "first_verified_checkpoint" },
  });

  assert.equal(plan?.steps, undefined);
  assert.equal(plan?.trigger.checkpoint, 2);
  assert.deepEqual(plan?.policy, policies[0]);
});

