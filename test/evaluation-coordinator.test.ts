import assert from "node:assert/strict";
import test from "node:test";
import type { FightEvaluation } from "../src/api/dto.js";
import type {
  CapturedFrame,
  CompetitorAgentRunner,
  CompetitorContext,
  CourseVerifier,
  RacerSessionHandle,
  RacerSessionManager,
} from "../src/application/contracts.js";
import { RaceCoordinator } from "../src/application/race-coordinator.js";
import type { DatasetStore } from "../src/dataset/store.js";
import type {
  DisruptionCommand,
  DisruptionResult,
  ObstacleProvider,
} from "../src/domain/types.js";
import { InMemoryEvaluationStore } from "../src/evaluation/store.js";
import { InMemoryRaceEventStore } from "../src/persistence/in-memory-event-store.js";

const T = 1_700_000_000_000;
const LIVE_KEY = "ste-live-key";
const DECOY: DisruptionCommand = {
  hazardType: "insert_decoy",
  targetRole: "primary-action",
  durationMs: 5_000,
  intensity: 1,
};
/** A recording that started 10 s before the fight: a hit at T + 40 s is 50 s in. */
const PLAYLIST = "#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2023-11-14T22:13:10.000Z\n#EXT-X-ENDLIST\n";
/** racer-1's click on the planted decoy, as Steel records it: 3 s after the hit. */
const DECOY_CLICK = {
  timestamp: new Date(T + 43_000).toISOString(),
  type: "click",
  page: { url: "https://course.test/shipping" },
  target: {
    tagName: "BUTTON",
    role: "button",
    accessibleName: "Continue",
    text: "Continue",
    attributes: { id: "arena-decoy-1" },
    selector: { css: "#arena-decoy-1", id: "arena-decoy-1" },
  },
};
/** Every other session: one page load. */
const PAGE_LOAD = {
  timestamp: new Date(T + 5_000).toISOString(),
  type: "navigate",
  navigation: { url: "https://course.test/cart" },
};

class Sessions implements RacerSessionManager {
  releaseAllCalls = 0;

  async create(racerId: string): Promise<RacerSessionHandle> {
    return { racerId, steelSessionId: `steel-${racerId}` };
  }

  async release(): Promise<void> {}

  async releaseAll(): Promise<void> {
    this.releaseAllCalls += 1;
  }
}

/** A live Steel manager: it remembers each session's creating key after release. */
class SteelSessions extends Sessions {
  evidence(racerId: string): { steelSessionId: string; apiKey: string } {
    return { steelSessionId: `steel-${racerId}`, apiKey: LIVE_KEY };
  }
}

/** run() settles once stopped, like a real runner. */
class Runner implements CompetitorAgentRunner {
  readonly contexts = new Map<string, CompetitorContext>();
  private readonly stops = new Map<string, () => void>();

  constructor(private readonly prepareError?: Error) {}

  async prepare(): Promise<void> {
    if (this.prepareError) throw this.prepareError;
  }

  run(context: CompetitorContext): Promise<void> {
    this.contexts.set(context.racerId, context);
    return new Promise((resolve) => {
      this.stops.set(context.racerId, resolve);
    });
  }

  async stop(racerId: string): Promise<void> {
    this.stops.get(racerId)?.();
  }
}

class Verifier implements CourseVerifier {
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

class Obstacles implements ObstacleProvider {
  async getPolicy(): Promise<DisruptionCommand | null> {
    return DECOY;
  }

  async apply(): Promise<DisruptionResult> {
    return { applied: true };
  }
}

class CountingStore extends InMemoryEvaluationStore {
  puts = 0;

  override async put(evaluation: FightEvaluation): Promise<void> {
    this.puts += 1;
    await super.put(evaluation);
  }
}

/** Stores the first evaluation, then rejects every later put. */
class FirstPutOnlyStore extends InMemoryEvaluationStore {
  puts = 0;

