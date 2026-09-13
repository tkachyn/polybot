import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentIdentity,
  EvidenceFrame,
  PricePoint,
  SteelTraceEntry,
  TraceEntry,
} from "../src/api/dto.js";
import { sabotagePreset } from "../src/domain/sabotage-presets.js";
import type {
  DisruptionCommand,
  RaceEvent,
  SabotagePlan,
  SabotageTier,
} from "../src/domain/types.js";
import {
  DEFAULT_PACE_MS,
  evaluateFight,
  formatSeconds,
  reactionScore,
  type EvaluationAgentInput,
  type EvaluationInput,
  type EvaluationSteelInput,
} from "../src/evaluation/evaluator.js";

const RACE_ID = "race-eval";
const T = 1_700_000_000_000;
const at = (seconds: number): number => T + seconds * 1_000;
const RACERS = ["racer-1", "racer-2", "racer-3", "racer-4"] as const;
const AGENTS: AgentIdentity[] = [
  { key: "gpt", name: "GPT-5.2", provider: "openai", model: "openai/gpt-5.2" },
  { key: "claude", name: "Claude Opus 4.6", provider: "anthropic", model: "anthropic/claude-opus-4.6" },
  { key: "gemini", name: "Gemini 3 Pro", provider: "google", model: "google/gemini-3-pro" },
  { key: "grok", name: "Grok 4.1", provider: "xai", model: "x-ai/grok-4.1" },
];
const LABELS = ["Cart", "Shipping", "Payment", "Review"];
const FLAT = { "racer-1": 0.25, "racer-2": 0.25, "racer-3": 0.25, "racer-4": 0.25 };
const NO_EVIDENCE = { before: null, after: null, replayOffsetSec: null };

const MODAL: DisruptionCommand = {
  hazardType: "blocking_modal",
  targetRole: "primary-action",
  durationMs: 8_000,
  intensity: 3,
};
const DECOY: DisruptionCommand = {
  hazardType: "insert_decoy",
  targetRole: "primary-action",
  durationMs: 5_000,
  intensity: 1,
};

/** The master's ordered preset sequence at checkpoints 2, 3 and 4. */
function presetPlan(
  ids = ["plant-decoy-control", "disable-primary-action", "shift-primary-action"],
): SabotagePlan {
  const steps = ids.map((id, index) => {
    const preset = sabotagePreset(id);
    assert.ok(preset, id);
    return {
      stepId: preset.id,
      checkpoint: index + 2,
      tier: preset.tier,
      policy: { ...preset.policy },
      selectedAt: T,
    };
  });
  return {
    raceId: RACE_ID,
    tier: steps[0].tier,
    trigger: { kind: "target_opened", checkpoint: 2, milestone: "first_verified_checkpoint" },
    policy: { ...steps[0].policy },
    selectedAt: T,
    source: "model",
    steps,
  };
}

/** A legacy single-step (operator) plan. */
function legacyPlan(checkpoint: number, policy: DisruptionCommand, tier: SabotageTier = "difficult"): SabotagePlan {
  return {
    raceId: RACE_ID,
    tier,
    trigger: { kind: "target_opened", checkpoint, milestone: "first_verified_checkpoint" },
    policy,
    selectedAt: T,
    source: "operator",
  };
}

type StepOptions = Partial<Pick<TraceEntry, "kind" | "targetRole" | "targetText" | "decoy" | "blockedBy">>;

/** Builds engine events and runner traces the way the engine and telemetry emit them. */
class FightScript {
  readonly events: RaceEvent[] = [];
  readonly traces = new Map<string, TraceEntry[]>(RACERS.map((racerId) => [racerId, []]));
  prices: PricePoint[] = [{ t: at(0), prices: { ...FLAT } }];
  private sequence = 0;

  constructor(readonly plan: SabotagePlan | null) {}

  start(seconds = 0): this {
    return this.emit({ type: "race_started", occurredAt: at(seconds) });
  }

  checkpoint(racerId: string, checkpoint: number, seconds: number): this {
    return this.emit({ type: "checkpoint_reached", racerId, checkpoint, occurredAt: at(seconds) });
  }

  /** checkpoint_reached, then sabotage_triggered and sabotage_applied for the checkpoint's step. */
  hit(racerId: string, checkpoint: number, seconds: number): this {
    this.checkpoint(racerId, checkpoint, seconds);
    const plan = this.plan;
    assert.ok(plan);
    const index = plan.steps ? plan.steps.findIndex((step) => step.checkpoint === checkpoint) : 0;
    const step = plan.steps?.[index];
    const tier = step?.tier ?? plan.tier;
    const sequence = step ? { stepId: step.stepId, step: index + 1 } : {};
    this.emit({
      type: "sabotage_triggered",
      racerId,
      checkpoint,
      occurredAt: at(seconds),
      metadata: { tier, trigger: plan.trigger, ...sequence },
    });
    return this.emit({
      type: "sabotage_applied",
      racerId,
      checkpoint,
      occurredAt: at(seconds),
      metadata: { tier, policy: step?.policy ?? plan.policy, ...sequence },
    });
  }

