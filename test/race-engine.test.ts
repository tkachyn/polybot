import assert from "node:assert/strict";
import test from "node:test";
import { RaceEngine } from "../src/domain/race-engine.js";

function readyRace() {
  const race = new RaceEngine({
    raceId: "race-1",
    courseId: "demo-course",
    seed: "seed-1",
    checkpointCount: 3,
    now: 0,
  });

  for (let index = 1; index <= 4; index += 1) {
    race.markReady(`racer-${index}`, 10 + index);
  }
  race.start(100);
  return race;
}

test("requires all four racers before starting", () => {
  const race = new RaceEngine({
    raceId: "race-1",
    courseId: "demo-course",
    seed: "seed-1",
    checkpointCount: 3,
  });

  race.markReady("racer-1");
  assert.throws(() => race.start(), /All four racers must be ready/);
});

test("racers reach checkpoints independently", async () => {
  const race = readyRace();

  const first = await race.reachCheckpoint("racer-1", 1, 1_000);
  assert.deepEqual(first, { claimed: true, obstacleApplied: false });
  assert.equal(race.racers.get("racer-1")?.checkpoint, 1);
  assert.equal(race.racers.get("racer-2")?.checkpoint, 0);

  const duplicate = await race.reachCheckpoint("racer-1", 1, 1_001);
  assert.deepEqual(duplicate, { claimed: false, obstacleApplied: false });
});

test("freezes hazards at the target duration but keeps the race alive", async () => {
  const race = readyRace();
  race.tick(180_100);

  assert.equal(race.race.status, "hazards_frozen");
  const event = await race.reachCheckpoint("racer-1", 1, 180_200);
  assert.deepEqual(event, { claimed: true, obstacleApplied: false });
  assert.equal(race.race.status, "hazards_frozen");
});

test("the first verified finisher wins after the target duration", async () => {
  const race = readyRace();
  race.tick(180_000);

  for (const racerId of ["racer-2", "racer-3", "racer-4"]) {
    await race.reachCheckpoint(racerId, 1, 181_000);
    await race.reachCheckpoint(racerId, 2, 182_000);
    await race.reachCheckpoint(racerId, 3, 183_000);
  }

  assert.equal(race.finishRacer("racer-3", 193_000), true);
  assert.equal(race.race.winnerRacerId, "racer-3");
  assert.equal(race.race.status, "finished");
  assert.equal(race.finishRacer("racer-2", 194_000), false);
});

test("times out unfinished racers at the absolute safety cap", () => {
  const race = readyRace();
  race.tick(300_101);

  assert.equal(race.race.status, "timed_out");
  assert.equal(race.racers.get("racer-1")?.status, "timed_out");
});