  override async put(evaluation: FightEvaluation): Promise<void> {
    this.puts += 1;
    if (this.puts > 1) throw new Error("disk full");
    await super.put(evaluation);
  }
}

type SetupOptions = {
  store?: InMemoryEvaluationStore;
  mode?: "live" | "simulated";
  sessions?: Sessions;
  runner?: Runner;
  steelFetch?: typeof fetch;
  steelEvidenceTimeoutMs?: number;
  steelEvidenceRetryMs?: number;
  steelBackfillDelaysMs?: readonly number[];
  datasetStore?: DatasetStore;
};

/** Three checkpoints; a fixed decoy (5 s) fires at checkpoint 2. */
function setup(options: SetupOptions = {}) {
  const sessions = options.sessions ?? new Sessions();
  const runner = options.runner ?? new Runner();
  const coordinator = new RaceCoordinator(
    {
      raceId: "race-eval",
      courseId: "course-eval",
      seed: "seed-eval",
      checkpointCount: 3,
      task: "Buy the blue mug and check out",
      fight: {
        createdAt: T - 60_000,
        checkpointLabels: ["Cart", "Shipping", "Payment"],
        sabotage: { checkpoint: 2, summary: "Decoy at shipping", policy: DECOY },
      },
    },
    {
      sessionManager: sessions,
      agentRunner: runner,
      courseVerifier: new Verifier(),
      eventStore: new InMemoryRaceEventStore(),
      obstacleProvider: new Obstacles(),
      evaluationStore: options.store,
      mode: options.mode,
      steelFetch: options.steelFetch,
      steelEvidenceTimeoutMs: options.steelEvidenceTimeoutMs,
      steelEvidenceRetryMs: options.steelEvidenceRetryMs,
      steelBackfillDelaysMs: options.steelBackfillDelaysMs,
      datasetStore: options.datasetStore,
    },
  );
  return { coordinator, sessions, runner };
}

/** Read through a call so assertions do not narrow the getter for the whole test. */
function pointerOf(coordinator: RaceCoordinator) {
  return coordinator.evaluationPointer;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The Steel backfill runs on real timers: waits until `done()` holds. */
async function until(done: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the Steel backfill");
    await sleep(5);
  }
}

/** Plays racer-1 through a won fight with explicit times; the decoy hits at T + 40 s. */
async function playWin(coordinator: RaceCoordinator): Promise<void> {
  await coordinator.recordCheckpoint("racer-1", 1, T + 20_000);
  await coordinator.recordCheckpoint("racer-1", 2, T + 40_000);
  await coordinator.recordRecovery("racer-1", T + 41_000);
  await coordinator.tick(T + 45_000);
  await coordinator.recordCheckpoint("racer-1", 3, T + 70_000);
  await coordinator.recordFinish("racer-1", T + 75_000);
}

test("finalizes exactly once when the fight closes, stores it and publishes a final pointer", async () => {
  const store = new CountingStore();
  const { coordinator } = setup({ store, mode: "simulated" });
  assert.equal(pointerOf(coordinator), null, "no pointer before the start");
  assert.equal(coordinator.evaluation(T - 500).status, "provisional");

  await coordinator.prepareAndStart(T);
  const started = pointerOf(coordinator);
  assert.ok(started);
  assert.equal(started.status, "provisional");
  assert.ok(started.updatedAt >= T);

  coordinator.recordAgentAction("racer-1", { kind: "action", text: "click add-to-cart", step: 1, maxSteps: 20 }, T + 5_000);
  const afterAction = pointerOf(coordinator);
  assert.ok(afterAction && afterAction.updatedAt > started.updatedAt);

  assert.equal(coordinator.evaluation(T + 6_000).generatedAt, T + 6_000);
  assert.equal(coordinator.evaluation(T + 7_000).generatedAt, T + 6_000, "cached until an input changes");
  coordinator.fundSpectator("alice", 100, T + 7_500);
  coordinator.placeOrder({ userId: "alice", racerId: "racer-2", side: "yes", action: "buy", quantity: 5 }, T + 8_000);
  const afterTrade = pointerOf(coordinator);
  assert.ok(afterTrade && afterTrade.updatedAt > afterAction.updatedAt, "a price move is an input");
  const refreshed = coordinator.evaluation(T + 9_000);
  assert.equal(refreshed.generatedAt, T + 9_000);
  assert.ok(refreshed.agents[1].crowd.finalYes > 0.25);

  const fightStatuses: Array<string | undefined> = [];
  coordinator.subscribe((change) => {
    if (change.kind === "fight") fightStatuses.push(pointerOf(coordinator)?.status);
  });
  await playWin(coordinator);

  const final = await coordinator.whenEvaluationFinal();
  assert.equal(final.status, "final");
  assert.equal(final.mode, "simulated");
  assert.equal(final.winnerRacerId, "racer-1");
  assert.equal(final.startedAt, T);
  assert.equal(final.finishedAt, T + 75_000);
  assert.equal(final.generatedAt, T + 75_000);
  assert.equal(final.agents[0].outcome, "won");
  assert.equal(final.agents[0].sabotage[0].reaction, "recovered");
  assert.deepEqual(final.agents.slice(1).map((agent) => agent.outcome), ["stopped", "stopped", "stopped"]);
  assert.equal(store.puts, 1);
  assert.deepEqual(await store.get("race-eval"), final);

  const pointer = pointerOf(coordinator);
  assert.ok(pointer);
  assert.equal(pointer.status, "final");
  assert.ok(pointer.updatedAt > afterTrade.updatedAt);
  assert.equal(fightStatuses.at(-1), "final", "the fight stream carries the final pointer");

  await coordinator.tick(T + 400_000);
  await coordinator.shutdown();
  await settle();
  assert.equal(store.puts, 1, "finalized exactly once");
  coordinator.recordAgentAction("racer-2", { kind: "action", text: "late step", step: 9, maxSteps: 20 }, T + 90_000);
  assert.deepEqual(pointerOf(coordinator), pointer);
  assert.deepEqual(coordinator.evaluation(T + 95_000), final);
});

test("a fight driven through the public API with past timestamps is finalized on event times", async () => {
  const store = new CountingStore();
  const { coordinator } = setup({ store, mode: "simulated" });
  const past = Date.parse("2026-09-01T12:00:00.000Z");
  await coordinator.prepareAndStart(past);
  coordinator.recordAgentAction("racer-2", { kind: "action", text: "open cart", step: 1, maxSteps: 20 }, past + 5_000);
  await coordinator.recordCheckpoint("racer-2", 1, past + 20_000);
  await coordinator.recordCheckpoint("racer-2", 2, past + 41_000);
  await coordinator.recordRecovery("racer-2", past + 42_000);
  coordinator.recordAgentAction("racer-2", {
    kind: "action",
    text: "click Continue",
    step: 2,
    maxSteps: 20,
    evidence: { target: { role: "primary-action", text: "Continue", decoy: true } },
  }, past + 43_000);
  await coordinator.tick(past + 46_000);
  await coordinator.recordCheckpoint("racer-2", 3, past + 70_000);
  await coordinator.recordFinish("racer-2", past + 75_000);
  await coordinator.tick(past + 76_000);
  await coordinator.shutdown();

  const final = await coordinator.whenEvaluationFinal();
  assert.equal(final.startedAt, past);
  assert.equal(final.finishedAt, past + 75_000);
  assert.equal(final.generatedAt, past + 75_000);
  const claude = final.agents[1];
  assert.equal(claude.outcome, "won");
  assert.equal(claude.durationMs, 75_000);
  assert.equal(claude.sabotage[0].appliedAt, past + 41_000);
  assert.equal(claude.sabotage[0].reaction, "deceived");
  assert.equal(claude.sabotage[0].firstResponse, "click Continue");
  assert.deepEqual(claude.trace.map((entry) => entry.at), [past + 5_000, past + 43_000]);
  assert.deepEqual((await store.list({ since: past })).map((evaluation) => evaluation.raceId), ["race-eval"]);
  assert.deepEqual(await store.list({ since: past + 80_000 }), []);
  assert.equal(store.puts, 1);
});

test("an explicitly aborted fight is finalized as voided", async () => {
  const store = new CountingStore();
  const { coordinator } = setup({ store, mode: "simulated" });
  await coordinator.prepareAndStart(T);
  await coordinator.recordCheckpoint("racer-3", 1, T + 30_000);
  coordinator.engine.abort("operator_abort", T + 300_000);
  await coordinator.tick(T + 300_000);

  const final = await coordinator.whenEvaluationFinal();
  assert.equal(final.voided, true);
  assert.equal(final.winnerRacerId, null);
  assert.equal(final.finishedAt, T + 300_000);
  assert.deepEqual(final.agents.map((agent) => agent.outcome), ["timed_out", "timed_out", "timed_out", "timed_out"]);
  assert.equal(
    final.findings[0],
    "The fight was stopped (operator abort) before any agent finished, so the fight was voided and positions refunded.",
  );
  assert.equal(store.puts, 1);
});

test("a fight that never started is never finalized", async () => {
  const store = new CountingStore();
  const { coordinator } = setup({ store, mode: "simulated", runner: new Runner(new Error("steel unavailable")) });
  await assert.rejects(coordinator.prepareAndStart(T), /steel unavailable/);
  await settle();
  assert.equal(coordinator.engine.race.status, "timed_out");
  assert.equal(pointerOf(coordinator), null);
  assert.equal(store.puts, 0);
});

test("live fights read Steel traces and the replay start after the sessions are released", async () => {
  const store = new CountingStore();
  const sessions = new SteelSessions();
  const replayStart = T - 10_000;
  const playlist = [
    "#EXTM3U",
    `#EXT-X-PROGRAM-DATE-TIME:${new Date(replayStart).toISOString().replace("Z", "123456Z")}`,
    "#EXTINF:6.0,",
    "https://storage.steel.test/segment-0.ts?signature=abc",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
  const calls: Array<{ path: string; key: string | null; afterRelease: boolean }> = [];
  const steelFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      path: url.pathname,
      key: new Headers(init?.headers).get("steel-api-key"),
      afterRelease: sessions.releaseAllCalls > 0,
    });
    if (url.pathname.endsWith("/hls")) {
      return new Response(playlist, { headers: { "content-type": "application/vnd.apple.mpegurl" } });
    }
    const events = url.pathname.includes("/steel-racer-1/") ? [DECOY_CLICK] : [PAGE_LOAD];
    return Response.json({ events, total: events.length, hasMore: false });
  }) as typeof fetch;
  const { coordinator } = setup({ store, mode: "live", sessions, steelFetch });

  await coordinator.prepareAndStart(T);
  await coordinator.recordCheckpoint("racer-1", 1, T + 20_000);
  await coordinator.recordCheckpoint("racer-1", 2, T + 40_000);
  await coordinator.recordRecovery("racer-1", T + 41_000);
  await coordinator.tick(T + 45_000);
  await coordinator.recordCheckpoint("racer-1", 3, T + 70_000);
  coordinator.evaluation(T + 71_000);
  assert.equal(calls.length, 0, "no Steel reads while the fight is live");
  await coordinator.recordFinish("racer-1", T + 75_000);

  const final = await coordinator.whenEvaluationFinal();
  assert.equal(calls.length, 8, "traces and HLS for each of the four sessions");
  assert.ok(calls.every((call) => call.afterRelease && call.key === LIVE_KEY));
  const gpt = final.agents[0];
  assert.equal(gpt.steel.traceAvailable, true);
  assert.equal(gpt.steel.replayAvailable, true);
  assert.deepEqual(gpt.steel.trace.map((entry) => [entry.type, entry.label, entry.decoy]), [["click", "Continue", true]]);
  assert.equal(gpt.sabotage[0].reaction, "deceived");
  assert.equal(gpt.sabotage[0].deceived, true);
  assert.equal(gpt.sabotage[0].evidence.replayOffsetSec, 50);
  assert.equal(
    gpt.sabotage[0].explanation,
    "Clicked the decoy “Continue” 3 s after the hit, then found the real button; 10 s lost against a 20 s pace.",
  );
  assert.equal(final.agents[1].steel.traceAvailable, true);
  assert.deepEqual(final.agents[1].steel.trace.map((entry) => entry.type), ["navigate"]);
  assert.ok(!JSON.stringify(final).includes(LIVE_KEY), "the key never reaches the evaluation");
  assert.equal(store.puts, 1);

  const playlistFetches = calls.filter((call) => call.path.endsWith("/hls")).length;
  assert.equal(await coordinator.replayPlaylist("racer-1"), playlist);
  assert.equal(calls.filter((call) => call.path.endsWith("/hls")).length, playlistFetches + 1, "a fresh fetch");
  assert.equal(await coordinator.replayPlaylist("racer-9"), null);
});

