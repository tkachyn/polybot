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
    return {
      racerId,
      steelSessionId: `steel-${racerId}`,
      viewerUrl: `https://viewer.test/${racerId}?interactive=false&showControls=false`,
    };
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

class ExitingRunner extends FakeRunner {
  override async run(): Promise<void> {
    throw new Error("runner exited");
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

class FinishProgressVerifier extends FakeVerifier {
  async getProgress(): Promise<{ completedCheckpoints: number[]; finished: boolean }> {
    return { completedCheckpoints: [1, 2, 3], finished: true };
  }
}

function createCoordinator(): {
  coordinator: RaceCoordinator;
  sessions: FakeSessions;
  runner: FakeRunner;
  events: InMemoryRaceEventStore;
};
function createCoordinator<T extends CompetitorAgentRunner>(runner: T, verifier?: CourseVerifier): {
  coordinator: RaceCoordinator;
  sessions: FakeSessions;
  runner: T;
  events: InMemoryRaceEventStore;
};
function createCoordinator<T extends CompetitorAgentRunner>(runner?: T, verifier?: CourseVerifier) {
  const actualRunner = runner ?? new FakeRunner();
  const sessions = new FakeSessions();
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
      agentRunner: actualRunner,
      courseVerifier: verifier ?? new FakeVerifier(),
      eventStore: events,
    },
  );
  return { coordinator, sessions, runner: actualRunner, events };
}

