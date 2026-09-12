import assert from "node:assert/strict";
import test from "node:test";
import type {
  EvaluationExportRow,
  FightDetailResponse,
  FightEvaluation,
  FightEvaluationResponse,
  FightListResponse,
  ReactionLabel,
  RobustnessMatrixResponse,
} from "../src/api/dto.js";
import { buildApi } from "../src/api/server.js";
import {
  createSimulatedCoordinatorFactory,
  startSimulationAutopilot,
} from "../src/simulation/index.js";

const TIME_SCALE = 60;
const HISTORY_FIGHTS = 4;
const LABELS: readonly ReactionLabel[] = ["immune", "recovered", "deceived", "stalled", "derailed", "cut_short"];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertFinalEvaluation(evaluation: FightEvaluation, raceId: string): void {
  assert.equal(evaluation.raceId, raceId);
  assert.equal(evaluation.mode, "simulated", "scripted agents are labelled as such");
  assert.equal(evaluation.status, "final");
  assert.deepEqual(evaluation.agents.map((agent) => agent.racerId), ["racer-1", "racer-2", "racer-3", "racer-4"]);
  for (const agent of evaluation.agents) {
    assert.equal(agent.agent.provider, "simulated");
    assert.ok(agent.trace.length > 0, `${agent.racerId} has a trace`);
    for (const reaction of agent.sabotage) {
      assert.ok(LABELS.includes(reaction.reaction), reaction.reaction);
      assert.ok(reaction.explanation.length > 0);
    }
  }
}