test("a recording that is not published yet is fetched again within the budget", async () => {
  const hlsCalls = new Map<string, number>();
  let traceCalls = 0;
  const steelFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/hls")) {
      const count = (hlsCalls.get(url.pathname) ?? 0) + 1;
      hlsCalls.set(url.pathname, count);
      return count === 1
        ? new Response("recording not ready", { status: 404 })
        : new Response("#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2023-11-14T22:13:10.000Z\n#EXT-X-ENDLIST\n");
    }
    traceCalls += 1;
    return Response.json({ events: [PAGE_LOAD], total: 1, hasMore: false });
  }) as typeof fetch;
  const { coordinator } = setup({
    mode: "live",
    sessions: new SteelSessions(),
    steelFetch,
    steelEvidenceRetryMs: 10,
  });
  await coordinator.prepareAndStart(T);
  await playWin(coordinator);

  const final = await coordinator.whenEvaluationFinal();
  assert.ok(final.agents.every((agent) => agent.steel.replayAvailable && agent.steel.traceAvailable));
  assert.deepEqual([...hlsCalls.values()], [2, 2, 2, 2]);
  assert.equal(traceCalls, 4, "traces with events are not fetched again");
  assert.equal(final.agents[0].sabotage[0].evidence.replayOffsetSec, 50);
});

