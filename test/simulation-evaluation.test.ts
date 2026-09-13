import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import type {
  DatasetEpisode,
  DatasetManifest,
  DatasetStep,
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

    // The training dataset: the server's mode by default, every closed fight in the window.
    const zipped = await app.inject({ method: "GET", url: "/api/datasets/export.zip" });
    assert.equal(zipped.statusCode, 200);
    assert.equal(zipped.headers["content-type"], "application/zip");
    assert.match(
      String(zipped.headers["content-disposition"]),
      /filename="sabotage-markets-dataset-\d{4}-\d{2}-\d{2}\.zip"/,
    );
    const bundle = unzipSync(new Uint8Array(zipped.rawPayload));
    function lines<T>(name: string): T[] {
      return strFromU8(bundle[name]).split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
    }
    const manifest = JSON.parse(strFromU8(bundle["manifest.json"])) as DatasetManifest;
    const episodes = lines<DatasetEpisode>("episodes.jsonl");
    const steps = lines<DatasetStep>("steps.jsonl");
    assert.deepEqual([manifest.filters.mode, manifest.filters.days], ["simulated", 30]);
    assert.ok(manifest.counts.fights >= matrix.evaluations, `${manifest.counts.fights} fights`);
    assert.deepEqual([manifest.counts.episodes, manifest.counts.steps], [episodes.length, steps.length]);
    assert.ok(episodes.every((episode) => episode.schemaVersion === 1 && episode.mode === "simulated"));
    const settledId = settled.raceId;
    assert.deepEqual(
      episodes.filter((episode) => episode.raceId === settledId).map((episode) => episode.racerId),
      ["racer-1", "racer-2", "racer-3", "racer-4"],
      "the resolved fight exports four episodes",
    );
    const settledSteps = steps.filter((step) => step.raceId === settledId);
    assert.ok(settledSteps.length > 0, "the resolved fight has steps");
    assert.ok(settledSteps.some((step) => step.observation !== null), "steps carry what the agent saw");
    assert.ok(settledSteps.some((step) => step.reasoning !== null), "steps carry the agent's reasoning");
    // As for a live runner, a step that repeats the previous tool call without
    // progress is wasted (the dataset compares action-based signatures).
    const runs = new Map<string, DatasetStep[]>();
    for (const step of steps) {
      const key = `${step.raceId}:${step.racerId}`;
      runs.set(key, [...(runs.get(key) ?? []), step]);
    }
    let repeats = 0;
    for (const run of runs.values()) {
      run.sort((left, right) => left.step - right.step);
      run.forEach((step, index) => {
        const previous = run[index - 1];
        if (!previous || JSON.stringify(previous.action) !== JSON.stringify(step.action)) return;
        if (step.labels.quality === "harmful" || step.labels.quality === "progress") return;
        repeats += 1;
        assert.equal(step.labels.quality, "wasted", `${step.id} repeats ${JSON.stringify(step.action)}`);
      });
    }
    assert.ok(repeats > 0, "the export has repeated tool calls to check");

    const shots = steps.filter((step) => step.screenshot !== null);
    assert.ok(shots.length > 0, "steps link the screenshots their observations were taken with");
    for (const step of shots) assert.ok(bundle[step.screenshot as string], `${step.screenshot} is in the zip`);
    assert.equal(manifest.counts.screenshots, new Set(shots.map((step) => step.screenshot)).size);
  } finally {
    await app.close();
  }
});
