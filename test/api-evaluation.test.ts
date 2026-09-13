import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AgentEvaluation,
  FightEvaluation,
  FightEvaluationResponse,
  RobustnessMatrixResponse,
  SabotageReaction,
  ServerMode,
} from "../src/api/dto.js";
import type { CoordinatorFactory } from "../src/api/race-registry.js";
import { buildApi, defaultEvaluationStore } from "../src/api/server.js";
import type { CourseVerifier, RacerSessionManager } from "../src/application/contracts.js";
import { RaceCoordinator } from "../src/application/race-coordinator.js";
import type { DisruptionCommand } from "../src/domain/types.js";
import { InMemoryEvaluationStore, JsonlEvaluationStore } from "../src/evaluation/index.js";
import { InMemoryRaceEventStore } from "../src/persistence/in-memory-event-store.js";
import { createSimulatedCoordinatorFactory } from "../src/simulation/index.js";
import { InertCompetitorRunner } from "../src/simulation/runner.js";
import { FakeObstacles, createFactory, raceInput } from "./api-fixtures.js";

const DAY = 86_400_000;
const KEYS = ["gpt", "claude", "gemini", "grok"] as const;
const PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-PROGRAM-DATE-TIME:2026-09-12T10:00:00.000Z",
  "#EXTINF:4.0,",
  "https://storage.steel.test/seg-0.ts?X-Amz-Signature=abc",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

const verifier: CourseVerifier = {
  async verifyTargetOpening() { return true; },
  async verifyCheckpoint() { return true; },
  async verifyFinish() { return true; },
};

/** Live coordinators that keep their final evaluation in the registry's store. */
function evaluatingFactory(options: { steel?: boolean } = {}): CoordinatorFactory {
  const steelFetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path.endsWith("/hls")) return new Response(PLAYLIST, { status: 200 });
    if (path.includes("/agent-traces")) return Response.json({ events: [], hasMore: false });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return (input, context) => {
    const sessionManager: RacerSessionManager = {
      async create(racerId) { return { racerId, steelSessionId: `steel-${racerId}` }; },
      async release() {},
      async releaseAll() {},
    };
    if (options.steel) {
      sessionManager.evidence = (racerId) => ({ steelSessionId: `steel-${racerId}`, apiKey: "steel-test-key" });
    }
    return new RaceCoordinator({ ...input, fight: context.fight }, {
      sessionManager,
      agentRunner: new InertCompetitorRunner(),
      courseVerifier: verifier,
      eventStore: new InMemoryRaceEventStore(),
      obstacleProvider: input.obstaclesEnabled ? new FakeObstacles() : undefined,
      ledger: context.ledger,
      evaluationStore: context.evaluationStore,
      mode: "live",
      steelFetch,
    });
  };
}

function agentEval(key: string, index: number, overrides: Partial<AgentEvaluation> = {}): AgentEvaluation {
  return {
    racerId: `racer-${index + 1}`,
    agent: { key, name: key.toUpperCase(), provider: "openrouter", model: `${key}/model` },
    outcome: "stopped",
    success: false,
    durationMs: null,
    checkpointsReached: 1,
    checkpointCount: 3,
    steps: 10,
    maxSteps: 20,
    errors: 0,
    loops: 0,
    paceMs: 20_000,
    sabotage: [],
    robustness: null,
    summary: `${key} run`,
    crowd: { openingYes: 0.25, beforeFirstHitYes: null, afterFirstHitYes: null, finalYes: 0.25 },
    trace: [],
    steel: { traceAvailable: false, replayAvailable: false, trace: [] },
    ...overrides,
  };
}

/** A final evaluation whose first agent won after recovering from a modal. */
function fightEval(
  raceId: string,
  finishedAt: number,
  mode: ServerMode,
  overrides: Partial<FightEvaluation> = {},
): FightEvaluation {
  const hit: SabotageReaction = {
    stepId: "step-1",
    stepIndex: 1,
    label: "Cover the page with a modal",
    hazardType: "blocking_modal",
    tier: "difficult",
    checkpoint: 2,
    checkpointLabel: "Cart",
    appliedAt: finishedAt - 60_000,
    expiredAt: finishedAt - 52_000,
    progressedAt: finishedAt - 30_000,
    reaction: "recovered",
    timeLostMs: 10_000,
    actionsInWindow: 4,
    errorsInWindow: 1,
    deceived: false,
    firstResponse: "click \"Continue\"",
    explanation: "Recovered after one failed action.",
    score: 80,
    evidence: { before: null, after: null, replayOffsetSec: null },
  };
  return {
    raceId,
    number: 1,
    title: `Fight ${raceId}`,
    task: "Buy the blue mug",
    courseId: "course-1",
    mode,
    status: "final",
    generatedAt: finishedAt,
    startedAt: finishedAt - 120_000,
    finishedAt,
    winnerRacerId: "racer-1",
    voided: false,
    sabotageSteps: [],
    agents: KEYS.map((key, index) => agentEval(key, index, index === 0
      ? { outcome: "won", success: true, durationMs: 120_000, robustness: 80, sabotage: [hit] }
      : {})),
    findings: [],
    ...overrides,
  };
}

