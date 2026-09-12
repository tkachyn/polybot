import assert from "node:assert/strict";
import test from "node:test";
import type {
  CompetitorAgentRunner,
  CourseVerifier,
  RacerSessionManager,
} from "../src/application/contracts.js";
import { RaceCoordinator } from "../src/application/race-coordinator.js";
import { buildApi } from "../src/api/server.js";
import type { CoordinatorFactory } from "../src/api/race-registry.js";
import { InMemoryRaceEventStore } from "../src/persistence/in-memory-event-store.js";

const sessionManager: RacerSessionManager = {
  async create(racerId) { return { racerId, steelSessionId: `steel-${racerId}` }; },
  async release() {},
  async releaseAll() {},
};
const runner: CompetitorAgentRunner = {
  async prepare() {},
  async run() { await new Promise<void>(() => undefined); },
  async stop() {},
};
const verifier: CourseVerifier = {
  async verifyTargetOpening() { return true; },
  async verifyCheckpoint() { return true; },
  async verifyFinish() { return true; },
};

const factory: CoordinatorFactory = (input, context) =>
  new RaceCoordinator({ ...input, fight: context.fight }, {
    sessionManager,
    agentRunner: runner,
    courseVerifier: verifier,
    eventStore: new InMemoryRaceEventStore(),
    ledger: context.ledger,
  });

test("creates, progresses, trades, and resolves a race through the API", async () => {
  const app = buildApi({ coordinatorFactory: factory, enableTicker: false });
  const created = await app.inject({
    method: "POST",
    url: "/races",
    payload: {
      raceId: "race-api",
      courseId: "course-1",
      seed: "seed-1",
      checkpointCount: 3,
      task: "Complete the course",
      startUrl: "https://course.test/start",
      now: 1_000,
    },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().sessions.length, 4);
  assert.deepEqual(
    created.json().sessions.map((session: { racerId: string }) => session.racerId),
    ["racer-1", "racer-2", "racer-3", "racer-4"],
  );

  const funded = await app.inject({
    method: "POST",
    url: "/races/race-api/market/fund",
    payload: { userId: "viewer-1", credits: 10 },
  });
  assert.equal(funded.statusCode, 200);

  const bought = await app.inject({
    method: "POST",
    url: "/races/race-api/market/buy",
    payload: { userId: "viewer-1", racerId: "racer-1", quantity: 2 },
  });
  assert.equal(bought.statusCode, 200);

  for (let checkpoint = 1; checkpoint <= 3; checkpoint += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/races/race-api/checkpoints",
      payload: { racerId: "racer-1", checkpoint, now: 2_000 + checkpoint },
    });
    assert.equal(response.statusCode, 200);
  }

  const finished = await app.inject({
    method: "POST",
    url: "/races/race-api/finish",
    payload: { racerId: "racer-1", now: 3_000 },
  });
  assert.equal(finished.statusCode, 200);
  assert.equal(finished.json().race.winnerRacerId, "racer-1");
  assert.equal(finished.json().market.status, "resolved");

  const events = await app.inject({
    method: "GET",
    url: "/races/race-api/events",
  });
  assert.equal(events.statusCode, 200);
  assert.equal(
    events.json().some((event: { type: string }) => event.type === "race_finished"),
    true,
  );
  await app.close();
});
