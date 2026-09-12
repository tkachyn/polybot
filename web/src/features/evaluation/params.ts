/**
 * URL state for "/evaluations": `?mode=live|simulated|all&days=7|30|90`.
 * A missing mode means "the server's mode" (useSession().meta.mode).
 */
import type { EvaluationMode } from "../../api/client";

export const MODE_PARAM = "mode";
export const DAYS_PARAM = "days";

export const EVALUATION_MODES: readonly EvaluationMode[] = ["live", "simulated", "all"];

export const EVALUATION_WINDOWS = [7, 30, 90] as const;
export type EvaluationWindow = (typeof EVALUATION_WINDOWS)[number];
export const DEFAULT_WINDOW: EvaluationWindow = 30;

/** A valid mode, or null when absent or unknown. */
export function parseEvaluationMode(value: string | null | undefined): EvaluationMode | null {
  const v = value?.trim().toLowerCase() ?? "";
  return (EVALUATION_MODES as readonly string[]).includes(v) ? (v as EvaluationMode) : null;
}

/** 7, 30 or 90; anything else reads as the 30-day default. */
export function parseEvaluationWindow(value: string | null | undefined): EvaluationWindow {
  const n = Number(value);
  return (EVALUATION_WINDOWS as readonly number[]).includes(n) ? (n as EvaluationWindow) : DEFAULT_WINDOW;
}