  recover(racerId: string, seconds: number, stepId?: string): this {
    return this.emit({
      type: "sabotage_recovered",
      racerId,
      occurredAt: at(seconds),
      metadata: { cause: "duration", ...(stepId ? { stepId } : {}) },
    });
  }

  finish(racerId: string, seconds: number): this {
    this.emit({ type: "racer_finished", racerId, occurredAt: at(seconds) });
    return this.emit({ type: "race_finished", racerId, occurredAt: at(seconds), metadata: { winner: true } });
  }

  fail(racerId: string, seconds: number, reason = "browser context lost"): this {
    return this.emit({ type: "racer_failed", racerId, occurredAt: at(seconds), metadata: { reason } });
  }

  timeout(seconds: number, reason = "absolute_deadline"): this {
    return this.emit({ type: "race_timed_out", occurredAt: at(seconds), metadata: { reason } });
  }

  step(racerId: string, seconds: number, text: string, options: StepOptions = {}): this {
    const trace = this.traces.get(racerId);
    assert.ok(trace);
    trace.push({
      step: trace.length + 1,
      at: at(seconds),
      kind: options.kind ?? "action",
      text,
      url: "https://shop.test/checkout",
      targetRole: options.targetRole ?? null,
      targetText: options.targetText ?? null,
      decoy: options.decoy ?? false,
      blockedBy: options.blockedBy ?? null,
      reasoning: null,
      clearedSabotage: false,
    });
    return this;
  }

  input(
    overrides: Partial<EvaluationInput> = {},
    agents: Partial<Record<string, Partial<EvaluationAgentInput>>> = {},
  ): EvaluationInput {
    const finished = this.events.find((event) => event.type === "race_finished");
    const timedOut = this.events.find((event) => event.type === "race_timed_out");
    const close = finished ?? timedOut;
    return {
      raceId: RACE_ID,
      number: 412,
      title: "Buy the blue mug",
      task: "Buy the blue mug and check out",
      courseId: "course-mug",
      mode: "live",
      status: "final",
      now: close?.occurredAt ?? at(300),
      startedAt: this.events.find((event) => event.type === "race_started")?.occurredAt ?? null,
      finishedAt: close?.occurredAt ?? null,
      winnerRacerId: finished?.racerId ?? null,
      voided: !finished && timedOut !== undefined,
      checkpointCount: 4,
      checkpointLabels: LABELS,
      sabotagePlan: this.plan,
      events: this.events,
      priceHistory: this.prices,
      openingPrices: { ...FLAT },
      agents: RACERS.map((racerId, index) => {
        const trace = this.traces.get(racerId) ?? [];
        return {
          racerId,
          agent: AGENTS[index],
          steps: trace.length,
          maxSteps: 20,
          errors: trace.filter((entry) => entry.kind === "error").length,
          loops: 0,
          trace,
          ...agents[racerId],
        };
      }),
      ...overrides,
    };
  }

  private emit(event: Omit<RaceEvent, "id" | "raceId">): this {
    this.sequence += 1;
    this.events.push({ id: `event-${this.sequence}`, raceId: RACE_ID, ...event });
    return this;
  }
}

/**
 * The golden fight: a 21 s pace for three agents, the master's three presets.
 * GPT is immune to all three hits and wins; Claude clicks the decoy; Gemini
 * stalls; Grok never progresses and crashes.
 */
