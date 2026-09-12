import assert from "node:assert/strict";
import test from "node:test";
import {
  MasterObstacleProvider,
  type MasterPolicyModel,
  type RaceObservationSource,
} from "../src/agents/master-obstacle-provider.js";
import { RaceEngine } from "../src/domain/race-engine.js";
import type { DisruptionCommand, ObstacleProvider } from "../src/domain/types.js";

const policy: DisruptionCommand = {
  hazardType: "temporary_disable",
  targetRole: "primary-action",
  durationMs: 8_000,
  intensity: 3,
};

function ready(engine: RaceEngine): void {
  for (let index = 1; index <= 4; index += 1) {
    engine.markReady(`racer-${index}`, index);
  }
  engine.start(10);
}

test("selects one immutable tier and applies it independently to all racers", async () => {
  let selections = 0;
  let observations = 0;
  const applied: DisruptionCommand[] = [];
  const model: MasterPolicyModel = {
    async selectObstacle() {
      selections += 1;
      return policy;
    },
    async selectSabotage() {
      selections += 1;
      return { tier: "difficult", policy };
    },
  };
  const observationsSource: RaceObservationSource = {
    async observe() {
      observations += 1;
      return {
        raceId: "race-1",
        checkpoint: 1,
        racers: [],
      };
    },
  };
  const executor: Pick<ObstacleProvider, "apply"> = {
    async apply(_racerId, selected) {
      applied.push(selected);
      return { applied: true };
    },
  };
  const provider = new MasterObstacleProvider(model, observationsSource, executor);
  const plan = await provider.armRace({
    raceId: "race-1",
    courseId: "course-1",
    seed: "seed-1",
    checkpointCount: 3,
    trigger: {
      kind: "target_opened",
      checkpoint: 1,
      milestone: "first_verified_checkpoint",
    },
  });
  assert.equal(plan?.tier, "difficult");
  assert.equal(selections, 1);
  assert.equal(observations, 1);

  const engine = new RaceEngine({
    raceId: "race-1",
    courseId: "course-1",
    seed: "seed-1",
    checkpointCount: 3,
  }, { obstacleProvider: provider });
  engine.armSabotage(plan!);
  ready(engine);
  await Promise.all(
    ["racer-1", "racer-2", "racer-3", "racer-4"].map((racerId) =>
      engine.reachCheckpoint(racerId, 1, 20),
    ),
  );

  assert.equal(applied.length, 4);
  assert.equal(applied.every((selected) => selected === engine.race.sabotagePlan?.policy), true);
  assert.equal(engine.events.filter((event) => event.type === "sabotage_armed").length, 1);
  assert.equal(engine.events.filter((event) => event.type === "sabotage_applied").length, 4);
  engine.markRecovered("racer-1", 21);
  assert.equal(
    engine.events.filter((event) => event.type === "sabotage_recovered").length,
    1,
  );
});

test("deduplicates concurrent reports for one racer", async () => {
  let applications = 0;
  const obstacleProvider: ObstacleProvider = {
    async getPolicy() {
      return null;
    },
    async apply() {
      applications += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { applied: false, reason: "target_not_found" };
    },
  };
  const engine = new RaceEngine({
    raceId: "race-1",
    courseId: "course-1",
    seed: "seed-1",
    checkpointCount: 2,
  }, { obstacleProvider });
  engine.armSabotage({
    raceId: "race-1",
    tier: "basic",
    trigger: { kind: "target_opened", checkpoint: 1, milestone: "first_verified_checkpoint" },
    policy: {
      hazardType: "blocking_modal",
      targetRole: "primary-action",
      durationMs: 1_000,
      intensity: 1,
    },
    selectedAt: 1,
    source: "fallback",
  });
  ready(engine);

  const results = await Promise.all([
    engine.reachCheckpoint("racer-1", 1, 20),
    engine.reachCheckpoint("racer-1", 1, 20),
  ]);
  assert.equal(applications, 1);
  assert.deepEqual(results[1], { claimed: false, obstacleApplied: false });
  assert.equal(engine.events.some((event) => event.type === "sabotage_misfired"), true);
});

test("recovers only when the agent manually clears persistent sabotage", async () => {
  const obstacleProvider: ObstacleProvider = {
    async getPolicy() {
      return null;
    },
    async apply() {
      return { applied: true };
    },
  };
  const engine = new RaceEngine({
    raceId: "race-recovery",
    courseId: "course-1",
    seed: "seed-1",
    checkpointCount: 2,
  }, { obstacleProvider });
  engine.armSabotage({
    raceId: "race-recovery",
    tier: "basic",
    trigger: { kind: "target_opened", checkpoint: 1, milestone: "first_verified_checkpoint" },
    policy: {
      hazardType: "blocking_modal",
      targetRole: "primary-action",
      durationMs: 1_000,
      intensity: 1,
    },
    selectedAt: 1,
    source: "fallback",
  });
  ready(engine);

  await engine.reachCheckpoint("racer-1", 1, 20);
  assert.equal(engine.racers.get("racer-1")?.status, "recovering");
  engine.tick(1_020);
  assert.equal(engine.racers.get("racer-1")?.status, "recovering");
  engine.markRecovered("racer-1", 1_020);
  assert.equal(engine.racers.get("racer-1")?.status, "running");
  assert.equal(
    engine.events.filter((event) => event.type === "sabotage_recovered").length,
    1,
  );
});

test("uses a deterministic fallback without model or provider keys", async () => {
  const model: MasterPolicyModel = {
    async selectObstacle() {
      throw new Error("model unavailable");
    },
  };
  const provider = new MasterObstacleProvider(model, {
    async observe() {
      throw new Error("observation unavailable");
    },
  }, {
    async apply() {
      return { applied: false };
    },
  });

  const first = await provider.armRace({
    raceId: "race-fallback",
    courseId: "course-1",
    seed: "stable-seed",
    checkpointCount: 2,
    trigger: { kind: "target_opened", checkpoint: 1, milestone: "first_verified_checkpoint" },
  });
  assert.equal(first?.source, "fallback");
  assert.ok(["basic", "intermediate", "difficult"].includes(first?.tier ?? ""));
  assert.equal(first?.policy.targetRole, "primary-action");
});