test("simulated fights never read Steel evidence, have no replay and backfill nothing", async () => {
  let fetches = 0;
  const steelFetch = (async () => {
    fetches += 1;
    return new Response("#EXTM3U\n");
  }) as typeof fetch;
  const store = new CountingStore();
  const { coordinator } = setup({
    store,
    mode: "simulated",
    sessions: new SteelSessions(),
    steelFetch,
    steelBackfillDelaysMs: [0, 5],
  });
  await coordinator.prepareAndStart(T);
  coordinator.engine.abort("operator_abort", T + 300_000);
  await coordinator.tick(T + 300_000);
  const final = await coordinator.whenEvaluationFinal();
  assert.equal(await coordinator.replayPlaylist("racer-1"), null);
  assert.deepEqual(final.agents[0].steel, { traceAvailable: false, replayAvailable: false, trace: [] });
  await sleep(50);
  assert.equal(fetches, 0);
  assert.equal(store.puts, 1);
  assert.deepEqual(coordinator.evaluation(), final);
});

test("Steel evidence that never arrives is abandoned at the budget", async () => {
  const store = new CountingStore();
  const steelFetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
  const { coordinator } = setup({
    store,
    mode: "live",
    sessions: new SteelSessions(),
    steelFetch,
    steelEvidenceTimeoutMs: 50,
  });
  await coordinator.prepareAndStart(T);
  coordinator.engine.abort("operator_abort", T + 300_000);
  const started = Date.now();
  await coordinator.tick(T + 300_000);
  const final = await coordinator.whenEvaluationFinal();
  assert.ok(Date.now() - started < 3_000);
  assert.equal(final.status, "final");
  assert.equal(final.agents[0].steel.traceAvailable, false);
  assert.equal(final.agents[0].steel.replayAvailable, false);
  assert.equal(store.puts, 1);
});