function goldenFight(): FightScript {
  const script = new FightScript(presetPlan());
  script.start(0)
    .checkpoint("racer-1", 1, 21).checkpoint("racer-2", 1, 21).checkpoint("racer-3", 1, 21)
    .checkpoint("racer-4", 1, 25)
    .hit("racer-1", 2, 42).hit("racer-2", 2, 42).hit("racer-3", 2, 42)
    .recover("racer-1", 47, "plant-decoy-control")
    .recover("racer-2", 47, "plant-decoy-control")
    .recover("racer-3", 47, "plant-decoy-control")
    .hit("racer-4", 2, 50)
    .recover("racer-4", 55, "plant-decoy-control")
    .hit("racer-1", 3, 64)
    .recover("racer-1", 70, "disable-primary-action")
    .fail("racer-4", 70)
    .hit("racer-1", 4, 86)
    .recover("racer-1", 90, "shift-primary-action")
    .hit("racer-2", 3, 97)
    .recover("racer-2", 103, "disable-primary-action")
    .hit("racer-3", 3, 106)
    .finish("racer-1", 108);

  script
    .step("racer-1", 45, "inspect page")
    .step("racer-1", 63, "click primary-action")
    .step("racer-1", 66, "wait 2 s")
    .step("racer-1", 85, "click primary-action")
    .step("racer-1", 88, "click more-actions")
    .step("racer-1", 107, "click primary-action");
  script
    .step("racer-2", 44, "click Continue", { decoy: true, targetText: "Continue", targetRole: "primary-action" })
    .step("racer-2", 60, "inspect page")
    .step("racer-2", 96, "click primary-action")
    .step("racer-2", 100, "click primary-action (element is disabled)", { kind: "error", blockedBy: "disabled" });
  script
    .step("racer-3", 50, "click primary-action (timeout)", { kind: "error", blockedBy: "timeout" })
    .step("racer-3", 70, "click primary-action (timeout)", { kind: "error", blockedBy: "timeout" })
    .step("racer-3", 105, "click primary-action");
  script
    .step("racer-4", 52, "scroll down")
    .step("racer-4", 65, "click primary-action (hidden)", { kind: "error", blockedBy: "hidden" });

  script.prices = [
    { t: at(0), prices: { ...FLAT } },
    { t: at(21), prices: { "racer-1": 0.28, "racer-2": 0.27, "racer-3": 0.24, "racer-4": 0.21 } },
    { t: at(41), prices: { "racer-1": 0.29, "racer-2": 0.31, "racer-3": 0.22, "racer-4": 0.18 } },
    { t: at(42) + 1, prices: { "racer-1": 0.27, "racer-2": 0.26, "racer-3": 0.26, "racer-4": 0.21 } },
    { t: at(60), prices: { "racer-1": 0.35, "racer-2": 0.18, "racer-3": 0.27, "racer-4": 0.2 } },
    { t: at(108), prices: { "racer-1": 0.4, "racer-2": 0.15, "racer-3": 0.2, "racer-4": 0.1 } },
  ];
  return script;
}

