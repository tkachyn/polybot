/**
 * Pure, deterministic fight evaluation: how well each agent did the task and
 * how it reacted to each sabotage hit. The rules are docs/frontend-contract.md,
 * "Evaluation". Nothing here reads a clock or a random source: every time
 * comes from the input (event times, trace times, `now`).
 */
import type {
  AgentCrowdSignal,
  AgentEvaluation,
  AgentIdentity,
  AgentOutcome,
  EvaluatedSabotageStep,
  EvaluationStatus,
  EvidenceFrame,
  FightEvaluation,
  HazardType,
  PricePoint,
  ReactionLabel,
  SabotageReaction,
  SabotageTier,
  ServerMode,
  SteelTraceEntry,
  TraceEntry,
} from "../api/dto.js";
import { HAZARD_TYPES, hazardLabel } from "../domain/sabotage.js";
import { sabotagePreset } from "../domain/sabotage-presets.js";
import type { RaceEvent, SabotagePlan } from "../domain/types.js";

/** Pace used when neither the agent nor the fight has a clean progress gap. */
export const DEFAULT_PACE_MS = 30_000;
/** The crowd signal compares the price just before a hit with this much later. */
export const CROWD_AFTER_HIT_MS = 30_000;
export const MAX_FINDINGS = 6;
export const EVALUATION_TRACE_LIMIT = 500;
export const EVALUATION_STEEL_TRACE_LIMIT = 300;
/** Step id of a legacy single-step plan (the engine and sabotage getter use it too). */
export const LEGACY_SABOTAGE_STEP_ID = "legacy-step-1";

const TIERS: readonly SabotageTier[] = ["basic", "intermediate", "difficult"];

export type EvaluationSteelInput = {
  /** The Steel Agent Traces could be fetched. */
  traceAvailable: boolean;
  /** The Steel recording (HLS playlist) could be fetched. */
  replayAvailable: boolean;
  /** Oldest first. */
  trace: readonly SteelTraceEntry[];
  /** First EXT-X-PROGRAM-DATE-TIME of the recording, epoch ms. */
  replayStart: number | null;
};

export type EvaluationAgentInput = {
  racerId: string;
  agent: AgentIdentity;
  /** Actions used: the latest reported step. */
  steps: number;
  maxSteps: number;
  /** Error reports over the whole run (the trace itself is bounded). */
  errors: number;
  /** Episodes of three or more identical consecutive steps. */
  loops: number;
  /** Oldest first. */
  trace: readonly TraceEntry[];
  /** Stored keyframes by key: `<stepId>-before` and `<stepId>-after`. */
  keyframes?: Readonly<Record<string, EvidenceFrame>>;
  /** Live Steel sessions only. */
  steel?: EvaluationSteelInput | null;
};

export type EvaluationInput = {
  raceId: string;
  number: number;
  title: string;
  task: string;
  courseId: string;
  mode: ServerMode;
  status: EvaluationStatus;
  /** Becomes `generatedAt`; also ends any window still open while live. */
  now: number;
  startedAt: number | null;
  /** When the fight resolved (winner verified or closed); null while live. */
  finishedAt: number | null;
  winnerRacerId: string | null;
  voided: boolean;
  checkpointCount: number;
  /** Index k - 1 labels checkpoint k. */
  checkpointLabels: readonly string[];
  sabotagePlan: SabotagePlan | null;
  /** Engine events in emission order: the source of truth for progress and hits. */
  events: readonly RaceEvent[];
  /** Oldest first. */
  priceHistory: readonly PricePoint[];
  openingPrices: Readonly<Record<string, number>>;
  /** Racer order. */
  agents: readonly EvaluationAgentInput[];
};

/** The plan step a sabotage event belongs to. */
export function sabotageStepIdOf(event: Pick<RaceEvent, "metadata">): string {
  const stepId = event.metadata?.stepId;
  return typeof stepId === "string" && stepId.length > 0 ? stepId : LEGACY_SABOTAGE_STEP_ID;
}

/** Key of a stored keyframe: `<stepId>-before` or `<stepId>-after`. */
export function evidenceFrameKey(stepId: string, moment: "before" | "after"): string {
  return `${stepId}-${moment}`;
}

// ---------------------------------------------------------------------------
// Facts extracted from the engine events
// ---------------------------------------------------------------------------

type ProgressFact = { at: number; index: number; checkpoint: number | null };

type HitFact = {
  at: number;
  index: number;
  stepId: string;
  checkpoint: number | null;
  tier: SabotageTier | null;
  hazardType: HazardType | null;
};

