import assert from "node:assert/strict";
import test from "node:test";
import { RaceEngine } from "../src/domain/race-engine.js";
import type {
  DisruptionCommand,
  DisruptionResult,
  ObstacleProvider,
  SabotagePlan,
} from "../src/domain/types.js";

const policy: DisruptionCommand = {
  hazardType: "blocking_modal",
  targetRole: "primary-action",
  durationMs: 4_000,
  intensity: 2,
};

class FakeObstacles implements ObstacleProvider {
  applied: string[] = [];

  constructor(private readonly result: DisruptionResult | Error = { applied: true }) {}

  async getPolicy(): Promise<DisruptionCommand | null> {
    return policy;
  }

  async apply(racerId: string): Promise<DisruptionResult> {
    this.applied.push(racerId);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

function plan(checkpoint = 1): SabotagePlan {
  return {
    raceId: "race-1",
    tier: "intermediate",
    trigger: { kind: "target_opened", checkpoint, milestone: "first_verified_checkpoint" },
    policy,
    selectedAt: 0,
    source: "fallback",
  };
}

function readyRace(
  provider: ObstacleProvider,
  options: { checkpointCount?: number; trigger?: number | null } = {},
) {
  const race = new RaceEngine(
    {
      raceId: "race-1",
      courseId: "course-1",
      seed: "seed-1",
      checkpointCount: options.checkpointCount ?? 3,
      now: 0,
    },
    { obstacleProvider: provider },
  );
  if (options.trigger !== null) race.armSabotage(plan(options.trigger ?? 1), 5);
  for (let index = 1; index <= 4; index += 1) {
    race.markReady(`racer-${index}`, 10);
  }
  race.start(100);
  return race;
}

function eventTypes(race: RaceEngine): string[] {
  return race.events.map((event) => event.type);
}

test("emits sabotage_applied and remains in recovery until manually cleared", async () => {
  const race = readyRace(new FakeObstacles());
  const result = await race.reachCheckpoint("racer-1", 1, 1_000);
  assert.deepEqual(result, { claimed: true, obstacleApplied: true });

  assert.deepEqual(eventTypes(race).slice(-3), [
    "checkpoint_reached",
    "sabotage_triggered",
    "sabotage_applied",
  ]);
  const applied = race.events.at(-1);
  assert.equal(applied?.racerId, "racer-1");
  assert.equal(applied?.checkpoint, 1);
  assert.deepEqual(applied?.metadata, { tier: "intermediate", policy });
  const racer = race.racers.get("racer-1");
  assert.equal(racer?.status, "recovering");
  assert.equal(racer?.recoverAt, undefined);

  race.tick(4_999);
  assert.equal(racer?.status, "recovering");
  race.tick(5_000);
  assert.equal(racer?.status, "recovering");
  race.markRecovered("racer-1", 5_000);
  assert.equal(racer?.status, "running");
  const recovered = race.events.at(-1);
  assert.equal(recovered?.type, "sabotage_recovered");
  assert.equal(recovered?.racerId, "racer-1");
  assert.equal(recovered?.occurredAt, 5_000);
  assert.deepEqual(recovered?.metadata, { checkpoint: 1, cause: "manual" });

  race.tick(6_000);
  assert.equal(eventTypes(race).filter((type) => type === "sabotage_recovered").length, 1);
});

test("emits sabotage_misfired and keeps the racer running", async () => {
  const race = readyRace(new FakeObstacles({ applied: false, reason: "target_not_found" }));
  const result = await race.reachCheckpoint("racer-2", 1, 1_000);
  assert.deepEqual(result, { claimed: true, obstacleApplied: false });
  const misfired = race.events.at(-1);
  assert.equal(misfired?.type, "sabotage_misfired");
  assert.equal(misfired?.metadata?.reason, "target_not_found");
  assert.equal(race.racers.get("racer-2")?.status, "running");
});

test("treats a throwing obstacle executor as a misfire", async () => {
  const race = readyRace(new FakeObstacles(new Error("cdp timeout")));
  const result = await race.reachCheckpoint("racer-1", 1, 1_000);
  assert.deepEqual(result, { claimed: true, obstacleApplied: false });
  assert.equal(race.events.at(-1)?.type, "sabotage_misfired");
  assert.equal(race.events.at(-1)?.metadata?.reason, "cdp timeout");
  assert.equal(race.racers.get("racer-1")?.checkpoint, 1);
});

test("fires only at the trigger checkpoint, once per racer", async () => {
  const provider = new FakeObstacles({ applied: false });
  const race = readyRace(provider, { trigger: 2 });
  await race.reachCheckpoint("racer-1", 1, 1_000);
  assert.deepEqual(provider.applied, []);
  await race.reachCheckpoint("racer-1", 2, 1_100);
  await race.reachCheckpoint("racer-2", 1, 1_200);
  await race.reachCheckpoint("racer-2", 2, 1_300);
  await race.reachCheckpoint("racer-1", 3, 1_400);
  assert.deepEqual(provider.applied, ["racer-1", "racer-2"]);
  assert.equal(eventTypes(race).filter((type) => type === "sabotage_triggered").length, 2);
});

test("armSabotage rejects a trigger outside the course", () => {
  const race = new RaceEngine({ raceId: "race-1", courseId: "c", seed: "s", checkpointCount: 2 });
  assert.throws(() => race.armSabotage(plan(3)), /outside the course/);
});

test("a recovering racer cannot reach a checkpoint or finish until manually recovered", async () => {
  const race = readyRace(new FakeObstacles(), { checkpointCount: 1 });
  await race.reachCheckpoint("racer-3", 1, 1_000);
  assert.equal(race.racers.get("racer-3")?.status, "recovering");
  assert.throws(() => race.finishRacer("racer-3", 2_000), /cannot finish while recovering/);

  const other = readyRace(new FakeObstacles());
  await other.reachCheckpoint("racer-1", 1, 1_000);
  await assert.rejects(
    other.reachCheckpoint("racer-1", 2, 2_000),
    /cannot reach a checkpoint while recovering/,
  );
  // Time does not clear persistent sabotage.
  await assert.rejects(
    other.reachCheckpoint("racer-1", 2, 5_000),
    /cannot reach a checkpoint while recovering/,
  );
  other.markRecovered("racer-1", 5_000);
  await other.reachCheckpoint("racer-1", 2, 5_001);
  assert.equal(other.racers.get("racer-1")?.checkpoint, 2);

  race.markRecovered("racer-3", 5_000);
  assert.equal(race.finishRacer("racer-3", 5_000), true);
  assert.deepEqual(eventTypes(race).slice(-3), ["sabotage_recovered", "racer_finished", "race_finished"]);
});

test("markRecovered emits a manual recovery only on a status change", async () => {
  const race = readyRace(new FakeObstacles());
  race.markRecovered("racer-1", 500);
  assert.equal(eventTypes(race).includes("sabotage_recovered"), false);

  await race.reachCheckpoint("racer-1", 1, 1_000);
  race.markRecovered("racer-1", 1_500);
  race.markRecovered("racer-1", 1_600);
  const recoveries = race.events.filter((event) => event.type === "sabotage_recovered");
  assert.equal(recoveries.length, 1);
  assert.deepEqual(recoveries[0].metadata, { checkpoint: 1, cause: "manual" });
  assert.equal(recoveries[0].occurredAt, 1_500);
});

test("does not recover racers by duration once the race is over", async () => {
  const race = readyRace(new FakeObstacles(), { checkpointCount: 1 });
  await race.reachCheckpoint("racer-2", 1, 1_000);
  await race.reachCheckpoint("racer-1", 1, 1_500);
  race.markRecovered("racer-1", 1_600);
  assert.equal(race.finishRacer("racer-1", 2_000), true);

  const before = race.events.length;
  race.tick(10_000);
  assert.equal(race.events.length, before);
  assert.equal(race.racers.get("racer-2")?.status, "recovering");
});

test("no sabotage fires after hazards freeze", async () => {
  const provider = new FakeObstacles();
  const race = readyRace(provider);
  race.tick(180_100);
  await race.reachCheckpoint("racer-1", 1, 180_200);
  assert.deepEqual(provider.applied, []);
  assert.equal(eventTypes(race).includes("sabotage_applied"), false);
});

test("the safety cap records its reason", () => {
  const race = readyRace(new FakeObstacles());
  race.tick(300_100);
  assert.deepEqual(race.events.at(-1)?.metadata, { reason: "absolute_deadline" });
});

test("abort times out an unstarted race with a reason", () => {
  const race = new RaceEngine({
    raceId: "race-2",
    courseId: "course-1",
    seed: "seed-1",
    checkpointCount: 3,
    now: 0,
  });
  race.markReady("racer-1", 5);

  assert.equal(race.abort("start_failed", 50), true);
  assert.equal(race.race.status, "timed_out");
  assert.deepEqual(
    [...race.racers.values()].map((racer) => racer.status),
    ["timed_out", "timed_out", "timed_out", "timed_out"],
  );
  const event = race.events.at(-1);
  assert.equal(event?.type, "race_timed_out");
  assert.equal(event?.occurredAt, 50);
  assert.deepEqual(event?.metadata, { reason: "start_failed" });

  assert.equal(race.abort("again", 60), false);
  assert.equal(race.events.filter((item) => item.type === "race_timed_out").length, 1);
});

test("abort leaves a finished race and its winner alone", async () => {
  const race = readyRace(new FakeObstacles({ applied: false }), { checkpointCount: 1 });
  await race.reachCheckpoint("racer-1", 1, 1_000);
  race.finishRacer("racer-1", 2_000);
  assert.equal(race.abort("late", 3_000), false);
  assert.equal(race.race.status, "finished");
  assert.equal(race.racers.get("racer-1")?.status, "finished");
});

test("abort times out a recovering racer and clears recoverAt", async () => {
  const race = readyRace(new FakeObstacles(), { checkpointCount: 1 });
  await race.reachCheckpoint("racer-1", 1, 1_000);
  race.abort("operator", 1_500);
  assert.equal(race.racers.get("racer-1")?.status, "timed_out");
  assert.equal(race.racers.get("racer-1")?.recoverAt, undefined);
});