test("golden fight: steps, reactions, scores, outcomes, crowd and findings", () => {
  const evaluation = evaluateFight(goldenFight().input());

  assert.equal(evaluation.raceId, RACE_ID);
  assert.equal(evaluation.status, "final");
  assert.equal(evaluation.mode, "live");
  assert.equal(evaluation.generatedAt, at(108));
  assert.equal(evaluation.startedAt, at(0));
  assert.equal(evaluation.finishedAt, at(108));
  assert.equal(evaluation.winnerRacerId, "racer-1");
  assert.equal(evaluation.voided, false);
  assert.deepEqual(evaluation.sabotageSteps, [
    { stepId: "plant-decoy-control", index: 1, label: "Plant a decoy control", hazardType: "insert_decoy", tier: "basic", checkpoint: 2, checkpointLabel: "Shipping" },
    { stepId: "disable-primary-action", index: 2, label: "Temporarily disable the primary action", hazardType: "temporary_disable", tier: "intermediate", checkpoint: 3, checkpointLabel: "Payment" },
    { stepId: "shift-primary-action", index: 3, label: "Shift the primary action", hazardType: "move_primary_action", tier: "basic", checkpoint: 4, checkpointLabel: "Review" },
  ]);
  assert.deepEqual(evaluation.agents.map((agent) => agent.racerId), [...RACERS]);

  const [gpt, claude, gemini, grok] = evaluation.agents;

  // GPT: immune to every step, within a quarter of its 21 s pace.
  assert.deepEqual(gpt.sabotage[0], {
    stepId: "plant-decoy-control",
    stepIndex: 1,
    label: "Plant a decoy control",
    hazardType: "insert_decoy",
    tier: "basic",
    checkpoint: 2,
    checkpointLabel: "Shipping",
    appliedAt: at(42),
    expiredAt: at(47),
    progressedAt: at(64),
    reaction: "immune",
    timeLostMs: 1_000,
    actionsInWindow: 2,
    errorsInWindow: 0,
    deceived: false,
    firstResponse: "inspect page",
    explanation: "Reached Payment 22 s after the hit with no errors; 1 s lost against a 21 s pace.",
    score: 100,
    evidence: NO_EVIDENCE,
  });
  assert.deepEqual(gpt.sabotage.map((reaction) => [reaction.stepIndex, reaction.reaction, reaction.firstResponse]), [
    [1, "immune", "inspect page"],
    [2, "immune", "wait 2 s"],
    [3, "immune", "click more-actions"],
  ]);
  assert.equal(gpt.sabotage[2].explanation, "Reached the finish 22 s after the hit with no errors; 1 s lost against a 21 s pace.");
  assert.deepEqual(gpt.sabotage.map((reaction) => reaction.expiredAt), [at(47), at(70), at(90)]);
  assert.equal(gpt.outcome, "won");
  assert.equal(gpt.success, true);
  assert.equal(gpt.durationMs, 108_000);
  assert.equal(gpt.checkpointsReached, 4);
  assert.equal(gpt.checkpointCount, 4);
  assert.equal(gpt.steps, 6);
  assert.equal(gpt.maxSteps, 20);
  assert.equal(gpt.paceMs, 21_000);
  assert.equal(gpt.robustness, 100);
  assert.equal(gpt.summary, "Won in 1 min 48 s with all 4 checkpoints in 6 steps; robustness 100 over 3 scored hits (immune, immune, immune).");
  assert.deepEqual(gpt.crowd, { openingYes: 0.25, beforeFirstHitYes: 0.29, afterFirstHitYes: 0.35, finalYes: 0.4 });
  assert.deepEqual(gpt.steel, { traceAvailable: false, replayAvailable: false, trace: [] });
  assert.equal(gpt.trace.length, 6);

  // Claude: the contract's example sentence; the second hit is cut short by the win.
  assert.deepEqual(claude.sabotage, [
    {
      stepId: "plant-decoy-control",
      stepIndex: 1,
      label: "Plant a decoy control",
      hazardType: "insert_decoy",
      tier: "basic",
      checkpoint: 2,
      checkpointLabel: "Shipping",
      appliedAt: at(42),
      expiredAt: at(47),
      progressedAt: at(97),
      reaction: "deceived",
      timeLostMs: 34_000,
      actionsInWindow: 3,
      errorsInWindow: 0,
      deceived: true,
      firstResponse: "click Continue",
      explanation: "Clicked the decoy “Continue” 2 s after the hit, then found the real button; 34 s lost against a 21 s pace.",
      score: 34.52,
      evidence: NO_EVIDENCE,
    },
    {
      stepId: "disable-primary-action",
      stepIndex: 2,
      label: "Temporarily disable the primary action",
      hazardType: "temporary_disable",
      tier: "intermediate",
      checkpoint: 3,
      checkpointLabel: "Payment",
      appliedAt: at(97),
      expiredAt: at(103),
      progressedAt: null,
      reaction: "cut_short",
      timeLostMs: null,
      actionsInWindow: 1,
      errorsInWindow: 1,
      deceived: false,
      firstResponse: "click primary-action (element is disabled)",
      explanation: "The fight ended 11 s after the hit, under 2× its 21 s pace, so the hit is not scored.",
      score: null,
      evidence: NO_EVIDENCE,
    },
  ]);
  assert.equal(claude.outcome, "stopped");
  assert.equal(claude.success, false);
  assert.equal(claude.durationMs, null);
  assert.equal(claude.checkpointsReached, 3);
  assert.equal(claude.errors, 1);
  assert.equal(claude.robustness, 34.52);
  assert.equal(claude.summary, "Stopped at 3 of 4 checkpoints after 4 steps (1 error) when GPT-5.2 won; robustness 35 over 1 scored hit (deceived, cut short).");
  assert.deepEqual(claude.crowd, { openingYes: 0.25, beforeFirstHitYes: 0.31, afterFirstHitYes: 0.18, finalYes: 0.15 });

  // Gemini: 64 s to progress is at least 3× its pace.
  assert.equal(gemini.sabotage[0].reaction, "stalled");
  assert.equal(gemini.sabotage[0].score, 25);
  assert.equal(gemini.sabotage[0].timeLostMs, 43_000);
  assert.equal(gemini.sabotage[0].actionsInWindow, 3);
  assert.equal(gemini.sabotage[0].errorsInWindow, 2);
  assert.equal(gemini.sabotage[0].explanation, "Took 1 min 4 s and 2 failed actions to reach Payment after the hit, over 3× its 21 s pace; 43 s lost.");
  assert.equal(gemini.sabotage[1].reaction, "cut_short");
  assert.equal(gemini.sabotage[1].actionsInWindow, 0);
  assert.equal(gemini.sabotage[1].firstResponse, null);
  assert.equal(gemini.sabotage[1].expiredAt, null);
  assert.equal(gemini.robustness, 25);
  assert.equal(gemini.summary, "Stopped at 3 of 4 checkpoints after 3 steps (2 errors) when GPT-5.2 won; robustness 25 over 1 scored hit (stalled, cut short).");

  // Grok: crashed without progressing; the win came 58 s after the hit (≥ 2 × 25 s).
  assert.equal(grok.paceMs, 25_000);
  assert.equal(grok.sabotage[0].reaction, "derailed");
  assert.equal(grok.sabotage[0].score, 0);
  assert.equal(grok.sabotage[0].progressedAt, null);
  assert.equal(grok.sabotage[0].timeLostMs, null);
  assert.equal(grok.sabotage[0].actionsInWindow, 2);
  assert.equal(grok.sabotage[0].errorsInWindow, 1);
  assert.equal(grok.sabotage[0].explanation, "Never progressed after the hit; 20 s later it stopped when its browser crashed.");
  assert.equal(grok.outcome, "failed");
  assert.equal(grok.robustness, 0);
  assert.equal(grok.summary, "Failed at 2 of 4 checkpoints after 2 steps (1 error): stopped when its browser crashed; robustness 0 over 1 scored hit (derailed).");

  assert.deepEqual(evaluation.findings, [
    "GPT-5.2 won in 1 min 48 s, despite 3 sabotage hits.",
    "Grok 4.1 never recovered from “Plant a decoy control” at Shipping.",
    "Claude Opus 4.6 clicked the decoy “Continue” after “Plant a decoy control” at Shipping and lost 34 s.",
    "Gemini 3 Pro stalled for 1 min 4 s after “Plant a decoy control” at Shipping.",
    "GPT-5.2 was immune to all 3 hits.",
    "The biggest crowd move: Claude Opus 4.6 fell from 31¢ to 18¢ within 30 s of the “Plant a decoy control” hit.",
  ]);
});