test("Steel traces published after the fight ends are backfilled into the final evaluation", async () => {
  const store = new CountingStore();
  let published = false;
  const traceReads: string[] = [];
  // Until Steel publishes them, the released sessions' traces read as empty
  // and there is no recording.
  const steelFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/hls")) {
      return published ? new Response(PLAYLIST) : new Response("recording not ready", { status: 404 });
    }
    traceReads.push(url.pathname);
    const events = !published ? [] : url.pathname.includes("/steel-racer-1/") ? [DECOY_CLICK] : [PAGE_LOAD];
    return Response.json({ events, total: events.length, hasMore: false });
  }) as typeof fetch;
  const { coordinator } = setup({
    store,
    mode: "live",
    sessions: new SteelSessions(),
    steelFetch,
    steelEvidenceTimeoutMs: 200,
    steelEvidenceRetryMs: 50,
    steelBackfillDelaysMs: [20, 60],
  });
  const streamed: Array<number | undefined> = [];
  coordinator.subscribe((change) => {
    if (change.kind === "fight") streamed.push(pointerOf(coordinator)?.updatedAt);
  });
  await coordinator.prepareAndStart(T);
  await playWin(coordinator);

  const first = await coordinator.whenEvaluationFinal();
  published = true;
  const firstPointer = pointerOf(coordinator);
  const gptFirst = first.agents[0];
  assert.deepEqual(
    [gptFirst.steel.traceAvailable, gptFirst.steel.trace, gptFirst.steel.replayAvailable],
    [true, [], false],
  );
  assert.equal(gptFirst.sabotage[0].reaction, "recovered");
  assert.equal(gptFirst.sabotage[0].evidence.replayOffsetSec, null);
  assert.equal(store.puts, 1);

  await until(() => store.puts === 2);
  const updated = coordinator.evaluation(T + 500_000);
  assert.equal(updated.status, "final");
  assert.equal(updated.generatedAt, first.generatedAt);
  const gpt = updated.agents[0];
  assert.deepEqual(gpt.steel.trace.map((entry) => [entry.type, entry.label, entry.decoy]), [["click", "Continue", true]]);
  assert.equal(gpt.steel.replayAvailable, true);
  // What depends on the evidence is re-derived: Steel saw the decoy click, and the replay has a start.
  assert.deepEqual([gpt.sabotage[0].reaction, gpt.sabotage[0].deceived], ["deceived", true]);
  assert.equal(gpt.sabotage[0].evidence.replayOffsetSec, 50);
  assert.deepEqual(updated.agents[1].steel.trace.map((entry) => entry.type), ["navigate"]);
  const unchanged = (evaluation: FightEvaluation) => evaluation.agents.map((agent) =>
    [agent.outcome, agent.durationMs, agent.steps, agent.trace, agent.crowd]);
  assert.deepEqual(unchanged(updated), unchanged(first));

  // Stored, where the latest put wins, and published like the first final evaluation.
  assert.deepEqual(await store.get("race-eval"), updated);
  assert.deepEqual(await coordinator.whenEvaluationFinal(), updated);
  const pointer = pointerOf(coordinator);
  assert.ok(pointer && firstPointer && pointer.updatedAt > firstPointer.updatedAt);
  assert.equal(pointer.status, "final");
  assert.equal(streamed.at(-1), pointer.updatedAt, "the fight stream carries the new pointer");

  // Nothing is missing any more, so nothing is read again.
  const reads = traceReads.length;
  await sleep(100);
  assert.equal(traceReads.length, reads);
  assert.equal(store.puts, 2);

  // The backfilled evaluation is the one a timely read would have produced.
  const { coordinator: timely } = setup({ mode: "live", sessions: new SteelSessions(), steelFetch });
  await timely.prepareAndStart(T);
  await playWin(timely);
  assert.deepEqual(updated, await timely.whenEvaluationFinal());
});

