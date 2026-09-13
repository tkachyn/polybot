/**
 * Pure formatters for the evaluation report and the robustness matrix. Like
 * lib/format, every function accepts null/undefined/NaN and returns "—".
 */
import type { AgentEvaluation, EvaluatedSabotageStep, EvaluationStatus, RobustnessCell, ServerMode } from "@contract";
import { EMPTY, MINUS, formatClock, formatDuration, formatLogTime, formatNumber, formatPercent, isFiniteNumber, roundTo, type Numeric } from "../../lib/format";
import { HAZARD_LABEL, REACTION_LABEL, ROBUSTNESS_NOT_SCORED, ROBUSTNESS_NOT_TESTED, SABOTAGE_TIER_LABEL } from "../../lib/labels";

/** Reaction or robustness score (0–100), rounded to a whole number: 74.6 → "75". */
export function formatScore(score: Numeric): string {
  if (!isFiniteNumber(score)) return EMPTY;
  return String(Math.round(Math.min(100, Math.max(0, score))));
}

/**
 * Robustness figure. Without a score (null): "Not scored" when the agent was
 * hit (`hits` > 0) but every hit was cut short, "Not tested" when it was
 * never hit.
 */
export function formatRobustness(robustness: Numeric, hits = 0): string {
  if (isFiniteNumber(robustness)) return formatScore(robustness);
  return hits > 0 ? ROBUSTNESS_NOT_SCORED : ROBUSTNESS_NOT_TESTED;
}

export type RobustnessView = {
  /** "74", "Not scored" or "Not tested". */
  text: string;
  /** A score exists. */
  scored: boolean;
  /** Hits that carry a score (cut-short hits don't). */
  scoredHits: number;
  /** Tooltip: what the figure rests on, or why there is none. */
  title: string;
};

/** An agent's robustness: its score over scored hits, or why it has none. */
export function robustnessView(agent: Pick<AgentEvaluation, "robustness" | "sabotage">): RobustnessView {
  const hits = agent.sabotage.length;
  const scoredHits = agent.sabotage.filter((reaction) => reaction.score !== null).length;
  const text = formatRobustness(agent.robustness, hits);
  if (isFiniteNumber(agent.robustness)) {
    return { text, scored: true, scoredHits, title: `Mean reaction score over ${plural(scoredHits, "scored hit", "scored hits")}, 0 to 100.` };
  }
  if (hits > 0) {
    const title =
      hits === 1
        ? "Hit, but cut short: the fight ended too soon after the hit to judge it, so it wasn’t scored."
        : `Hit ${formatNumber(hits)} times, all cut short: the fight ended too soon after each hit to judge it, so none was scored.`;
    return { text, scored: false, scoredHits: 0, title };
  }
  return { text, scored: false, scoredHits: 0, title: "Never hit by sabotage, so robustness was not tested." };
}

export type EvidenceAvailability = {
  mode: ServerMode;
  /** `AgentEvaluation.steel.replayAvailable`. */
  replayAvailable: boolean;
  /** `AgentEvaluation.steel.traceAvailable`. */
  traceAvailable: boolean;
  /** The fight has left the lobby: its keyframes and replay are no longer served (the trace is in the report). */
  archived?: boolean;
};

/**
 * Short, calm notes for what a hit's evidence lacks, shown where the replay
 * and the Steel trace would be. Simulated fights never have either; a live
 * session can lack its recording or its trace; a fight that has left the
 * lobby no longer serves its keyframes or replay.
 */
export function evidenceNotes({ mode, replayAvailable, traceAvailable, archived = false }: EvidenceAvailability): string[] {
  const notes: string[] = [];
  if (archived) {
    notes.push(
      mode === "live" && replayAvailable
        ? "Keyframes and the replay aren’t kept once a fight leaves the lobby."
        : "Keyframes aren’t kept once a fight leaves the lobby.",
    );
  }
  if (mode === "simulated") {
    notes.push("Replays and Steel traces exist for live fights only.");
  } else if (!replayAvailable && !traceAvailable) {
    notes.push("No Steel recording or trace was saved for this session.");
  } else if (!replayAvailable) {
    notes.push("No Steel recording was saved for this session.");
  } else if (!traceAvailable) {
    notes.push("No Steel trace was saved for this session.");
  }
  return notes;
}

/** The report's status as shown. "finalizing": the fight has resolved, its final evaluation isn't in yet. */
export type EvaluationDisplayStatus = EvaluationStatus | "finalizing";

/**
 * A resolved fight's evaluation stays provisional for about a second, until
 * the final one is written. "Provisional" says the fight is still running,
 * so a resolved fight reads "finalizing" instead.
 */
export function evaluationDisplayStatus(status: EvaluationStatus, fightResolved: boolean): EvaluationDisplayStatus {
  return status === "provisional" && fightResolved ? "finalizing" : status;
}

/** Survival rate as a whole percent: 0.8333 → "83%". */
export function formatSurvival(rate: Numeric): string {
  return formatPercent(rate, { decimals: 0 });
}

/**
 * A short span of time. Under 10 s: one decimal ("3.4s", "3s" for a whole
 * second). Under a minute: whole seconds, floored ("42s"). Then "2m 14s".
 * Negative input reads "0s".
 */
export function formatSeconds(ms: Numeric): string {
  if (!isFiniteNumber(ms)) return EMPTY;
  const abs = Math.max(0, ms);
  const seconds = abs / 1000;
  if (seconds < 10) {
    const r = roundTo(seconds, 1);
    return `${Number.isInteger(r) ? String(r) : r.toFixed(1)}s`;
  }
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return formatDuration(abs);
}