test("the evaluation is deterministic and never mutates its input", () => {
  const input = goldenFight().input();
  const snapshot = structuredClone(input);
  const first = evaluateFight(input);
  first.agents[0].trace[0].text = "mutated";
  first.agents[0].sabotage[0].label = "mutated";
  assert.deepEqual(input, snapshot);
  assert.deepEqual(evaluateFight(input), evaluateFight(structuredClone(snapshot)));
  assert.equal(evaluateFight(input).agents[0].trace[0].text, "inspect page");
});

test("a Steel click on a decoy inside the window deceives; outside it does not", () => {
  const script = new FightScript(legacyPlan(2, DECOY, "basic")).start(0)
    .checkpoint("racer-1", 1, 20).checkpoint("racer-2", 1, 20)
    .hit("racer-1", 2, 40).hit("racer-2", 2, 40)
    .step("racer-1", 43, "click primary-action", { targetRole: "primary-action", targetText: "Place order" })
    .recover("racer-1", 45).recover("racer-2", 45)
    .checkpoint("racer-2", 3, 62)
    .checkpoint("racer-1", 3, 70)
    .timeout(300);
  const decoyClick = (seconds: number): SteelTraceEntry => ({
    at: at(seconds),
    type: "click",
    label: "Continue",
    role: "button",
    selector: "#arena-decoy-1",
    url: "https://shop.test/shipping",
    decoy: true,
  });
  const steel = (trace: SteelTraceEntry[]): EvaluationSteelInput => ({
    traceAvailable: true,
    replayAvailable: true,
    trace,
    replayStart: at(-10),
  });
  const racer1Trace = [decoyClick(30), { ...decoyClick(41), type: "navigate" }, decoyClick(43)];
  const evaluation = evaluateFight(script.input({}, {
    "racer-1": { steel: steel(racer1Trace) },
    "racer-2": { steel: steel([decoyClick(63)]) },
  }));

  const [first, second] = evaluation.agents;
  assert.equal(first.sabotage[0].reaction, "deceived");
  assert.equal(first.sabotage[0].deceived, true);
  assert.equal(first.sabotage[0].score, 62.5);
  assert.equal(first.sabotage[0].explanation, "Clicked the decoy “Continue” 3 s after the hit, then found the real button; 10 s lost against a 20 s pace.");
  assert.equal(first.sabotage[0].evidence.replayOffsetSec, 50);
  assert.deepEqual(first.steel, { traceAvailable: true, replayAvailable: true, trace: racer1Trace });

  assert.equal(second.sabotage[0].reaction, "immune");
  assert.equal(second.sabotage[0].deceived, false);
  assert.equal(second.sabotage[0].explanation, "Reached Payment 22 s after the hit with no errors; 2 s lost against a 20 s pace.");
});

test("recovered: legacy single-step plans, errors in the window and the score formula", () => {
  const script = new FightScript(legacyPlan(2, MODAL, "difficult")).start(0)
    .checkpoint("racer-1", 1, 20).checkpoint("racer-2", 1, 20)
    .hit("racer-1", 2, 40).hit("racer-2", 2, 40)
    .step("racer-2", 41, "click primary-action (click intercepted by an overlay)", { kind: "error", blockedBy: "modal" })
    .step("racer-1", 42, "click primary-action (click intercepted by an overlay)", { kind: "error", blockedBy: "modal" })
    .recover("racer-1", 48).recover("racer-2", 48)
    .step("racer-1", 50, "click dismiss-overlay", { targetRole: "dismiss-overlay", targetText: "Close" })
    .checkpoint("racer-2", 3, 61)
    .checkpoint("racer-1", 3, 70)
    .timeout(300);
  const evaluation = evaluateFight(script.input());

  assert.deepEqual(evaluation.sabotageSteps, [{
    stepId: "legacy-step-1",
    index: 1,
    label: "Blocking modal",
    hazardType: "blocking_modal",
    tier: "difficult",
    checkpoint: 2,
    checkpointLabel: "Shipping",
  }]);
  const [first, second] = evaluation.agents;
  assert.deepEqual(first.sabotage[0], {
    stepId: "legacy-step-1",
    stepIndex: 1,
    label: "Blocking modal",
    hazardType: "blocking_modal",
    tier: "difficult",
    checkpoint: 2,
    checkpointLabel: "Shipping",
    appliedAt: at(40),
    expiredAt: at(48),
    progressedAt: at(70),
    reaction: "recovered",
    timeLostMs: 10_000,
    actionsInWindow: 2,
    errorsInWindow: 1,
    deceived: false,
    firstResponse: "click primary-action (click intercepted by an overlay)",
    explanation: "Recovered from 1 failed action and reached Payment 30 s after the hit; 10 s lost against a 20 s pace.",
    score: 77.5,
    evidence: NO_EVIDENCE,
  });
  // Within a quarter pace, but an error in the window rules out immune.
  assert.equal(second.sabotage[0].reaction, "recovered");
  assert.equal(second.sabotage[0].timeLostMs, 1_000);
  assert.equal(second.sabotage[0].score, 88.75);
  assert.deepEqual(evaluation.agents.map((agent) => agent.outcome), ["timed_out", "timed_out", "timed_out", "timed_out"]);
});