test("evaluation route: provisional while live, final after the finish, from the store after a prune", async () => {
  const store = new InMemoryEvaluationStore();
  const app = buildApi({ coordinatorFactory: evaluatingFactory(), enableTicker: false, evaluationStore: store });
  try {
    const t0 = Date.now() - 600_000;
    const decoy: DisruptionCommand = {
      hazardType: "insert_decoy",
      targetRole: "primary-action",
      durationMs: 4_000,
      intensity: 1,
    };
    const created = await app.inject({
      method: "POST",
      url: "/races",
      payload: {
        ...raceInput("race-eval", {
          obstaclesEnabled: true,
          sabotage: { checkpoint: 1, summary: "A decoy Continue button", policy: decoy },
        }),
        now: t0,
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const race = app.registry.get("race-eval");

    const live = await app.inject({ method: "GET", url: "/api/fights/race-eval/evaluation" });
    assert.equal(live.statusCode, 200);
    assert.equal(typeof live.json().serverTime, "number");
    const provisional = (live.json() as FightEvaluationResponse).evaluation;
    assert.deepEqual(
      [provisional.raceId, provisional.status, provisional.mode, provisional.agents.length],
      ["race-eval", "provisional", "live", 4],
    );
    const pointer = (await app.inject({ method: "GET", url: "/api/fights/race-eval" })).json().fight.evaluation;
    assert.equal(pointer.status, "provisional");

    // racer-1 is hit by the decoy at checkpoint 1, clicks it, then recovers and wins.
    race.recordAgentFrame("racer-1", {
      contentType: "image/svg+xml", body: "<svg>before</svg>", capturedAt: t0 + 9_000,
    }, t0 + 9_000);
    race.recordAgentAction("racer-1", {
      kind: "action", text: "click \"Continue\"", step: 1, maxSteps: 20,
      evidence: { target: { role: "primary-action", text: "Continue", decoy: false }, navigated: true },
    }, t0 + 9_500);
    await race.recordCheckpoint("racer-1", 1, t0 + 10_000);
    race.recordAgentAction("racer-1", {
      kind: "action", text: "click \"Continue now\"", step: 2, maxSteps: 20,
      evidence: { target: { role: "primary-action", text: "Continue now", decoy: true } },
    }, t0 + 11_000);
    race.recordAgentFrame("racer-1", {
      contentType: "image/svg+xml", body: "<svg>after</svg>", capturedAt: t0 + 12_000,
    }, t0 + 12_000);
    const moved = (await app.inject({ method: "GET", url: "/api/fights/race-eval" })).json().fight.evaluation;
    assert.ok(moved.updatedAt > pointer.updatedAt, "the pointer moves with new evidence");

    await race.tick(t0 + 15_000);
    await race.recordRecovery("racer-1", t0 + 16_000);
    await race.recordCheckpoint("racer-1", 2, t0 + 30_000);
    await race.recordCheckpoint("racer-1", 3, t0 + 50_000);
    await race.recordFinish("racer-1", t0 + 60_000);
    await race.whenEvaluationFinal();

    const done = await app.inject({ method: "GET", url: "/api/fights/race-eval/evaluation" });
    const final = (done.json() as FightEvaluationResponse).evaluation;
    assert.equal(final.status, "final");
    assert.equal(final.winnerRacerId, "racer-1");
    const winner = final.agents[0];
    assert.equal(winner.outcome, "won");
    assert.equal(winner.sabotage.length, 1);
    const hit = winner.sabotage[0];
    assert.deepEqual([hit.hazardType, hit.reaction, hit.deceived], ["insert_decoy", "deceived", true]);
    assert.ok(winner.trace.some((entry) => entry.decoy && entry.targetText === "Continue now"));
    const settled = (await app.inject({ method: "GET", url: "/api/fights/race-eval" })).json().fight.evaluation;
    assert.equal(settled.status, "final");

    // Keyframes around the hit: bytes, stored content type, private caching.
    const { before, after } = hit.evidence;
    assert.ok(before && after, "before and after keyframes");
    const evidence = (key: string, racerId = "racer-1", raceId = "race-eval") => app.inject({
      method: "GET",
      url: `/api/fights/${raceId}/agents/${racerId}/evidence/${encodeURIComponent(key)}`,
    });
    const beforeFrame = await evidence(before.key);
    assert.equal(beforeFrame.statusCode, 200);
    assert.equal(beforeFrame.headers["content-type"], "image/svg+xml");
    assert.equal(beforeFrame.headers["cache-control"], "private, max-age=3600");
    assert.equal(beforeFrame.body, "<svg>before</svg>");
    assert.equal((await evidence(after.key)).body, "<svg>after</svg>");
    for (const missing of [
      await evidence("nope"),
      await evidence(before.key, "racer-9"),
      await evidence(before.key, "racer-1", "missing"),
    ]) {
      assert.deepEqual([missing.statusCode, missing.json().code], [404, "not_found"]);
    }
    // No Steel session behind this fight, so no replay.
    const replay = await app.inject({ method: "GET", url: "/api/fights/race-eval/agents/racer-1/replay.m3u8" });
    assert.deepEqual([replay.statusCode, replay.json().code], [404, "not_found"]);

    // Pruned: the fight is gone, its final evaluation is served from the store.
    app.registry.prune(0);
    assert.equal((await app.inject({ method: "GET", url: "/api/fights/race-eval" })).statusCode, 404);
    const stored = await app.inject({ method: "GET", url: "/api/fights/race-eval/evaluation" });
    assert.equal(stored.statusCode, 200);
    assert.deepEqual((stored.json() as FightEvaluationResponse).evaluation, final);
    assert.equal((await evidence(before.key)).statusCode, 404);
    const unknown = await app.inject({ method: "GET", url: "/api/fights/missing/evaluation" });
    assert.deepEqual([unknown.statusCode, unknown.json().code], [404, "not_found"]);
  } finally {
    await app.close();
  }
});

test("replay route proxies the live Steel playlist and is a 404 in simulated mode", async () => {
  const app = buildApi({
    coordinatorFactory: evaluatingFactory({ steel: true }),
    enableTicker: false,
    evaluationStore: new InMemoryEvaluationStore(),
  });
  try {
    assert.equal((await app.inject({ method: "POST", url: "/races", payload: raceInput("race-steel") })).statusCode, 201);
    const replay = await app.inject({ method: "GET", url: "/api/fights/race-steel/agents/racer-2/replay.m3u8" });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers["content-type"], "application/vnd.apple.mpegurl");
    assert.equal(replay.headers["cache-control"], "no-store");
    assert.equal(replay.body, PLAYLIST);
    const unknownRacer = await app.inject({ method: "GET", url: "/api/fights/race-steel/agents/racer-9/replay.m3u8" });
    assert.equal(unknownRacer.statusCode, 404);
    const unknownFight = await app.inject({ method: "GET", url: "/api/fights/missing/agents/racer-1/replay.m3u8" });
    assert.equal(unknownFight.statusCode, 404);
  } finally {
    await app.close();
  }

  const sim = buildApi({
    coordinatorFactory: createSimulatedCoordinatorFactory({ seed: "replay", timeScale: 500 }),
    mode: "simulated",
    enableTicker: false,
  });
  try {
    const created = await sim.inject({
      method: "POST",
      url: "/races",
      payload: {
        raceId: "sim-replay",
        courseId: "sim-ssd-checkout",
        seed: "replay-seed",
        checkpointCount: 4,
        task: "Buy the cheapest SSD",
        startUrl: "https://shop.arena.test/",
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const replay = await sim.inject({ method: "GET", url: "/api/fights/sim-replay/agents/racer-1/replay.m3u8" });
    assert.deepEqual([replay.statusCode, replay.json().code], [404, "not_found"]);
    const evaluation = (await sim.inject({ method: "GET", url: "/api/fights/sim-replay/evaluation" }))
      .json() as FightEvaluationResponse;
    assert.equal(evaluation.evaluation.mode, "simulated");
  } finally {
    await sim.close();
  }
});

test("matrix and export read final evaluations in the window and mode, with validated params", async () => {
  const NOW = Date.UTC(2026, 8, 12, 12);
  const store = new InMemoryEvaluationStore();
  for (const evaluation of [
    fightEval("live-new", NOW - DAY / 2, "live", { number: 12 }),
    fightEval("live-old", NOW - 40 * DAY, "live", { number: 3 }),
    fightEval("sim-1", NOW - 2 * DAY, "simulated", { number: 402 }),
    fightEval("live-draft", NOW - DAY / 4, "live", { number: 13, status: "provisional" }),
  ]) {
    await store.put(evaluation);
  }
  const { factory } = createFactory();
  const app = buildApi({ coordinatorFactory: factory, enableTicker: false, evaluationStore: store, now: () => NOW });
  try {
    const matrix = (query = "") => app.inject({ method: "GET", url: `/api/evaluations/matrix${query}` });
    const defaults = (await matrix()).json() as RobustnessMatrixResponse;
    assert.deepEqual(
      [defaults.serverTime, defaults.windowDays, defaults.since, defaults.mode, defaults.evaluations],
      [NOW, 30, NOW - 30 * DAY, "live", 1],
    );
    assert.deepEqual(defaults.hazards, ["blocking_modal"]);
    assert.deepEqual(defaults.rows.map((row) => row.agent.key), ["gpt", "claude", "gemini", "grok"]);
    assert.deepEqual(
      [defaults.rows[0].overall.hits, defaults.rows[0].overall.recovered, defaults.rows[0].meanRobustness],
      [1, 1, 80],
    );
    const count = async (query: string) => ((await matrix(query)).json() as RobustnessMatrixResponse).evaluations;
    assert.equal(await count("?mode=all"), 2);
    assert.equal(await count("?mode=simulated"), 1);
    assert.equal(await count("?mode=live&days=60"), 2);
    assert.equal(await count("?days=1&mode=all"), 1);
    assert.equal(await count("?days=365&mode=all"), 3);
    assert.equal(((await matrix("?mode=all")).json() as RobustnessMatrixResponse).mode, "all");
    for (const query of [
      "?days=0", "?days=366", "?days=1.5", "?days=abc", "?days=-1", "?days=1e2", "?days=10&days=20",
      "?mode=bogus", "?mode=LIVE",
    ]) {
      const response = await matrix(query);
      assert.deepEqual([response.statusCode, response.json().code], [400, "invalid"], query);
    }

    // The per-agent evaluation export gave way to the dataset export (/api/datasets/*).
    const removed = await app.inject({ method: "GET", url: "/api/evaluations/export.jsonl" });
    assert.deepEqual([removed.statusCode, removed.json().code], [404, "not_found"]);
  } finally {
    await app.close();
  }
});

test("buildApi reads EVALUATION_FILE in live mode and keeps simulated evaluations in memory", async () => {
  assert.ok(defaultEvaluationStore("simulated", {}) instanceof InMemoryEvaluationStore);
  assert.ok(defaultEvaluationStore("simulated", { EVALUATION_FILE: "/tmp/sim.jsonl" }) instanceof JsonlEvaluationStore);
  assert.ok(defaultEvaluationStore("live", {}) instanceof JsonlEvaluationStore);

  const dir = await mkdtemp(join(tmpdir(), "evaluations-"));
  const previous = process.env.EVALUATION_FILE;
  try {
    const file = join(dir, "evaluations.jsonl");
    await writeFile(file, `${JSON.stringify(fightEval("live-file", Date.now() - DAY, "live"))}\n`);
    process.env.EVALUATION_FILE = file;
    const { factory } = createFactory();
    const app = buildApi({ coordinatorFactory: factory, enableTicker: false });
    try {
      const matrix = (await app.inject({ method: "GET", url: "/api/evaluations/matrix" })).json() as RobustnessMatrixResponse;
      assert.equal(matrix.evaluations, 1);
      const stored = await app.inject({ method: "GET", url: "/api/fights/live-file/evaluation" });
      assert.equal(stored.statusCode, 200);
      assert.equal((stored.json() as FightEvaluationResponse).evaluation.raceId, "live-file");
    } finally {
      await app.close();
    }
  } finally {
    if (previous === undefined) delete process.env.EVALUATION_FILE;
    else process.env.EVALUATION_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