test("prepares four sessions before starting all racers", async () => {
  const { coordinator, sessions, runner } = createCoordinator();
  const snapshot = await coordinator.prepareAndStart(1_000);

  assert.deepEqual(sessions.created, ["racer-1", "racer-2", "racer-3", "racer-4"]);
  assert.equal(runner.prepared.length, 4);
  assert.equal(runner.running.size, 4);
  assert.equal(snapshot.race.status, "running");
  assert.equal(snapshot.racers.every((racer) => racer.status === "running"), true);
  assert.deepEqual(coordinator.browserView("racer-1"), {
    status: "live",
    viewerUrl: "https://viewer.test/racer-1?interactive=false&showControls=false",
  });
  await coordinator.shutdown();
  assert.deepEqual(coordinator.browserView("racer-1"), {
    status: "released",
    viewerUrl: null,
  });
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

test("auto-finishes when the verifier confirms the final browser state", async () => {
  const { coordinator, runner } = createCoordinator();
  const startedAt = Date.now();
  await coordinator.prepareAndStart(startedAt);
  for (let checkpoint = 1; checkpoint <= 3; checkpoint += 1) {
    await coordinator.recordCheckpoint("racer-1", checkpoint, startedAt + checkpoint);
  }

  const completed = await runner.running.get("racer-1")?.checkFinish?.();
  assert.equal(completed, true);
  assert.equal(coordinator.engine.race.winnerRacerId, "racer-1");
  assert.equal(coordinator.market.status, "resolved");
});

test("reconciles verified course progress before declaring a winner", async () => {
  const { coordinator, runner } = createCoordinator(new FakeRunner(), new FinishProgressVerifier());
  await coordinator.prepareAndStart(Date.now());

  const completed = await runner.running.get("racer-1")?.checkFinish?.();

  assert.equal(completed, true);
  assert.equal(coordinator.engine.racers.get("racer-1")?.checkpoint, 3);
  assert.equal(coordinator.engine.race.winnerRacerId, "racer-1");
  assert.equal(coordinator.market.winnerRacerId, "racer-1");
});

test("ends and releases the race when every runner fails", async () => {
  const runner = new ExitingRunner();
  const { coordinator, sessions } = createCoordinator(runner);
  await coordinator.prepareAndStart(Date.now());
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(coordinator.engine.race.status, "timed_out");
  assert.equal(coordinator.market.status, "unresolved");
  assert.equal(sessions.released, true);

  // The event keeps the raw reason for diagnostics; the agent's log reads as a cause.
  const failed = coordinator.engine.events.find((event) =>
    event.type === "racer_failed" && event.racerId === "racer-1");
  assert.equal(failed?.metadata?.reason, "runner exited");
  const log = coordinator.racerTelemetry("racer-1").log.map((entry) => entry.text);
  assert.ok(log.includes("Failed: stopped when its agent quit early"), log.join(" | "));
  assert.ok(log.includes("Stopped: every agent failed"), log.join(" | "));
  assert.ok(log.every((text) => !text.includes("runner exited") && !text.includes("all_racers_failed")));
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

/** Reports each racer's course progress as the verifier's ground truth. */
class ProgressVerifier implements CourseVerifier {
  readonly completed = new Map<string, number>();
  readonly checkpointCalls: Array<[string, number]> = [];
  fail = false;

  async verifyTargetOpening(): Promise<boolean> {
    return true;
  }

  async verifyCheckpoint(input: { racerId: string; checkpoint: number }): Promise<boolean> {
    this.checkpointCalls.push([input.racerId, input.checkpoint]);
    if (this.fail) throw new Error("course state unavailable");
    return input.checkpoint <= (this.completed.get(input.racerId) ?? 0);
  }

  async verifyFinish(): Promise<boolean> {
    return false;
  }
}

function createSyncCoordinator(options: { sabotage?: boolean } = {}) {
  const verifier = new ProgressVerifier();
  const runner = new FakeRunner();
  const coordinator = new RaceCoordinator(
    {
      raceId: "race-sync",
      courseId: "course-1",
      seed: "seed-1",
      checkpointCount: 4,
      fight: options.sabotage
        ? {
            sabotage: {
              checkpoint: 2,
              summary: "A long modal at checkpoint 2",
              policy: {
                hazardType: "blocking_modal",
                targetRole: "primary-action",
                durationMs: 30_000,
                intensity: 2,
              },
            },
          }
        : undefined,
    },
    {
      sessionManager: new FakeSessions(),
      agentRunner: runner,
      courseVerifier: verifier,
      eventStore: new InMemoryRaceEventStore(),
      obstacleProvider: options.sabotage
        ? {
            async getPolicy() {
              return null;
            },
            async apply() {
              return { applied: true };
            },
          }
        : undefined,
    },
  );
  return { coordinator, runner, verifier };
}

function claimedCheckpoints(coordinator: RaceCoordinator, racerId: string): number[] {
  return coordinator.engine.events
    .filter((event) => event.type === "checkpoint_reached" && event.racerId === racerId)
    .map((event) => event.checkpoint ?? 0);
}

test("syncProgress records verified checkpoints in order and stops at the first unverified one", async () => {
  const { coordinator, runner, verifier } = createSyncCoordinator();
  await coordinator.prepareAndStart(Date.now());
  const context = runner.running.get("racer-1");
  assert.ok(context?.syncProgress);

  verifier.completed.set("racer-1", 3);
  await context.syncProgress();
  assert.deepEqual(claimedCheckpoints(coordinator, "racer-1"), [1, 2, 3]);
  assert.equal(coordinator.engine.racers.get("racer-1")?.checkpoint, 3);
  assert.deepEqual(
    verifier.checkpointCalls.filter(([racerId]) => racerId === "racer-1").at(-1),
    ["racer-1", 4],
    "checkpoint 4 was checked and refused",
  );

  // Concurrent syncs and an explicit report never claim a checkpoint twice.
  verifier.completed.set("racer-1", 4);
  await Promise.all([
    context.syncProgress(),
    context.syncProgress(),
    context.reportCheckpoint(4).catch(() => undefined),
  ]);
  assert.deepEqual(claimedCheckpoints(coordinator, "racer-1"), [1, 2, 3, 4]);
  assert.deepEqual(claimedCheckpoints(coordinator, "racer-2"), []);

  verifier.fail = true;
  await assert.doesNotReject(runner.running.get("racer-2")?.syncProgress?.() ?? Promise.resolve());
  await coordinator.shutdown();
});

test("syncProgress skips a recovering racer and records again once it recovers", async () => {
  const { coordinator, runner, verifier } = createSyncCoordinator({ sabotage: true });
  const start = Date.now();
  await coordinator.prepareAndStart(start);
  const context = runner.running.get("racer-1");
  assert.ok(context?.syncProgress);

  verifier.completed.set("racer-1", 3);
  await context.syncProgress();
  assert.deepEqual(claimedCheckpoints(coordinator, "racer-1"), [1, 2]);
  assert.equal(coordinator.engine.racers.get("racer-1")?.status, "recovering");

  const calls = verifier.checkpointCalls.length;
  await context.syncProgress();
  assert.equal(verifier.checkpointCalls.length, calls, "nothing is verified while recovering");
  assert.deepEqual(claimedCheckpoints(coordinator, "racer-1"), [1, 2]);

  await context.reportRecovery?.();
  assert.equal(coordinator.engine.racers.get("racer-1")?.status, "running");
  await context.syncProgress();
  assert.deepEqual(claimedCheckpoints(coordinator, "racer-1"), [1, 2, 3]);
  await coordinator.shutdown();
});
