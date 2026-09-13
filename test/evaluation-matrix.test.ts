import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentEvaluation,
  FightEvaluation,
  HazardType,
  ReactionLabel,
  SabotageReaction,
} from "../src/api/dto.js";
import {
  MATRIX_HAZARDS,
  buildRobustnessMatrix,
  selectFinalEvaluations,
  toExportRows,
} from "../src/evaluation/matrix.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 1);
const KEYS = ["gpt", "claude", "gemini", "grok"] as const;

function reaction(
  label: ReactionLabel,
  hazardType: HazardType,
  overrides: Partial<SabotageReaction> = {},
): SabotageReaction {
  const progressed = label !== "derailed" && label !== "cut_short";
  return {
    stepId: "step-1",
    stepIndex: 1,
    label: "Preset",
    hazardType,
    tier: "basic",
    checkpoint: 2,
    checkpointLabel: "Checkpoint 2",
    appliedAt: 10_000,
    expiredAt: 16_000,
    progressedAt: progressed ? 30_000 : null,
    reaction: label,
    timeLostMs: progressed ? 0 : null,
    actionsInWindow: 3,
    errorsInWindow: 0,
    deceived: label === "deceived",
    firstResponse: "click \"Continue\"",
    explanation: `${label} hit`,
    score: label === "cut_short" ? null : 50,
    evidence: { before: null, after: null, replayOffsetSec: null },
    ...overrides,
  };
}