test("simulated fights close with final evaluations that feed the matrix and the export", { timeout: 90_000 }, async () => {
  const options = { seed: "evaluation-e2e", timeScale: TIME_SCALE };
  const app = buildApi({
    coordinatorFactory: createSimulatedCoordinatorFactory(options),
    mode: "simulated",
    fightNumberStart: 401,
    tickIntervalMs: 50,
    onRegistryReady: (registry) => startSimulationAutopilot(registry, {
      ...options,
      historyFights: HISTORY_FIGHTS,
      liveFights: 2,
      upcomingFights: 1,
    }),
  });
  try {
    await app.ready();

    // Seeded history: real traces with browser evidence, closed in the past.
    const resolved = ((await app.inject({ method: "GET", url: "/api/fights?status=resolved" }))
      .json() as FightListResponse).fights;
    assert.equal(resolved.length, HISTORY_FIGHTS);
    const labels = new Set<ReactionLabel>();
    let keyframe: { raceId: string; racerId: string; key: string } | null = null;
    const hourAgo = Date.now() - 3_600_000;
    for (const fight of resolved) {
      await app.registry.get(fight.raceId).whenEvaluationFinal();
      const response = await app.inject({ method: "GET", url: `/api/fights/${fight.raceId}/evaluation` });
      assert.equal(response.statusCode, 200);
      const evaluation = (response.json() as FightEvaluationResponse).evaluation;
      assertFinalEvaluation(evaluation, fight.raceId);
      assert.ok(evaluation.finishedAt !== null && evaluation.finishedAt < hourAgo, "history stays in the past");
      assert.ok(evaluation.generatedAt < hourAgo);
      assert.ok(
        evaluation.agents.some((agent) => agent.trace.some((entry) => entry.targetRole === "primary-action")),
        "steps carry the element they resolved to",
      );
      for (const agent of evaluation.agents) {
        for (const reaction of agent.sabotage) {
          labels.add(reaction.reaction);
          if (!keyframe && reaction.evidence.before) {
            keyframe = { raceId: fight.raceId, racerId: agent.racerId, key: reaction.evidence.before.key };
          }
        }
      }
    }
    assert.ok(labels.size >= 2, `varied history reactions: ${[...labels].join(", ")}`);
    assert.ok(keyframe, "seeded hits keep a before keyframe");
    const frame = await app.inject({
      method: "GET",
      url: `/api/fights/${keyframe.raceId}/agents/${keyframe.racerId}/evidence/${encodeURIComponent(keyframe.key)}`,
    });
    assert.equal(frame.statusCode, 200);
    assert.match(String(frame.headers["content-type"]), /^image\/svg\+xml/);
    assert.equal(frame.headers["cache-control"], "private, max-age=3600");

    // A live fight resolves; its pointer and evaluation turn final.
    const live = ((await app.inject({ method: "GET", url: "/api/fights?status=live" }))
      .json() as FightListResponse).fights;
    assert.ok(live.length > 0);
    let settled: FightEvaluation | undefined;
    const deadline = Date.now() + 45_000;
    while (!settled && Date.now() < deadline) {
      for (const fight of live) {
        const detail = (await app.inject({ method: "GET", url: `/api/fights/${fight.raceId}` }))
          .json() as FightDetailResponse;
        if (detail.fight.status !== "resolved" || detail.fight.voided) continue;
        if (detail.fight.evaluation?.status !== "final") continue;
        settled = ((await app.inject({ method: "GET", url: `/api/fights/${fight.raceId}/evaluation` }))
          .json() as FightEvaluationResponse).evaluation;
        break;
      }
      if (!settled) await delay(150);
    }
    assert.ok(settled, "a live fight resolved with a final evaluation");
    assertFinalEvaluation(settled, settled.raceId);
    assert.ok(settled.winnerRacerId);
    const winner = settled.agents.find((agent) => agent.racerId === settled?.winnerRacerId);
    assert.equal(winner?.outcome, "won");
    assert.equal(winner?.success, true);
    const hits = settled.agents.flatMap((agent) => agent.sabotage);
    assert.ok(hits.length > 0, "the winner at least crossed the sabotage checkpoint");
    assert.ok(hits.every((hit) => LABELS.includes(hit.reaction)));

    // The robustness matrix: the server's mode by default.
    const matrix = (await app.inject({ method: "GET", url: "/api/evaluations/matrix" }))
      .json() as RobustnessMatrixResponse;
    assert.deepEqual([matrix.mode, matrix.windowDays], ["simulated", 30]);
    assert.ok(matrix.evaluations >= HISTORY_FIGHTS + 1, `${matrix.evaluations} evaluations`);
    assert.equal(matrix.rows.length, 4);
    assert.ok(matrix.hazards.length > 0);
    assert.ok(matrix.rows.some((row) => row.overall.hits > 0));
    assert.ok(matrix.rows.every((row) => row.fights >= matrix.evaluations - 1));
    const liveOnly = (await app.inject({ method: "GET", url: "/api/evaluations/matrix?mode=live" }))
      .json() as RobustnessMatrixResponse;
    assert.deepEqual([liveOnly.evaluations, liveOnly.rows], [0, []]);

    // The dataset export: one row per agent per final evaluation, newest first.
    const exported = await app.inject({ method: "GET", url: "/api/evaluations/export.jsonl" });
    assert.equal(exported.statusCode, 200);
    assert.match(String(exported.headers["content-type"]), /^application\/x-ndjson/);
    assert.match(String(exported.headers["content-disposition"]), /filename="sabotage-markets-evaluations\.jsonl"/);
    const rows = exported.body.trimEnd().split("\n").map((line) => JSON.parse(line) as EvaluationExportRow);
    assert.equal(rows.length % 4, 0);
    assert.ok(rows.length >= matrix.evaluations * 4);
    assert.ok(rows.every((row) => row.schemaVersion === 1 && row.mode === "simulated"));
    assert.ok(rows.some((row) => row.raceId === settled?.raceId));
    assert.ok(rows.some((row) => row.sabotage.length > 0 && row.trace.some((entry) => entry.targetRole !== null)));
    const finishes = rows.filter((_, index) => index % 4 === 0).map((row) => row.finishedAt ?? 0);
    assert.deepEqual(finishes, [...finishes].sort((left, right) => right - left), "newest fights first");
  } finally {
    await app.close();
  }
});
