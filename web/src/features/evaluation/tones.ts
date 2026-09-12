/**
 * Colour treatment for evaluation labels, mapped onto the rationed semantic
 * tokens (docs/sabotage-markets-handoff.md, section 3):
 *
 * - positive  green: immune, won
 * - edge      blue accent: recovered, finished, provisional
 * - negative  terracotta: deceived, derailed, failed
 * - warn      the palette has no warning hue, so this reuses the fight
 *             screen's LOOPING treatment: secondary text, dashed divider
 *             border and an alert glyph on inset (stalled, timed out)
 * - neutral   slate: stopped, final
 * - muted     unscored or inconclusive: cut short
 */
import type { AgentOutcome, EvaluationStatus, ReactionLabel } from "@contract";

export type EvaluationTone = "positive" | "edge" | "negative" | "warn" | "neutral" | "muted";

export const REACTION_TONE: Readonly<Record<ReactionLabel, EvaluationTone>> = {
  immune: "positive",
  recovered: "edge",
  deceived: "negative",
  stalled: "warn",
  derailed: "negative",
  cut_short: "muted",
};

export const OUTCOME_TONE: Readonly<Record<AgentOutcome, EvaluationTone>> = {
  won: "positive",
  finished: "edge",
  failed: "negative",
  timed_out: "warn",
  stopped: "neutral",
};

export const EVALUATION_STATUS_TONE: Readonly<Record<EvaluationStatus, EvaluationTone>> = {
  provisional: "edge",
  final: "neutral",
};

/** The CSS colour token behind each tone (for marks that are not chips). */
export const TONE_COLOR_VAR: Readonly<Record<EvaluationTone, string>> = {
  positive: "var(--color-positive)",
  edge: "var(--color-edge)",
  negative: "var(--color-negative)",
  warn: "var(--color-text-secondary)",
  neutral: "var(--color-text-secondary)",
  muted: "var(--color-text-muted)",
};