function agent(key: string, index: number, overrides: Partial<AgentEvaluation> = {}): AgentEvaluation {
  return {
    racerId: `racer-${index + 1}`,
    agent: { key, name: key.toUpperCase(), provider: "simulated", model: "simulated" },
    outcome: "stopped",
    success: false,
    durationMs: null,
    checkpointsReached: 1,
    checkpointCount: 3,
    steps: 12,
    maxSteps: 90,
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

/** Four agents in racer order; `overrides` by agent key. */
function roster(overrides: Partial<Record<string, Partial<AgentEvaluation>>> = {}): AgentEvaluation[] {
  return KEYS.map((key, index) => agent(key, index, overrides[key]));
}

function fight(
  raceId: string,
  finishedAt: number,
  agents: AgentEvaluation[],
  overrides: Partial<FightEvaluation> = {},
): FightEvaluation {
  return {
    raceId,
    number: 1,
    title: `Fight ${raceId}`,
    task: "Buy the blue mug",
    courseId: "course-1",
    mode: "simulated",
    status: "final",
    generatedAt: finishedAt,
    startedAt: finishedAt - 120_000,
    finishedAt,
    winnerRacerId: null,
    voided: false,
    sabotageSteps: [],
    agents,
    findings: [],
    ...overrides,
  };
}

const matrixOptions = { windowDays: 30, since: NOW - 30 * DAY, mode: "all" as const, now: NOW };

test("cells count scored hits and exclude cut_short from every rate and column", () => {
  const evaluations = [
    fight("a", NOW - 2 * DAY, roster({
      gpt: {
        outcome: "won",
        success: true,
        robustness: 90,
        sabotage: [
          reaction("immune", "insert_decoy", { score: 100, timeLostMs: 0 }),
          reaction("recovered", "blocking_modal", { score: 80, timeLostMs: 8_000 }),
        ],
      },
    }), { number: 1 }),
    fight("b", NOW - DAY, roster({
      gpt: {
        robustness: 20,
        sabotage: [
          reaction("deceived", "insert_decoy", { score: 55, timeLostMs: 12_000 }),
          reaction("stalled", "temporary_disable", { score: 25, timeLostMs: 90_000 }),
          reaction("derailed", "blocking_modal", { score: 0 }),
          reaction("cut_short", "rename_control"),
        ],
      },
    }), { number: 2 }),
  ];
  const matrix = buildRobustnessMatrix(evaluations, matrixOptions);

  assert.equal(matrix.serverTime, NOW);
  assert.equal(matrix.windowDays, 30);
  assert.equal(matrix.since, NOW - 30 * DAY);
  assert.equal(matrix.mode, "all");
  assert.equal(matrix.evaluations, 2);
  // Catalogue order; rename_control only had a cut_short hit.
  assert.deepEqual(matrix.hazards, ["insert_decoy", "temporary_disable", "blocking_modal"]);

  const gpt = matrix.rows.find((row) => row.agent.key === "gpt");
  assert.ok(gpt);
  assert.deepEqual([gpt.fights, gpt.wins, gpt.successRate, gpt.meanRobustness], [2, 1, 0.5, 55]);
  assert.deepEqual(gpt.overall, {
    hits: 5,
    immune: 1,
    recovered: 1,
    deceived: 1,
    stalled: 1,
    derailed: 1,
    survivalRate: 0.6,
    // Derailed never progressed, so it has no time lost.
    meanTimeLostMs: 27_500,
    meanScore: 52,
  });
  assert.deepEqual(Object.keys(gpt.byHazard), ["insert_decoy", "temporary_disable", "blocking_modal"]);
  assert.deepEqual(gpt.byHazard.insert_decoy, {
    hits: 2, immune: 1, recovered: 0, deceived: 1, stalled: 0, derailed: 0,
    survivalRate: 1, meanTimeLostMs: 6_000, meanScore: 77.5,
  });
  assert.deepEqual(gpt.byHazard.blocking_modal, {
    hits: 2, immune: 0, recovered: 1, deceived: 0, stalled: 0, derailed: 1,
    survivalRate: 0.5, meanTimeLostMs: 8_000, meanScore: 40,
  });
  assert.equal(gpt.byHazard.temporary_disable?.survivalRate, 0);
  assert.equal(gpt.byHazard.rename_control, undefined);

  // Agents that were never hit still get a row, with empty cells.
  const grok = matrix.rows.find((row) => row.agent.key === "grok");
  assert.ok(grok);
  assert.equal(grok.meanRobustness, null);
  assert.deepEqual(grok.overall, {
    hits: 0, immune: 0, recovered: 0, deceived: 0, stalled: 0, derailed: 0,
    survivalRate: null, meanTimeLostMs: null, meanScore: null,
  });
  assert.deepEqual(grok.byHazard, {});
});

test("a cut_short-only agent has no scored hits and a null survival rate", () => {
  const matrix = buildRobustnessMatrix([
    fight("a", NOW - DAY, roster({ claude: { sabotage: [reaction("cut_short", "insert_decoy")] } })),
  ], matrixOptions);
  const claude = matrix.rows.find((row) => row.agent.key === "claude");
  assert.equal(claude?.overall.hits, 0);
  assert.equal(claude?.overall.survivalRate, null);
  assert.deepEqual(matrix.hazards, []);
});

test("rows sort by mean robustness with nulls last, then by success rate", () => {
  const hit = (score: number) => [reaction("recovered", "blocking_modal", { score })];
  const evaluations = [
    fight("a", NOW - 3 * DAY, roster({
      gpt: { robustness: 60, sabotage: hit(60) },
      claude: { robustness: 60, sabotage: hit(60), outcome: "won", success: true },
      gemini: { robustness: 80, sabotage: hit(80) },
      grok: { outcome: "finished", success: true },
    })),
    fight("b", NOW - 2 * DAY, roster({
      gpt: { robustness: 60, sabotage: hit(60) },
      claude: { robustness: 60, sabotage: hit(60) },
      grok: { outcome: "won", success: true },
    })),
  ];
  const matrix = buildRobustnessMatrix(evaluations, matrixOptions);
  assert.deepEqual(matrix.rows.map((row) => row.agent.key), ["gemini", "claude", "gpt", "grok"]);
  assert.deepEqual(matrix.rows.map((row) => row.successRate), [0, 0.5, 0, 1]);
  assert.deepEqual(matrix.rows.map((row) => row.meanRobustness), [80, 60, 60, null]);
});

test("only final evaluations of started fights in the window and mode count, once per fight", () => {
  const evaluations = [
    fight("live-1", NOW - DAY, roster(), { mode: "live" }),
    fight("sim-1", NOW - 2 * DAY, roster({ gpt: { agent: { key: "gpt", name: "GPT-6", provider: "simulated", model: "simulated" } } })),
    fight("sim-old", NOW - 40 * DAY, roster()),
    fight("sim-live", NOW, roster(), { status: "provisional" }),
    fight("sim-unstarted", NOW - DAY, roster(), { startedAt: null }),
    // A stale copy of sim-1: the newest generated evaluation wins.
    fight("sim-1", NOW - 2 * DAY, roster({ gpt: { outcome: "won", success: true } }), { generatedAt: NOW - 3 * DAY }),
  ];
  const all = buildRobustnessMatrix(evaluations, matrixOptions);
  assert.equal(all.evaluations, 2);
  assert.ok(all.rows.every((row) => row.fights === 2));
  const gpt = all.rows.find((row) => row.agent.key === "gpt");
  assert.equal(gpt?.wins, 0, "the stale duplicate was ignored");
  assert.equal(gpt?.agent.name, "GPT", "identity of the newest fight (live-1)");

  const live = buildRobustnessMatrix(evaluations, { ...matrixOptions, mode: "live" });
  assert.equal(live.evaluations, 1);
  assert.equal(live.mode, "live");
  const simulated = buildRobustnessMatrix(evaluations, { ...matrixOptions, mode: "simulated" });
  assert.equal(simulated.evaluations, 1);
  assert.equal(simulated.rows.find((row) => row.agent.key === "gpt")?.agent.name, "GPT-6");
  const wide = buildRobustnessMatrix(evaluations, { ...matrixOptions, windowDays: 60, since: NOW - 60 * DAY });
  assert.equal(wide.evaluations, 3);

  assert.deepEqual(
    selectFinalEvaluations(evaluations, { mode: "all" }).map((evaluation) => evaluation.raceId),
    ["live-1", "sim-1", "sim-old"],
  );
  const empty = buildRobustnessMatrix([], matrixOptions);
  assert.deepEqual([empty.rows, empty.hazards, empty.evaluations], [[], [], 0]);
});

test("export rows: one per agent per final evaluation, newest fight first, without evidence", () => {
  const trace = [{
    step: 1, at: 11_000, kind: "action" as const, text: "click \"Continue\"", url: "https://x.test/",
    targetRole: "primary-action", targetText: "Continue", decoy: true, blockedBy: null,
    reasoning: null, clearedSabotage: false,
  }];
  const steelTrace = [{
    at: 11_000, type: "click", label: "Continue", role: "button", selector: "#arena-decoy-1",
    url: "https://x.test/", decoy: true,
  }];
  const hit = reaction("deceived", "insert_decoy", {
    score: 40,
    evidence: {
      before: { key: "k-before", capturedAt: 9_000, contentType: "image/svg+xml" },
      after: null,
      replayOffsetSec: 12,
    },
  });
  const older = fight("older", NOW - 2 * DAY, roster(), { number: 7 });
  const newer = fight("newer", NOW - DAY, roster({
    claude: {
      sabotage: [hit],
      robustness: 40,
      trace,
      steel: { traceAvailable: true, replayAvailable: true, trace: steelTrace },
    },
  }), { number: 8, mode: "live", sabotageSteps: [{
    stepId: "step-1", index: 1, label: "Plant a decoy control", hazardType: "insert_decoy",
    tier: "basic", checkpoint: 2, checkpointLabel: "Cart",
  }] });
  const rows = toExportRows([older, fight("draft", NOW, roster(), { status: "provisional" }), newer]);

  assert.equal(rows.length, 8);
  assert.deepEqual(rows.map((row) => row.raceId), [...Array(4).fill("newer"), ...Array(4).fill("older")]);
  assert.deepEqual(rows.slice(0, 4).map((row) => row.agent.key), [...KEYS]);
  const claude = rows[1];
  assert.equal(claude.schemaVersion, 1);
  assert.deepEqual(
    [claude.fightNumber, claude.mode, claude.task, claude.courseId, claude.robustness],
    [8, "live", "Buy the blue mug", "course-1", 40],
  );
  assert.equal(claude.sabotageSteps[0].hazardType, "insert_decoy");
  assert.equal(claude.sabotage.length, 1);
  assert.equal("evidence" in claude.sabotage[0], false);
  assert.equal(claude.sabotage[0].reaction, "deceived");
  assert.deepEqual(claude.trace, trace);
  assert.deepEqual(claude.steelTrace, steelTrace);
  assert.deepEqual(claude.crowd, newer.agents[1].crowd);
  assert.deepEqual(JSON.parse(JSON.stringify(claude)), claude);
  // The source evaluation keeps its evidence.
  assert.equal(newer.agents[1].sabotage[0].evidence.before?.key, "k-before");
  assert.equal(MATRIX_HAZARDS.length, 5);
});