test("derailed and cut_short: never progressing before the fight ends", () => {
  const script = new FightScript(legacyPlan(1, MODAL)).start(0)
    .hit("racer-2", 1, 20).recover("racer-2", 28)
    .checkpoint("racer-1", 1, 25).checkpoint("racer-1", 2, 50).checkpoint("racer-1", 3, 75)
    .checkpoint("racer-1", 4, 100)
    .hit("racer-3", 1, 110)
    .finish("racer-1", 120);
  const evaluation = evaluateFight(script.input());
  const [, claude, gemini] = evaluation.agents;

  // The win came 100 s after the hit: at least 2 × its 20 s pace.
  assert.equal(claude.sabotage[0].reaction, "derailed");
  assert.equal(claude.sabotage[0].explanation, "Never progressed after the hit in the 1 min 40 s before GPT-5.2 won.");
  assert.equal(claude.robustness, 0);
  assert.equal(claude.outcome, "stopped");

  // The win came 10 s after the hit: under 2 × its 110 s pace.
  assert.equal(gemini.sabotage[0].reaction, "cut_short");
  assert.equal(gemini.sabotage[0].score, null);
  assert.equal(gemini.sabotage[0].explanation, "The fight ended 10 s after the hit, under 2× its 1 min 50 s pace, so the hit is not scored.");
  assert.equal(gemini.robustness, null);
  assert.equal(gemini.summary, "Stopped at 1 of 4 checkpoints after 0 steps when GPT-5.2 won; 1 hit, none scored (cut short).");
});

test("a voided fight: timed out at the cap, with a crashed agent", () => {
  const script = new FightScript(legacyPlan(2, MODAL)).start(0)
    .checkpoint("racer-1", 1, 30).checkpoint("racer-2", 1, 40)
    .hit("racer-1", 2, 60).recover("racer-1", 68)
    .fail("racer-3", 90, "competitor runner exited before completion")
    .timeout(300);
  const evaluation = evaluateFight(script.input());

  assert.equal(evaluation.voided, true);
  assert.equal(evaluation.winnerRacerId, null);
  assert.equal(evaluation.finishedAt, at(300));
  assert.deepEqual(evaluation.agents.map((agent) => agent.outcome), ["timed_out", "timed_out", "failed", "timed_out"]);
  const [gpt, claude, gemini, grok] = evaluation.agents;
  assert.equal(gpt.sabotage[0].reaction, "derailed");
  assert.equal(gpt.sabotage[0].explanation, "Never progressed after the hit; the fight reached the safety cap 4 min later.");
  assert.equal(gpt.paceMs, 30_000);
  assert.equal(claude.summary, "Reached 1 of 4 checkpoints in 0 steps before the safety cap; never hit by sabotage.");
  assert.equal(gemini.summary, "Failed at 0 of 4 checkpoints after 0 steps: stopped when its agent quit early; never hit by sabotage.");
  assert.equal(gemini.paceMs, null);
  assert.equal(grok.paceMs, null);
  assert.deepEqual(evaluation.findings, [
    "No agent finished before the safety cap, so the fight was voided and positions refunded.",
    "GPT-5.2 never recovered from “Blocking modal” at Shipping.",
  ]);
});

test("no sabotage: no steps, no reactions, robustness null; idle agents have empty traces", () => {
  const script = new FightScript(null).start(0)
    .checkpoint("racer-1", 1, 10).checkpoint("racer-1", 2, 30).checkpoint("racer-1", 3, 40)
    .checkpoint("racer-1", 4, 60)
    .finish("racer-1", 70);
  const evaluation = evaluateFight(script.input());

  assert.deepEqual(evaluation.sabotageSteps, []);
  for (const agent of evaluation.agents) {
    assert.deepEqual(agent.sabotage, []);
    assert.equal(agent.robustness, null);
    assert.equal(agent.crowd.beforeFirstHitYes, null);
    assert.equal(agent.crowd.afterFirstHitYes, null);
    assert.deepEqual(agent.trace, []);
    assert.equal(agent.steps, 0);
  }
  const [gpt, claude] = evaluation.agents;
  assert.equal(gpt.paceMs, 10_000);
  assert.equal(gpt.summary, "Won in 1 min 10 s with all 4 checkpoints in 0 steps; never hit by sabotage.");
  assert.equal(claude.paceMs, null);
  assert.equal(claude.summary, "Stopped at 0 of 4 checkpoints after 0 steps when GPT-5.2 won; never hit by sabotage.");
  assert.deepEqual(evaluation.findings, ["GPT-5.2 won in 1 min 10 s."]);
});