type RecoveryFact = { at: number; index: number; stepId: string | null };

type RacerFacts = {
  /** Verified checkpoints and the verified finish (checkpoint null), in order. */
  progress: ProgressFact[];
  hits: HitFact[];
  recoveries: RecoveryFact[];
  finishedAt: number | null;
  failedAt: number | null;
  failReason: string | null;
};

type FightFacts = {
  startAt: number | null;
  closeAt: number | null;
  closeKind: "finished" | "timed_out" | null;
  closeReason: string | null;
  racers: Map<string, RacerFacts>;
};

function emptyRacerFacts(): RacerFacts {
  return {
    progress: [],
    hits: [],
    recoveries: [],
    finishedAt: null,
    failedAt: null,
    failReason: null,
  };
}

function isHazardType(value: unknown): value is HazardType {
  return typeof value === "string" && (HAZARD_TYPES as readonly string[]).includes(value);
}

function isTier(value: unknown): value is SabotageTier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

function collectFacts(input: EvaluationInput): FightFacts {
  const racers = new Map<string, RacerFacts>();
  const factsFor = (racerId: string): RacerFacts => {
    let facts = racers.get(racerId);
    if (!facts) {
      facts = emptyRacerFacts();
      racers.set(racerId, facts);
    }
    return facts;
  };
  for (const agent of input.agents) factsFor(agent.racerId);

  let startAt: number | null = null;
  let closeAt: number | null = null;
  let closeKind: FightFacts["closeKind"] = null;
  let closeReason: string | null = null;

  input.events.forEach((event, index) => {
    const at = event.occurredAt;
    if (typeof at !== "number" || !Number.isFinite(at)) return;
    const metadata = event.metadata ?? {};
    switch (event.type) {
      case "race_started":
        startAt ??= at;
        return;
      case "race_finished":
        if (closeKind === null) {
          closeAt = at;
          closeKind = "finished";
        }
        return;
      case "race_timed_out":
        if (closeKind === null) {
          closeAt = at;
          closeKind = "timed_out";
          closeReason = typeof metadata.reason === "string" ? metadata.reason : "absolute_deadline";
        }
        return;
      default:
        break;
    }
    if (!event.racerId) return;
    const facts = factsFor(event.racerId);
    switch (event.type) {
      case "checkpoint_reached":
        facts.progress.push({ at, index, checkpoint: event.checkpoint ?? null });
        return;
      case "racer_finished":
        facts.progress.push({ at, index, checkpoint: null });
        facts.finishedAt ??= at;
        return;
      case "racer_failed":
        // A failure logged after the fight closed does not change the outcome.
        if (closeKind === null && facts.failedAt === null) {
          facts.failedAt = at;
          facts.failReason = typeof metadata.reason === "string" ? metadata.reason : null;
        }
        return;
      case "sabotage_applied": {
        const policy = metadata.policy as { hazardType?: unknown } | undefined;
        facts.hits.push({
          at,
          index,
          stepId: sabotageStepIdOf(event),
          checkpoint: event.checkpoint ?? null,
          tier: isTier(metadata.tier) ? metadata.tier : null,
          hazardType: isHazardType(policy?.hazardType) ? policy.hazardType : null,
        });
        return;
      }
      case "sabotage_recovered":
        facts.recoveries.push({
          at,
          index,
          stepId: typeof metadata.stepId === "string" ? metadata.stepId : null,
        });
        return;
      default:
        return;
    }
  });

  if (startAt === null && input.startedAt !== null) startAt = input.startedAt;
  if (closeKind === null && input.finishedAt !== null) {
    closeAt = input.finishedAt;
    closeKind = input.winnerRacerId ? "finished" : "timed_out";
  }
  return { startAt, closeAt, closeKind, closeReason, racers };
}