/** Signed offset from a reference moment (e.g. the hit): "−3.2s", "+1.5s", "0s". */
export function formatOffset(ms: Numeric): string {
  if (!isFiniteNumber(ms)) return EMPTY;
  const text = formatSeconds(Math.abs(ms));
  if (text === "0s") return text;
  return `${ms < 0 ? MINUS : "+"}${text}`;
}

/** A keyframe's distance from the hit: "0.8s before the hit", "1.6s after the hit", "at the hit". */
export function describeHitOffset(ms: Numeric): string {
  if (!isFiniteNumber(ms)) return EMPTY;
  const text = formatSeconds(Math.abs(ms));
  if (text === "0s") return "at the hit";
  return `${text} ${ms < 0 ? "before" : "after"} the hit`;
}

/** Position in a replay from seconds, floored: 75 → "1:15", 3725 → "1:02:05". */
export function formatReplayOffset(seconds: Numeric): string {
  if (!isFiniteNumber(seconds)) return EMPTY;
  const total = Math.floor(Math.max(0, seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * ["Checkpoint 3", "Search results"]. A default label ("Checkpoint 3", the
 * backend's fallback) is not repeated: ["Checkpoint 3"].
 */
export function checkpointParts(index: number, label: string | null | undefined): [string] | [string, string] {
  const base = `Checkpoint ${index}`;
  const text = label?.trim() ?? "";
  return !text || text.toLowerCase() === base.toLowerCase() ? [base] : [base, text];
}

/** "Checkpoint 3 · Search results", or "Checkpoint 3" for a default label. */
export function formatCheckpoint(index: number, label: string | null | undefined): string {
  return checkpointParts(index, label).join(" · ");
}

/** Lowercase words only, so "Insert decoy" and "insert_decoy" compare equal. */
function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * A sabotage step's title, and its hazard when that adds something. A step
 * without a named preset is labelled after its hazard type ("Insert decoy"
 * for insert_decoy), which names the same thing as the hazard's display
 * label ("Decoy control"), so the hazard is not repeated beside it. A named
 * preset ("Plant a decoy control") keeps its hazard.
 */
export function sabotageStepTitle(step: Pick<EvaluatedSabotageStep, "label" | "hazardType">): { title: string; hazard: string | null } {
  const hazard = HAZARD_LABEL[step.hazardType];
  const title = step.label.trim();
  if (!title) return { title: hazard, hazard: null };
  const own = words(title);
  return own === words(step.hazardType) || own === words(hazard) ? { title, hazard: null } : { title, hazard };
}

export type StepMetaItem = {
  text: string;
  /** Free text (a checkpoint's own label) may wrap inside itself; the short items never break. */
  wrap: boolean;
};

/**
 * The facts under a sabotage step's title, one item each so a line breaks
 * between items, never inside one ("Checkpoint / 3"): the hazard (unless the
 * title already names it), the tier, the checkpoint and its label.
 */
export function sabotageStepMeta(step: Pick<EvaluatedSabotageStep, "label" | "hazardType" | "tier" | "checkpoint" | "checkpointLabel">): StepMetaItem[] {
  const { hazard } = sabotageStepTitle(step);
  const [checkpoint, checkpointLabel] = checkpointParts(step.checkpoint, step.checkpointLabel);
  const items: StepMetaItem[] = [];
  if (hazard) items.push({ text: hazard, wrap: false });
  items.push({ text: SABOTAGE_TIER_LABEL[step.tier], wrap: false });
  items.push({ text: checkpoint, wrap: false });
  if (checkpointLabel) items.push({ text: checkpointLabel, wrap: true });
  return items;
}

/** Time into the fight ("01:23"), or the local time of day when the start is unknown. */
export function formatFightTime(at: Numeric, startedAt: Numeric): string {
  if (!isFiniteNumber(at)) return EMPTY;
  return isFiniteNumber(startedAt) ? formatClock(at - startedAt) : formatLogTime(at);
}

// ---------------------------------------------------------------------------
// Robustness matrix cells
// ---------------------------------------------------------------------------

/** Reaction counts in a cell, in the order the contract defines them. */
export const CELL_REACTIONS = ["immune", "recovered", "deceived", "stalled", "derailed"] as const;

function plural(n: number, one: string, many: string): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

/**
 * Tooltip text for a matrix cell:
 * "12 scored hits: 4 immune, 5 recovered, 1 deceived, 1 stalled, 1 derailed. Mean time lost 8.2s."
 */
export function cellCountsText(cell: RobustnessCell | null | undefined): string {
  if (!cell || !(cell.hits > 0)) return "No scored hits";
  const counts = CELL_REACTIONS.map((label) => `${formatNumber(cell[label])} ${REACTION_LABEL[label].toLowerCase()}`).join(", ");
  const lost = isFiniteNumber(cell.meanTimeLostMs) ? ` Mean time lost ${formatSeconds(cell.meanTimeLostMs)}.` : "";
  return `${plural(cell.hits, "scored hit", "scored hits")}: ${counts}.${lost}`;
}

export type MatrixCellView = {
  /** Mean reaction score, shown prominently: "74". Survival saturates fast, the score separates agents. */
  headline: string;
  /** The small line: "83% survival · 12 hits". */
  detail: string;
  /** Counts, for the tooltip and screen readers. */
  tooltip: string;
  /** No scored hits in this cell. */
  empty: boolean;
};

export function matrixCellView(cell: RobustnessCell | null | undefined): MatrixCellView {
  if (!cell || !(cell.hits > 0)) return { headline: EMPTY, detail: "No hits", tooltip: cellCountsText(cell), empty: true };
  return {
    headline: formatScore(cell.meanScore),
    detail: `${formatSurvival(cell.survivalRate)} survival · ${plural(cell.hits, "hit", "hits")}`,
    tooltip: cellCountsText(cell),
    empty: false,
  };
}