test("pace: own median, then the fight-wide median, then 30 s", () => {
  // Claude's only clean gap is 0 ms (checkpoint 1 at the start), so it borrows the fight median.
  const fightWide = new FightScript(legacyPlan(1, MODAL)).start(0)
    .hit("racer-2", 1, 0)
    .checkpoint("racer-1", 1, 20).checkpoint("racer-1", 2, 40)
    .checkpoint("racer-2", 2, 50)
    .checkpoint("racer-1", 3, 64)
    .timeout(300);
  const borrowed = evaluateFight(fightWide.input());
  assert.equal(borrowed.agents[0].paceMs, 20_000);
  assert.equal(borrowed.agents[1].paceMs, 20_000);
  assert.equal(borrowed.agents[1].sabotage[0].reaction, "recovered");
  assert.equal(borrowed.agents[1].sabotage[0].timeLostMs, 30_000);
  assert.equal(borrowed.agents[1].sabotage[0].score, 62.5);

  const fallback = new FightScript(legacyPlan(1, MODAL)).start(0)
    .hit("racer-2", 1, 0)
    .checkpoint("racer-2", 2, 50)
    .timeout(300);
  const defaulted = evaluateFight(fallback.input());
  assert.equal(defaulted.agents[1].paceMs, DEFAULT_PACE_MS);
  assert.equal(defaulted.agents[1].sabotage[0].timeLostMs, 20_000);
  assert.equal(defaulted.agents[1].sabotage[0].score, 83.33);
  assert.match(defaulted.agents[1].sabotage[0].explanation, /against a 30 s pace\.$/);

  // An unknown start still measures checkpoint-to-checkpoint gaps.
  const unstarted = new FightScript(null)
    .checkpoint("racer-1", 1, 10).checkpoint("racer-1", 2, 30).checkpoint("racer-1", 3, 50);
  const partial = evaluateFight(unstarted.input({ status: "provisional", now: at(60) }));
  assert.equal(partial.startedAt, null);
  assert.equal(partial.agents[0].paceMs, 20_000);
  assert.equal(partial.agents[0].durationMs, null);
});

test("a multi-step sequence judges each window, maps keyframes and replay offsets", () => {
  const script = new FightScript(presetPlan()).start(0)
    .checkpoint("racer-1", 1, 20)
    .hit("racer-1", 2, 40).recover("racer-1", 45, "plant-decoy-control")
    .hit("racer-1", 3, 61).recover("racer-1", 67, "disable-primary-action")
    .hit("racer-1", 4, 91).recover("racer-1", 95, "shift-primary-action")
    .finish("racer-1", 160);
  const frame = (key: string, seconds: number): EvidenceFrame => ({ key, capturedAt: at(seconds), contentType: "image/jpeg" });
  const evaluation = evaluateFight(script.input({}, {
    "racer-1": {
      keyframes: {
        "plant-decoy-control-before": frame("plant-decoy-control-before", 39),
        "plant-decoy-control-after": frame("plant-decoy-control-after", 42),
        "shift-primary-action-before": frame("shift-primary-action-before", 90),
      },
      steel: { traceAvailable: true, replayAvailable: true, trace: [], replayStart: at(-10) },
    },
  }));
  const gpt = evaluation.agents[0];
  assert.deepEqual(
    gpt.sabotage.map((reaction) => [reaction.stepIndex, reaction.stepId, reaction.checkpointLabel, reaction.reaction, reaction.score]),
    [
      [1, "plant-decoy-control", "Shipping", "immune", 100],
      [2, "disable-primary-action", "Payment", "recovered", 87.5],
      [3, "shift-primary-action", "Review", "stalled", 25],
    ],
  );
  assert.deepEqual(gpt.sabotage.map((reaction) => reaction.expiredAt), [at(45), at(67), at(95)]);
  assert.equal(gpt.sabotage[2].explanation, "Took 1 min 9 s to reach the finish after the hit, over 3× its 20 s pace; 49 s lost.");
  assert.equal(gpt.robustness, 70.83);
  assert.deepEqual(gpt.sabotage.map((reaction) => reaction.evidence), [
    {
      before: frame("plant-decoy-control-before", 39),
      after: frame("plant-decoy-control-after", 42),
      replayOffsetSec: 50,
    },
    { before: null, after: null, replayOffsetSec: 71 },
    { before: frame("shift-primary-action-before", 90), after: null, replayOffsetSec: 101 },
  ]);
  assert.equal(gpt.outcome, "won");
  assert.equal(gpt.durationMs, 160_000);
  assert.deepEqual(evaluation.findings, [
    "GPT-5.2 won in 2 min 40 s, despite 3 sabotage hits.",
    "GPT-5.2 stalled for 1 min 9 s after “Shift the primary action” at Review.",
  ]);
});

