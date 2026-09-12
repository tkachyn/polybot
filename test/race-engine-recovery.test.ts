import assert from "node:assert/strict";
import test from "node:test";
import { RaceEngine } from "../src/domain/race-engine.js";
import type {
  DisruptionCommand,
  DisruptionResult,
  ObstacleProvider,
} from "../src/domain/types.js";

const policy: DisruptionCommand = {
  hazardType: "blocking_modal",
  targetRole: "primary-action",
  durationMs: 4_000,
  intensity: 2,
};

class FakeObstacles implements ObstacleProvider {
  policyCalls: number[] = [];
  applied: string[] = [];

  constructor(
    private readonly result: DisruptionResult | Error = { applied: true },
    private readonly checkpoints: number[] = [1],
  ) {}

  async getPolicy(_raceId: string, checkpoint: number): Promise<DisruptionCommand | null> {
    this.policyCalls.push(checkpoint);
    return this.checkpoints.includes(checkpoint) ? policy : null;
  }

  async apply(racerId: string): Promise<DisruptionResult> {
    this.applied.push(racerId);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

function readyRace(provider: ObstacleProvider, checkpointCount = 3) {
  const race = new RaceEngine(
    {
      raceId: "race-1",
      courseId: "course-1",
      seed: "seed-1",
      checkpointCount,
      now: 0,
    },
    { obstacleProvider: provider },
  );
  for (let index = 1; index <= 4; index += 1) {
    race.markReady(`racer-${index}`, 10);
  }
  race.start(100);
  return race;
}

function eventTypes(race: RaceEngine): string[] {
  return race.events.map((event) => event.type);
}

test("emits obstacle_applied and enters recovery until the duration elapses", async () => {
  const race = readyRace(new FakeObstacles());
  const result = await race.reachCheckpoint("racer-1", 1, 1_000);
  assert.deepEqual(result, { claimed: true, obstacleApplied: true });

  const applied = race.events.at(-1);
  assert.equal(applied?.type, "obstacle_applied");
  assert.equal(applied?.racerId, "racer-1");
  assert.equal(applied?.checkpoint, 1);
  assert.deepEqual(applied?.metadata, {
    hazardType: "blocking_modal",
    targetRole: "primary-action",
    durationMs: 4_000,
    intensity: 2,
    applied: true,
    reason: null,
  });
  const racer = race.racers.get("racer-1");
  assert.equal(racer?.status, "recovering");
  assert.equal(racer?.recoveringUntil, 5_000);

  race.tick(4_999);
  assert.equal(racer?.status, "recovering");
  race.tick(5_000);
  assert.equal(racer?.status, "running");
  assert.equal(racer?.recoveringUntil, undefined);
  const recovered = race.events.at(-1);
  assert.equal(recovered?.type, "racer_recovered");
  assert.equal(recovered?.racerId, "racer-1");
  assert.equal(recovered?.occurredAt, 5_000);
  assert.deepEqual(recovered?.metadata, { cause: "duration" });

  race.tick(6_000);
  assert.equal(eventTypes(race).filter((type) => type === "racer_recovered").length, 1);
});

test("emits obstacle_applied for a misfire and keeps the racer running", async () => {
  const race = readyRace(new FakeObstacles({ applied: false, reason: "target_not_found" }));
  const result = await race.reachCheckpoint("racer-2", 1, 1_000);
  assert.deepEqual(result, { claimed: true, obstacleApplied: false });
  const applied = race.events.at(-1);
  assert.equal(applied?.type, "obstacle_applied");
  assert.equal(applied?.metadata?.applied, false);
  assert.equal(applied?.metadata?.reason, "target_not_found");
  assert.equal(race.racers.get("racer-2")?.status, "running");
});

test("treats a throwing obstacle executor as a misfire", async () => {
  const race = readyRace(new FakeObstacles(new Error("cdp timeout")));
  const result = await race.reachCheckpoint("racer-1", 1, 1_000);
  assert.deepEqual(result, { claimed: true, obstacleApplied: false });
  assert.equal(race.events.at(-1)?.metadata?.reason, "apply_failed: cdp timeout");
  assert.equal(race.racers.get("racer-1")?.checkpoint, 1);
});

test("fetches each stage policy once and skips checkpoints without one", async () => {
  const provider = new FakeObstacles();
  const race = readyRace(provider);
  await race.reachCheckpoint("racer-1", 1, 1_000);
  await race.reachCheckpoint("racer-2", 1, 1_100);
  await race.reachCheckpoint("racer-2", 2, 1_200);
  assert.deepEqual(provider.policyCalls, [1, 2]);
  assert.deepEqual(provider.applied, ["racer-1", "racer-2"]);
  assert.equal(eventTypes(race).filter((type) => type === "obstacle_applied").length, 2);
});

test("a recovering racer recovers when it reaches the next checkpoint", async () => {
  const race = readyRace(new FakeObstacles());
  await race.reachCheckpoint("racer-1", 1, 1_000);
  await race.reachCheckpoint("racer-1", 2, 2_000);

  assert.equal(race.racers.get("racer-1")?.status, "running");
  const [recovered, reached] = race.events.slice(-2);
  assert.equal(recovered.type, "racer_recovered");
  assert.deepEqual(recovered.metadata, { cause: "checkpoint" });
  assert.equal(recovered.occurredAt, 2_000);
  assert.equal(reached.type, "checkpoint_reached");
  assert.equal(reached.checkpoint, 2);
});

test("a recovering racer recovers when it finishes", async () => {
  const race = readyRace(new FakeObstacles(), 1);
  await race.reachCheckpoint("racer-3", 1, 1_000);
  assert.equal(race.racers.get("racer-3")?.status, "recovering");

  assert.equal(race.finishRacer("racer-3", 2_000), true);
  const types = eventTypes(race).slice(-3);
  assert.deepEqual(types, ["racer_recovered", "racer_finished", "race_finished"]);
  assert.deepEqual(race.events.at(-3)?.metadata, { cause: "finish" });
  assert.equal(race.racers.get("racer-3")?.status, "finished");
});

test("markRecovered emits a manual recovery only on a status change", async () => {
  const race = readyRace(new FakeObstacles());
  race.markRecovered("racer-1", 500);
  assert.equal(eventTypes(race).includes("racer_recovered"), false);

  await race.reachCheckpoint("racer-1", 1, 1_000);
  race.markRecovered("racer-1", 1_500);
  race.markRecovered("racer-1", 1_600);
  const recoveries = race.events.filter((event) => event.type === "racer_recovered");
  assert.equal(recoveries.length, 1);
  assert.deepEqual(recoveries[0].metadata, { cause: "manual" });
  assert.equal(recoveries[0].occurredAt, 1_500);
});

test("does not recover racers by duration once the race is over", async () => {
  const race = readyRace(new FakeObstacles(), 1);
  await race.reachCheckpoint("racer-2", 1, 1_000);
  await race.reachCheckpoint("racer-1", 1, 1_500);
  race.markRecovered("racer-1", 1_600);
  assert.equal(race.finishRacer("racer-1", 2_000), true);

  const before = race.events.length;
  race.tick(10_000);
  assert.equal(race.events.length, before);
  assert.equal(race.racers.get("racer-2")?.status, "recovering");
});

test("no obstacles are fetched after hazards freeze", async () => {
  const provider = new FakeObstacles();
  const race = readyRace(provider);
  race.tick(180_100);
  await race.reachCheckpoint("racer-1", 1, 180_200);
  assert.deepEqual(provider.policyCalls, []);
  assert.equal(eventTypes(race).includes("obstacle_applied"), false);
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
  const race = readyRace(new FakeObstacles({ applied: false }), 1);
  await race.reachCheckpoint("racer-1", 1, 1_000);
  race.finishRacer("racer-1", 2_000);
  assert.equal(race.abort("late", 3_000), false);
  assert.equal(race.race.status, "finished");
  assert.equal(race.racers.get("racer-1")?.status, "finished");
});

test("abort keeps finished racers finished", async () => {
  const race = readyRace(new FakeObstacles(), 1);
  await race.reachCheckpoint("racer-1", 1, 1_000);
  race.abort("operator", 1_500);
  assert.equal(race.racers.get("racer-1")?.status, "timed_out");
  assert.equal(race.racers.get("racer-1")?.recoveringUntil, undefined);
});