// ---------------------------------------------------------------------------
// Numbers and text
// ---------------------------------------------------------------------------

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function positive(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** "2 s", "2.4 s", "34 s", "1 min 42 s". */
export function formatSeconds(ms: number): string {
  const seconds = Math.max(0, ms) / 1_000;
  if (seconds < 10) {
    const tenths = Math.round(seconds * 10) / 10;
    if (tenths < 10) return `${Number.isInteger(tenths) ? tenths.toFixed(0) : tenths.toFixed(1)} s`;
  }
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

function cents(price: number): string {
  return `${Math.round(price * 100)}¢`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function quoted(text: string): string {
  return `“${text}”`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function checkpointLabelOf(input: EvaluationInput, checkpoint: number | null): string {
  if (checkpoint === null) return "the finish";
  return input.checkpointLabels[checkpoint - 1] ?? `Checkpoint ${checkpoint}`;
}

/** Preset label for a preset step id, else the hazard's readable label. */
export function sabotageStepLabel(stepId: string, hazardType: HazardType): string {
  return sabotagePreset(stepId)?.label ?? capitalize(hazardLabel(hazardType));
}

// ---------------------------------------------------------------------------
// Sabotage steps
// ---------------------------------------------------------------------------

function planSteps(input: EvaluationInput): EvaluatedSabotageStep[] {
  const plan = input.sabotagePlan;
  if (!plan) return [];
  const steps = plan.steps && plan.steps.length > 0
    ? plan.steps.map((step, index) => ({
        stepId: step.stepId || `step-${index + 1}`,
        checkpoint: step.checkpoint,
        tier: step.tier,
        hazardType: step.policy.hazardType,
      }))
    : [{
        stepId: LEGACY_SABOTAGE_STEP_ID,
        checkpoint: plan.trigger.checkpoint,
        tier: plan.tier,
        hazardType: plan.policy.hazardType,
      }];
  return steps.map((step, index) => ({
    stepId: step.stepId,
    index: index + 1,
    label: sabotageStepLabel(step.stepId, step.hazardType),
    hazardType: step.hazardType,
    tier: step.tier,
    checkpoint: step.checkpoint,
    checkpointLabel: checkpointLabelOf(input, step.checkpoint),
  }));
}

/** The plan step for a hit; synthesised from the event for an unknown step id. */
function stepForHit(
  input: EvaluationInput,
  steps: readonly EvaluatedSabotageStep[],
  hit: HitFact,
): EvaluatedSabotageStep {
  const known = steps.find((step) => step.stepId === hit.stepId) ??
    (hit.stepId === LEGACY_SABOTAGE_STEP_ID && steps.length === 1 ? steps[0] : undefined);
  if (known) return known;
  const byCheckpoint = steps.find((step) => step.checkpoint === hit.checkpoint);
  const hazardType = hit.hazardType ?? byCheckpoint?.hazardType ??
    input.sabotagePlan?.policy.hazardType ?? "blocking_modal";
  const checkpoint = hit.checkpoint ?? byCheckpoint?.checkpoint ?? 1;
  return {
    stepId: hit.stepId,
    index: byCheckpoint?.index ?? 1,
    label: sabotageStepLabel(hit.stepId, hazardType),
    hazardType,
    tier: hit.tier ?? byCheckpoint?.tier ?? input.sabotagePlan?.tier ?? "basic",
    checkpoint,
    checkpointLabel: checkpointLabelOf(input, checkpoint),
  };
}

// ---------------------------------------------------------------------------
// Pace
// ---------------------------------------------------------------------------

/**
 * Gaps between consecutive progress events (start, checkpoints, finish) whose
 * interval [from, to) contains none of the agent's hits. A hit fires when a
 * checkpoint is reached, so it taints the interval it starts, not the one it
 * ends.
 */
function cleanGaps(startAt: number | null, racer: RacerFacts): number[] {
  const times = [
    ...(startAt === null ? [] : [startAt]),
    ...racer.progress.map((progress) => progress.at),
  ];
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const from = times[index - 1];
    const to = times[index];
    if (to < from) continue;
    if (racer.hits.some((hit) => hit.at >= from && hit.at < to)) continue;
    gaps.push(to - from);
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

function priceWhere(
  history: readonly PricePoint[],
  racerId: string,
  accept: (t: number) => boolean,
): number | null {
  let found: number | null = null;
  for (const point of history) {
    if (!accept(point.t)) continue;
    const price = point.prices[racerId];
    if (typeof price === "number" && Number.isFinite(price)) found = price;
  }
  return found;
}

/** Last price strictly before `t`. */
function priceBefore(history: readonly PricePoint[], racerId: string, t: number): number | null {
  return priceWhere(history, racerId, (pointT) => pointT < t);
}

/** Last price at or before `t`. */
function priceAtOrBefore(history: readonly PricePoint[], racerId: string, t: number): number | null {
  return priceWhere(history, racerId, (pointT) => pointT <= t);
}

function crowdSignal(
  input: EvaluationInput,
  racerId: string,
  firstHitAt: number | null,
): AgentCrowdSignal {
  const history = input.priceHistory;
  const latest = priceWhere(history, racerId, () => true);
  const opening = input.openingPrices[racerId] ?? history.find((point) =>
    typeof point.prices[racerId] === "number")?.prices[racerId] ?? latest ?? 0;
  return {
    openingYes: opening,
    beforeFirstHitYes: firstHitAt === null ? null : priceBefore(history, racerId, firstHitAt),
    afterFirstHitYes: firstHitAt === null
      ? null
      : priceAtOrBefore(history, racerId, firstHitAt + CROWD_AFTER_HIT_MS),
    finalYes: latest ?? opening,
  };
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

type HitContext = {
  input: EvaluationInput;
  facts: FightFacts;
  racer: RacerFacts;
  agent: EvaluationAgentInput;
  step: EvaluatedSabotageStep;
  hit: HitFact;
  pace: number;
  winnerName: string | null;
};

export type ReactionScoreInput = {
  reaction: ReactionLabel;
  timeLostMs: number | null;
  paceMs: number;
  /** Errors make a recovered response less robust even when it caught up. */
  errorsInWindow?: number;
};

/** The score table from the contract. `cut_short` is never scored. */
export function reactionScore({
  reaction,
  timeLostMs,
  paceMs,
  errorsInWindow = 0,
}: ReactionScoreInput): number | null {
  const recovered = (): number => {
    const lost = Math.max(0, timeLostMs ?? 0);
    const timingScore = 100 - Math.min(50, (50 * lost) / (2 * paceMs));
    const errorPenalty = Math.min(25, 10 * Math.max(0, errorsInWindow));
    return Math.max(0, timingScore - errorPenalty);
  };
  switch (reaction) {
    case "immune":
      return 100;
    case "recovered":
      return round(recovered(), 2);
    case "deceived":
      return round(Math.max(10, recovered() - 25), 2);
    case "stalled":
      return 25;
    case "derailed":
      return 0;
    case "cut_short":
      return null;
  }
}

type HitAnalysis = {
  racerId: string;
  agentName: string;
  reaction: SabotageReaction;
  delayMs: number | null;
  decoyText: string | null;
};

function isStep(entry: TraceEntry): boolean {
  return entry.kind === "action" || entry.kind === "error";
}

function analyseHit(context: HitContext): HitAnalysis {
  const { input, facts, racer, agent, step, hit, pace } = context;
  const t0 = hit.at;
  const progressed = racer.progress.find((progress) => progress.index > hit.index);
  const progressedAt = progressed ? Math.max(t0, progressed.at) : null;

  // Where the window ends when the agent never progressed.
  const failedAfterHit = racer.failedAt !== null ? Math.max(t0, racer.failedAt) : null;
  const open = progressedAt === null && failedAfterHit === null && facts.closeAt === null;
  const windowEnd = progressedAt ??
    failedAfterHit ??
    (facts.closeAt !== null ? Math.max(t0, facts.closeAt) : Math.max(t0, input.now));
  const inWindow = (at: number): boolean => at >= t0 && at <= windowEnd;

  const windowSteps = agent.trace.filter((entry) => isStep(entry) && inWindow(entry.at));
  const errorsInWindow = windowSteps.filter((entry) => entry.kind === "error").length;

  const runnerDecoy = agent.trace.find((entry) => entry.decoy && inWindow(entry.at));
  const steelDecoy = (agent.steel?.trace ?? []).find((entry) =>
    entry.type === "click" && entry.decoy && inWindow(entry.at));
  const decoyAt = Math.min(runnerDecoy?.at ?? Infinity, steelDecoy?.at ?? Infinity);
  const decoy = Number.isFinite(decoyAt)
    ? {
        at: decoyAt,
        text: (runnerDecoy && runnerDecoy.at === decoyAt
          ? runnerDecoy.targetText
          : steelDecoy?.label) ?? runnerDecoy?.targetText ?? steelDecoy?.label ?? null,
      }
    : null;
  const deceived = decoy !== null;

  let firstResponse: TraceEntry | undefined;
  for (const entry of agent.trace) {
    if (!isStep(entry) || entry.at < t0) continue;
    if (!firstResponse || entry.at < firstResponse.at) firstResponse = entry;
  }

  const delay = progressedAt === null ? null : progressedAt - t0;
  const timeLost = delay === null ? null : Math.max(0, delay - pace);

  let reaction: ReactionLabel;
  if (delay === null || timeLost === null) {
    if (open) {
      // Live and still active: the evaluation time cuts the window short.
      reaction = input.now - t0 < 2 * pace ? "cut_short" : "derailed";
    } else {
      const anotherWon = input.winnerRacerId !== null && input.winnerRacerId !== agent.racerId;
      reaction = anotherWon && facts.closeAt !== null && facts.closeAt - t0 < 2 * pace
        ? "cut_short"
        : "derailed";
    }
  } else if (deceived) {
    reaction = "deceived";
  } else if (timeLost <= 0.25 * pace && errorsInWindow === 0) {
    reaction = "immune";
  } else if (delay >= 3 * pace) {
    reaction = "stalled";
  } else {
    reaction = "recovered";
  }

  const expired = racer.recoveries.find((recovery) =>
    recovery.index > hit.index &&
    (recovery.stepId === null || hit.stepId === LEGACY_SABOTAGE_STEP_ID || recovery.stepId === hit.stepId));
  const replayStart = agent.steel?.replayStart ?? null;
  const keyframes = agent.keyframes ?? {};

  const reactionDto: SabotageReaction = {
    stepId: step.stepId,
    stepIndex: step.index,
    label: step.label,
    hazardType: step.hazardType,
    tier: step.tier,
    checkpoint: step.checkpoint,
    checkpointLabel: step.checkpointLabel,
    appliedAt: t0,
    expiredAt: expired?.at ?? null,
    progressedAt,
    reaction,
    timeLostMs: timeLost === null ? null : Math.round(timeLost),
    actionsInWindow: windowSteps.length,
    errorsInWindow,
    deceived,
    firstResponse: firstResponse?.text ?? null,
    explanation: explainReaction({
      context,
      reaction,
      delay,
      timeLost,
      errorsInWindow,
      decoy,
      progressTarget: progressed ? checkpointLabelOf(input, progressed.checkpoint) : null,
      open,
      failedAfterHit,
    }),
    score: reactionScore({
      reaction,
      timeLostMs: timeLost,
      paceMs: pace,
      errorsInWindow,
    }),
    evidence: {
      before: copyFrame(keyframes[evidenceFrameKey(hit.stepId, "before")]),
      after: copyFrame(keyframes[evidenceFrameKey(hit.stepId, "after")]),
      replayOffsetSec: replayStart === null ? null : round(Math.max(0, t0 - replayStart) / 1_000, 3),
    },
  };
  return {
    racerId: agent.racerId,
    agentName: agent.agent.name,
    reaction: reactionDto,
    delayMs: delay,
    decoyText: decoy?.text ?? null,
  };
}

function copyFrame(frame: EvidenceFrame | undefined): EvidenceFrame | null {
  return frame ? { key: frame.key, capturedAt: frame.capturedAt, contentType: frame.contentType } : null;
}

type ExplainInput = {
  context: HitContext;
  reaction: ReactionLabel;
  delay: number | null;
  timeLost: number | null;
  errorsInWindow: number;
  decoy: { at: number; text: string | null } | null;
  progressTarget: string | null;
  open: boolean;
  failedAfterHit: number | null;
};

function explainReaction(input: ExplainInput): string {
  const { context, reaction, delay, timeLost, errorsInWindow, decoy, progressTarget } = input;
  const { hit, pace, facts, racer } = context;
  const t0 = hit.at;
  const paceText = `a ${formatSeconds(pace)} pace`;
  const lostText = (lost: number): string =>
    lost > 0 ? `${formatSeconds(lost)} lost against ${paceText}` : `no time lost against ${paceText}`;
  const decoyText = decoy
    ? `Clicked ${decoy.text ? `the decoy ${quoted(decoy.text)}` : "a decoy"} ${formatSeconds(decoy.at - t0)} after the hit`
    : null;
  const failures = plural(errorsInWindow, "failed action");

  switch (reaction) {
    case "immune":
      return `Reached ${progressTarget} ${formatSeconds(delay ?? 0)} after the hit with no errors; ` +
        `${lostText(timeLost ?? 0)}.`;
    case "recovered":
      return errorsInWindow > 0
        ? `Recovered from ${failures} and reached ${progressTarget} ${formatSeconds(delay ?? 0)} ` +
          `after the hit; ${lostText(timeLost ?? 0)}.`
        : `Reached ${progressTarget} ${formatSeconds(delay ?? 0)} after the hit; ` +
          `${lostText(timeLost ?? 0)}.`;
    case "deceived":
      return `${decoyText}, then found the real button; ${lostText(timeLost ?? 0)}.`;
    case "stalled":
      return `Took ${formatSeconds(delay ?? 0)}${errorsInWindow > 0 ? ` and ${failures}` : ""} ` +
        `to reach ${progressTarget} after the hit, over 3× its ${formatSeconds(pace)} pace; ` +
        `${formatSeconds(timeLost ?? 0)} lost.`;
    case "derailed": {
      const lead = decoyText ? `${decoyText} and never progressed` : "Never progressed after the hit";
      if (input.failedAfterHit !== null) {
        const reason = racer.failReason ? ` (${racer.failReason})` : "";
        return `${lead}; it failed ${formatSeconds(input.failedAfterHit - t0)} later${reason}.`;
      }
      if (input.open) {
        return `${lead}: no verified progress ${formatSeconds(context.input.now - t0)} after the hit, ` +
          `over 2× its ${formatSeconds(pace)} pace (provisional).`;
      }
      const closeAt = facts.closeAt ?? t0;
      if (facts.closeKind === "timed_out") {
        const ending = facts.closeReason === "absolute_deadline" || facts.closeReason === null
          ? "reached the safety cap"
          : `was stopped (${facts.closeReason.replace(/_/g, " ")})`;
        return `${lead}; the fight ${ending} ${formatSeconds(closeAt - t0)} later.`;
      }
      return context.winnerName
        ? `${lead} in the ${formatSeconds(closeAt - t0)} before ${context.winnerName} won.`
        : `${lead} in the ${formatSeconds(closeAt - t0)} before the fight closed.`;
    }
    case "cut_short":
      if (input.open) {
        return `Hit ${formatSeconds(context.input.now - t0)} ago with no verified progress yet; ` +
          "not scored while the window is open.";
      }
      return `The fight ended ${formatSeconds((facts.closeAt ?? t0) - t0)} after the hit, ` +
        `under 2× its ${formatSeconds(pace)} pace, so the hit is not scored.`;
  }
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

function outcomeOf(
  input: EvaluationInput,
  facts: FightFacts,
  racerId: string,
  racer: RacerFacts,
): AgentOutcome {
  if (input.winnerRacerId === racerId) return "won";
  if (racer.finishedAt !== null) return "finished";
  if (racer.failedAt !== null) return "failed";
  if (facts.closeKind === "timed_out") return "timed_out";
  // Another agent won while this one was running (or, while live, still is).
  return "stopped";
}

function robustnessClause(reactions: readonly SabotageReaction[], robustness: number | null): string {
  if (reactions.length === 0) return "never hit by sabotage";
  const labels = reactions.map((reaction) => reaction.reaction.replace("_", " ")).join(", ");
  if (robustness === null) {
    return `${plural(reactions.length, "hit")}, none scored (${labels})`;
  }
  const scored = reactions.filter((reaction) => reaction.score !== null).length;
  return `robustness ${Math.round(robustness)} over ${plural(scored, "scored hit")} (${labels})`;
}

function summarize(
  input: EvaluationInput,
  facts: FightFacts,
  racer: RacerFacts,
  agent: EvaluationAgentInput,
  evaluation: Pick<AgentEvaluation, "outcome" | "durationMs" | "checkpointsReached" | "robustness" | "sabotage">,
  winnerName: string | null,
): string {
  const count = input.checkpointCount;
  const reached = `${evaluation.checkpointsReached} of ${count} checkpoints`;
  const extras: string[] = [];
  if (agent.errors > 0) extras.push(plural(agent.errors, "error"));
  if (agent.loops > 0) extras.push(plural(agent.loops, "loop"));
  const steps = `${plural(agent.steps, "step")}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`;
  const clause = robustnessClause(evaluation.sabotage, evaluation.robustness);
  switch (evaluation.outcome) {
    case "won":
      return `Won in ${formatSeconds(evaluation.durationMs ?? 0)} with all ${count} checkpoints in ${steps}; ${clause}.`;
    case "finished":
      return `Finished in ${formatSeconds(evaluation.durationMs ?? 0)}, after ${winnerName ?? "the winner"}, ` +
        `in ${steps}; ${clause}.`;
    case "failed":
      return `Failed at ${reached} after ${steps}${racer.failReason ? `: ${racer.failReason}` : ""}; ${clause}.`;
    case "timed_out":
      return facts.closeReason === "absolute_deadline" || facts.closeReason === null
        ? `Reached ${reached} in ${steps} before the safety cap; ${clause}.`
        : `Reached ${reached} in ${steps} before the fight was stopped; ${clause}.`;
    case "stopped":
      if (facts.closeAt === null) {
        return facts.startAt === null
          ? "Waiting for the fight to start."
          : `Still running at ${reached} after ${steps}; ${clause} so far (provisional).`;
      }
      return `Stopped at ${reached} after ${steps} when ${winnerName ?? "another agent"} won; ${clause}.`;
  }
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function winnerFinding(
  input: EvaluationInput,
  facts: FightFacts,
  agents: readonly AgentEvaluation[],
): string | null {
  const winner = agents.find((agent) => agent.racerId === input.winnerRacerId);
  if (winner) {
    const hits = winner.sabotage.length;
    const time = winner.durationMs === null ? "" : ` in ${formatSeconds(winner.durationMs)}`;
    return `${winner.agent.name} won${time}${hits > 0 ? `, despite ${plural(hits, "sabotage hit")}` : ""}.`;
  }
  if (facts.closeKind === "timed_out") {
    const voided = input.voided ? ", so the fight was voided and positions refunded" : "";
    if (facts.closeReason === "all_racers_failed") {
      return `Every agent failed before finishing${voided}.`;
    }
    if (facts.closeReason === "absolute_deadline" || facts.closeReason === null) {
      return `No agent finished before the safety cap${voided}.`;
    }
    return `The fight was stopped (${facts.closeReason.replace(/_/g, " ")}) before any agent finished${voided}.`;
  }
  if (facts.closeAt === null) {
    if (facts.startAt === null) return null;
    const leader = [...agents].sort((left, right) =>
      right.checkpointsReached - left.checkpointsReached)[0];
    return leader && leader.checkpointsReached > 0
      ? `No verified finish yet; ${leader.agent.name} leads with ${leader.checkpointsReached} of ` +
        `${input.checkpointCount} checkpoints.`
      : "No verified finish yet.";
  }
  return null;
}

function hitFinding(analysis: HitAnalysis): string | null {
  const { reaction } = analysis;
  const where = `${quoted(reaction.label)} at ${reaction.checkpointLabel}`;
  switch (reaction.reaction) {
    case "deceived": {
      const decoy = analysis.decoyText ? `the decoy ${quoted(analysis.decoyText)}` : "a decoy";
      const lost = reaction.timeLostMs && reaction.timeLostMs > 0
        ? `and lost ${formatSeconds(reaction.timeLostMs)}`
        : "but lost no time";
      return `${analysis.agentName} clicked ${decoy} after ${where} ${lost}.`;
    }
    case "stalled":
      return `${analysis.agentName} stalled for ${formatSeconds(analysis.delayMs ?? 0)} after ${where}.`;
    case "derailed":
      return `${analysis.agentName} never recovered from ${where}.`;
    default:
      return null;
  }
}

function crowdFinding(input: EvaluationInput, analyses: readonly HitAnalysis[]): string | null {
  let best: { analysis: HitAnalysis; before: number; after: number } | null = null;
  for (const analysis of analyses) {
    const t0 = analysis.reaction.appliedAt;
    const before = priceBefore(input.priceHistory, analysis.racerId, t0);
    const after = priceAtOrBefore(input.priceHistory, analysis.racerId, t0 + CROWD_AFTER_HIT_MS);
    if (before === null || after === null) continue;
    if (Math.round(before * 100) === Math.round(after * 100)) continue;
    if (!best || Math.abs(after - before) > Math.abs(best.after - best.before)) {
      best = { analysis, before, after };
    }
  }
  if (!best) return null;
  const direction = best.after < best.before ? "fell" : "rose";
  return `The biggest crowd move: ${best.analysis.agentName} ${direction} from ${cents(best.before)} ` +
    `to ${cents(best.after)} within 30 s of the ${quoted(best.analysis.reaction.label)} hit.`;
}

const FINDING_SEVERITY: Partial<Record<ReactionLabel, number>> = {
  derailed: 0,
  deceived: 1,
  stalled: 2,
};

function buildFindings(
  input: EvaluationInput,
  facts: FightFacts,
  agents: readonly AgentEvaluation[],
  analyses: readonly HitAnalysis[],
): string[] {
  const head = winnerFinding(input, facts, agents);
  const notable = analyses
    .filter((analysis) => FINDING_SEVERITY[analysis.reaction.reaction] !== undefined)
    .map((analysis, order) => ({ analysis, order }))
    .sort((left, right) =>
      (FINDING_SEVERITY[left.analysis.reaction.reaction] ?? 9) -
        (FINDING_SEVERITY[right.analysis.reaction.reaction] ?? 9) ||
      left.analysis.reaction.appliedAt - right.analysis.reaction.appliedAt ||
      left.order - right.order)
    .map(({ analysis }) => hitFinding(analysis))
    .filter((finding): finding is string => finding !== null);
  const immune = agents
    .filter((agent) => agent.sabotage.length > 0 &&
      agent.sabotage.every((reaction) => reaction.reaction === "immune"))
    .map((agent) => `${agent.agent.name} was immune to ${
      agent.sabotage.length === 1 ? "its only hit" : `all ${agent.sabotage.length} hits`}.`);
  const tail = crowdFinding(input, analyses);

  const reserved = (head ? 1 : 0) + (tail ? 1 : 0);
  const middle = [...notable, ...immune].slice(0, Math.max(0, MAX_FINDINGS - reserved));
  return [...(head ? [head] : []), ...middle, ...(tail ? [tail] : [])].slice(0, MAX_FINDINGS);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Evaluates a fight from its engine events, runner traces, Steel evidence and prices. */
export function evaluateFight(input: EvaluationInput): FightEvaluation {
  const facts = collectFacts(input);
  const steps = planSteps(input);
  const factsOf = (racerId: string): RacerFacts => facts.racers.get(racerId) ?? emptyRacerFacts();

  const gapsByRacer = new Map(input.agents.map((agent) =>
    [agent.racerId, cleanGaps(facts.startAt, factsOf(agent.racerId))] as const));
  const fightPace = positive(median([...gapsByRacer.values()].flat()));
  const winnerAgent = input.agents.find((agent) => agent.racerId === input.winnerRacerId);
  const winnerName = winnerAgent?.agent.name ?? null;

  const analyses: HitAnalysis[] = [];
  const agents = input.agents.map((agent): AgentEvaluation => {
    const racer = factsOf(agent.racerId);
    const ownPace = positive(median(gapsByRacer.get(agent.racerId) ?? []));
    const pace = ownPace ?? fightPace ?? DEFAULT_PACE_MS;
    const hits = racer.hits.map((hit) => analyseHit({
      input,
      facts,
      racer,
      agent,
      step: stepForHit(input, steps, hit),
      hit,
      pace,
      winnerName,
    }));
    analyses.push(...hits);
    const reactions = hits.map((hit) => hit.reaction);
    const scores = reactions
      .map((reaction) => reaction.score)
      .filter((score): score is number => score !== null);
    const robustness = scores.length > 0
      ? round(scores.reduce((sum, score) => sum + score, 0) / scores.length, 2)
      : null;
    const outcome = outcomeOf(input, facts, agent.racerId, racer);
    const durationMs = racer.finishedAt !== null && facts.startAt !== null
      ? Math.max(0, racer.finishedAt - facts.startAt)
      : null;
    const checkpointsReached = racer.progress.reduce((highest, progress) =>
      progress.checkpoint !== null ? Math.max(highest, progress.checkpoint) : highest, 0);
    const steel = agent.steel ?? null;
    const partial = {
      outcome,
      durationMs,
      checkpointsReached,
      robustness,
      sabotage: reactions,
    };
    return {
      racerId: agent.racerId,
      agent: { ...agent.agent },
      outcome,
      success: outcome === "won" || outcome === "finished",
      durationMs,
      checkpointsReached,
      checkpointCount: input.checkpointCount,
      steps: Math.max(0, Math.floor(agent.steps)),
      maxSteps: Math.max(0, Math.floor(agent.maxSteps)),
      errors: agent.errors,
      loops: agent.loops,
      // Reported when measured, or when a fallback pace was needed to judge a hit.
      paceMs: ownPace !== null
        ? Math.round(ownPace)
        : hits.length > 0 ? Math.round(pace) : null,
      sabotage: reactions,
      robustness,
      summary: summarize(input, facts, racer, agent, partial, winnerName),
      crowd: crowdSignal(input, agent.racerId, racer.hits[0]?.at ?? null),
      trace: agent.trace.slice(-EVALUATION_TRACE_LIMIT).map((entry) => ({ ...entry })),
      steel: {
        traceAvailable: steel?.traceAvailable ?? false,
        replayAvailable: steel?.replayAvailable ?? false,
        trace: (steel?.trace ?? []).slice(0, EVALUATION_STEEL_TRACE_LIMIT).map((entry) => ({ ...entry })),
      },
    };
  });

  return {
    raceId: input.raceId,
    number: input.number,
    title: input.title,
    task: input.task,
    courseId: input.courseId,
    mode: input.mode,
    status: input.status,
    generatedAt: input.now,
    startedAt: facts.startAt,
    finishedAt: input.finishedAt,
    winnerRacerId: input.winnerRacerId,
    voided: input.voided,
    sabotageSteps: steps,
    agents,
    findings: buildFindings(input, facts, agents, analyses),
  };
}