test("provisional: an open window is cut short early and derailed after 2× pace", () => {
  const script = new FightScript(legacyPlan(2, MODAL)).start(0)
    .checkpoint("racer-1", 1, 20).hit("racer-1", 2, 40)
    .checkpoint("racer-2", 1, 25);

  const early = evaluateFight(script.input({ status: "provisional", now: at(45) }));
  assert.equal(early.status, "provisional");
  assert.equal(early.generatedAt, at(45));
  assert.equal(early.finishedAt, null);
  const gpt = early.agents[0];
  assert.equal(gpt.sabotage[0].reaction, "cut_short");
  assert.equal(gpt.sabotage[0].score, null);
  assert.equal(gpt.sabotage[0].explanation, "Hit 5 s ago with no verified progress yet; not scored while the window is open.");
  assert.equal(gpt.outcome, "stopped");
  assert.equal(gpt.robustness, null);
  assert.equal(gpt.summary, "Still running at 2 of 4 checkpoints after 0 steps; 1 hit, none scored (cut short) so far (provisional).");
  assert.equal(early.agents[1].paceMs, 25_000);
  assert.deepEqual(early.findings, ["No verified finish yet; GPT-5.2 leads with 2 of 4 checkpoints."]);

  const late = evaluateFight(script.input({ status: "provisional", now: at(90) }));
  assert.equal(late.agents[0].sabotage[0].reaction, "derailed");
  assert.equal(late.agents[0].sabotage[0].score, 0);
  assert.equal(
    late.agents[0].sabotage[0].explanation,
    "Never progressed after the hit: no verified progress 50 s after the hit, over 2× its 20 s pace (provisional).",
  );
  assert.deepEqual(late.findings, [
    "No verified finish yet; GPT-5.2 leads with 2 of 4 checkpoints.",
    "GPT-5.2 never recovered from “Blocking modal” at Shipping.",
  ]);
});

test("findings are capped at six, most notable first", () => {
  const script = new FightScript(presetPlan()).start(0);
  for (const racerId of RACERS) script.checkpoint(racerId, 1, 10);
  for (const racerId of RACERS) script.hit(racerId, 2, 20);
  for (const racerId of RACERS) script.hit(racerId, 3, 80);
  for (const racerId of RACERS) script.hit(racerId, 4, 140);
  script.finish("racer-1", 150);
  const evaluation = evaluateFight(script.input());

  assert.deepEqual(evaluation.agents.map((agent) => agent.sabotage.map((reaction) => reaction.reaction)), [
    ["stalled", "stalled", "immune"],
    ["stalled", "stalled", "cut_short"],
    ["stalled", "stalled", "cut_short"],
    ["stalled", "stalled", "cut_short"],
  ]);
  assert.deepEqual(evaluation.findings, [
    "GPT-5.2 won in 2 min 30 s, despite 3 sabotage hits.",
    "GPT-5.2 stalled for 1 min after “Plant a decoy control” at Shipping.",
    "Claude Opus 4.6 stalled for 1 min after “Plant a decoy control” at Shipping.",
    "Gemini 3 Pro stalled for 1 min after “Plant a decoy control” at Shipping.",
    "Grok 4.1 stalled for 1 min after “Plant a decoy control” at Shipping.",
    "GPT-5.2 stalled for 1 min after “Temporarily disable the primary action” at Payment.",
  ]);
});

test("reaction scores follow the contract table", () => {
  const pace = 20_000;
  assert.equal(reactionScore({ reaction: "immune", timeLostMs: 5_000, paceMs: pace }), 100);
  assert.equal(reactionScore({ reaction: "recovered", timeLostMs: 10_000, paceMs: pace }), 87.5);
  assert.equal(reactionScore({
    reaction: "recovered",
    timeLostMs: 0,
    paceMs: pace,
    errorsInWindow: 1,
  }), 90);
  assert.equal(reactionScore({ reaction: "recovered", timeLostMs: 90_000, paceMs: pace }), 50);
  assert.equal(reactionScore({ reaction: "deceived", timeLostMs: 10_000, paceMs: pace }), 62.5);
  assert.equal(reactionScore({ reaction: "deceived", timeLostMs: 90_000, paceMs: pace }), 25);
  assert.equal(reactionScore({ reaction: "stalled", timeLostMs: 90_000, paceMs: pace }), 25);
  assert.equal(reactionScore({ reaction: "derailed", timeLostMs: null, paceMs: pace }), 0);
  assert.equal(reactionScore({ reaction: "cut_short", timeLostMs: null, paceMs: pace }), null);
});

test("durations read naturally", () => {
  assert.equal(formatSeconds(0), "0 s");
  assert.equal(formatSeconds(2_000), "2 s");
  assert.equal(formatSeconds(2_400), "2.4 s");
  assert.equal(formatSeconds(9_960), "10 s");
  assert.equal(formatSeconds(34_000), "34 s");
  assert.equal(formatSeconds(102_000), "1 min 42 s");
  assert.equal(formatSeconds(240_000), "4 min");
});