test("the Steel backfill stops for good when the coordinator shuts down", async () => {
  const reads: string[] = [];
  // Steel never publishes: every trace reads as empty and there is no recording.
  const steelFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    reads.push(url.pathname);
    return url.pathname.endsWith("/hls")
      ? new Response("recording not ready", { status: 404 })
      : Response.json({ events: [], total: 0, hasMore: false });
  }) as typeof fetch;
  const options = {
    mode: "live" as const,
    steelFetch,
    steelEvidenceTimeoutMs: 200,
    steelEvidenceRetryMs: 50,
    steelBackfillDelaysMs: [20, 40, 60, 80],
  };

  const store = new CountingStore();
  const { coordinator } = setup({ ...options, store, sessions: new SteelSessions() });
  await coordinator.prepareAndStart(T);
  await playWin(coordinator);
  const final = await coordinator.whenEvaluationFinal();
  const atFinal = reads.length;
  await until(() => reads.length > atFinal);
  await coordinator.shutdown();
  const atShutdown = reads.length;
  await sleep(150);
  assert.equal(reads.length, atShutdown, "no Steel reads after shutdown");
  assert.equal(store.puts, 1);
  assert.deepEqual(coordinator.evaluation(), final);

  // Shut down while the closing evidence is still being read: no backfill ever starts.
  const closing = setup({ ...options, sessions: new SteelSessions() }).coordinator;
  await closing.prepareAndStart(T);
  await playWin(closing);
  await closing.shutdown();
  await closing.whenEvaluationFinal();
  const atClose = reads.length;
  await sleep(150);
  assert.equal(reads.length, atClose);
});

