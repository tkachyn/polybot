import assert from "node:assert/strict";
import test from "node:test";
import type {
  CompetitorAgentRunner,
  CompetitorContext,
  CourseVerifier,
  RacerSessionHandle,
  RacerSessionManager,
} from "../src/application/contracts.js";
import { RaceCoordinator } from "../src/application/race-coordinator.js";
import { InMemoryRaceEventStore } from "../src/persistence/in-memory-event-store.js";

class FakeSessions implements RacerSessionManager {
  created: string[] = [];
  released = false;

  async create(racerId: string): Promise<RacerSessionHandle> {
    this.created.push(racerId);
    return { racerId, steelSessionId: `steel-${racerId}` };
  }

  async release(_racerId: string): Promise<void> {}

  async releaseAll(): Promise<void> {
    this.released = true;
  }
}

class FakeRunner implements CompetitorAgentRunner {
  prepared: string[] = [];
  running = new Map<string, CompetitorContext>();
  stopped: string[] = [];

  async prepare(context: Omit<CompetitorContext, "reportCheckpoint" | "reportFinish">) {
    this.prepared.push(context.racerId);
  }

  async run(context: CompetitorContext): Promise<void> {
    this.running.set(context.racerId, context);
    await new Promise<void>(() => undefined);
  }

  async stop(racerId: string): Promise<void> {
    this.stopped.push(racerId);
  }
}

class FakeVerifier implements CourseVerifier {
  async verifyTargetOpening(): Promise<boolean> {
    return true;
  }

  async verifyCheckpoint(): Promise<boolean> {
    return true;
  }

  async verifyFinish(): Promise<boolean> {
    return true;
  }
}

function createCoordinator() {
  const sessions = new FakeSessions();
  const runner = new FakeRunner();
  const events = new InMemoryRaceEventStore();
  const coordinator = new RaceCoordinator(
    {
      raceId: "race-1",
      courseId: "course-1",
      seed: "seed-1",
      checkpointCount: 3,
      targetDurationMs: 180_000,
      absoluteDurationMs: 300_000,
    },
    {
      sessionManager: sessions,
      agentRunner: runner,
      courseVerifier: new FakeVerifier(),
      eventStore: events,
    },
  );
  return { coordinator, sessions, runner, events };
}

test("prepares four sessions before starting all racers", async () => {
  const { coordinator, sessions, runner } = createCoordinator();
  const snapshot = await coordinator.prepareAndStart(1_000);

  assert.deepEqual(sessions.created, ["racer-1", "racer-2", "racer-3", "racer-4"]);
  assert.equal(runner.prepared.length, 4);
  assert.equal(runner.running.size, 4);
  assert.equal(snapshot.race.status, "running");
  assert.equal(snapshot.racers.every((racer) => racer.status === "running"), true);
  await coordinator.shutdown();
});

test("verifies checkpoints and resolves the market with the winner", async () => {
  const { coordinator, sessions, runner, events } = createCoordinator();
  await coordinator.prepareAndStart(1_000);
  coordinator.fundSpectator("spectator-1", 10);
  coordinator.market.buy("spectator-1", "racer-2", 2);

  await coordinator.recordCheckpoint("racer-2", 1, 2_000);
  await coordinator.recordCheckpoint("racer-2", 2, 3_000);
  await coordinator.recordCheckpoint("racer-2", 3, 4_000);
  await coordinator.recordFinish("racer-2", 5_000);

  assert.equal(coordinator.engine.race.winnerRacerId, "racer-2");
  assert.equal(coordinator.market.status, "resolved");
  assert.equal(coordinator.market.winnerRacerId, "racer-2");
  assert.equal(sessions.released, true);
  assert.equal(runner.stopped.length, 4);
  assert.equal((await events.list("race-1")).at(-1)?.type, "race_finished");
});

test("freezes trading at three minutes but keeps racers active", async () => {
  const { coordinator, sessions } = createCoordinator();
  await coordinator.prepareAndStart(1_000);
  await coordinator.tick(181_000);

  assert.equal(coordinator.engine.race.status, "hazards_frozen");
  assert.equal(coordinator.market.status, "frozen");
  assert.equal(sessions.released, false);
  await coordinator.shutdown();
});

test("marks the market unresolved and releases sessions at the safety cap", async () => {
  const { coordinator, sessions, runner } = createCoordinator();
  await coordinator.prepareAndStart(1_000);
  await coordinator.tick(301_000);

  assert.equal(coordinator.engine.race.status, "timed_out");
  assert.equal(coordinator.market.status, "unresolved");
  assert.equal(sessions.released, true);
  assert.equal(runner.stopped.length, 4);
});