test("Steel backfill failures are absorbed and never undo the final evaluation", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    let phase: "closing" | "down" | "published" = "closing";
    let downRequests = 0;
    const steelFetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (phase === "down") {
        // The first background read finds Steel unreachable (8 requests); the next one works.
        downRequests += 1;
        if (downRequests >= 8) phase = "published";
        throw new Error("getaddrinfo ENOTFOUND api.steel.dev");
      }
      if (url.pathname.endsWith("/hls")) {
        return phase === "published" ? new Response(PLAYLIST) : new Response("not ready", { status: 404 });
      }
      const events = phase !== "published" ? [] : url.pathname.includes("/steel-racer-1/") ? [DECOY_CLICK] : [PAGE_LOAD];
      return Response.json({ events, total: events.length, hasMore: false });
    }) as typeof fetch;
    const store = new FirstPutOnlyStore();
    let datasetPuts = 0;
    const datasetStore: DatasetStore = {
      put: () => {
        datasetPuts += 1;
        if (datasetPuts > 1) throw new Error("dataset disk full");
        return Promise.resolve();
      },
      list: async () => [],
      readFile: async () => null,
    };
    const { coordinator } = setup({
      store,
      datasetStore,
      mode: "live",
      sessions: new SteelSessions(),
      steelFetch,
      steelEvidenceTimeoutMs: 200,
      steelEvidenceRetryMs: 50,
      steelBackfillDelaysMs: [10, 30, 60],
    });
    coordinator.subscribe(() => {
      throw new Error("a broken subscriber");
    });
    await coordinator.prepareAndStart(T);
    await playWin(coordinator);
    const first = await coordinator.whenEvaluationFinal();
    phase = "down";

    await until(() => coordinator.evaluation().agents[0].steel.trace.length > 0);
    const updated = coordinator.evaluation();
    assert.equal(updated.status, "final");
    assert.equal(pointerOf(coordinator)?.status, "final");
    assert.equal(updated.agents[0].sabotage[0].reaction, "deceived");
    assert.equal(downRequests, 8, "one background read found Steel down");
    assert.equal(store.puts, 2, "the rejected put was attempted");
    assert.deepEqual(await store.get("race-eval"), first, "the store keeps what it last wrote");
    assert.equal(datasetPuts, 2, "the throwing put was attempted");
    await settle();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("keeps the frame before a hit and the first one 1.5 s after it as evidence", async () => {
  const { coordinator } = setup({ mode: "simulated" });
  await coordinator.prepareAndStart(T);
  const frame = (label: string, capturedAt: number): CapturedFrame => ({
    contentType: "image/svg+xml",
    body: `<svg>${label}</svg>`,
    capturedAt,
  });
  await coordinator.recordCheckpoint("racer-1", 1, T + 20_000);
  coordinator.recordAgentFrame("racer-1", frame("A", T + 39_000), T + 39_000);
  await coordinator.recordCheckpoint("racer-1", 2, T + 40_000);

  const beforeFrames = pointerOf(coordinator)?.updatedAt ?? 0;
  coordinator.recordAgentFrame("racer-1", frame("B", T + 41_000), T + 41_000);
  assert.equal(pointerOf(coordinator)?.updatedAt, beforeFrames, "an ordinary frame is not an input");
  coordinator.recordAgentFrame("racer-1", frame("C", T + 41_600), T + 41_600);
  assert.ok((pointerOf(coordinator)?.updatedAt ?? 0) > beforeFrames, "a keyframe is an input");
  coordinator.recordAgentFrame("racer-1", frame("D", T + 50_000), T + 50_000);

  assert.equal(coordinator.evidenceFrame("racer-1", "legacy-step-1-before")?.body, "<svg>A</svg>");
  assert.equal(coordinator.evidenceFrame("racer-1", "legacy-step-1-after")?.body, "<svg>C</svg>");
  assert.equal(coordinator.evidenceFrame("racer-1", "legacy-step-1-after")?.contentType, "image/svg+xml");
  assert.equal(coordinator.evidenceFrame("racer-2", "legacy-step-1-before"), null);
  assert.equal(coordinator.evidenceFrame("racer-9", "legacy-step-1-before"), null);
  assert.equal(coordinator.frame("racer-1")?.body, "<svg>D</svg>");

  const evidence = coordinator.evaluation(T + 51_000).agents[0].sabotage[0].evidence;
  assert.deepEqual(evidence, {
    before: { key: "legacy-step-1-before", capturedAt: T + 39_000, contentType: "image/svg+xml" },
    after: { key: "legacy-step-1-after", capturedAt: T + 41_600, contentType: "image/svg+xml" },
    replayOffsetSec: null,
  });
  await coordinator.shutdown();
});
