/**
 * Readable causes for a racer's failure. The engine keeps the raw reason (an
 * error message) on its `racer_failed` event for diagnostics. Anything a
 * spectator reads (evaluation summaries, reaction explanations, the agent's
 * live log) uses one of these short phrases instead, so raw error strings and
 * internal racer ids never reach the page.
 */

/** `cause` follows the agent ("… it stopped after …"); `problem` completes "retrying after …". */
type FailureRule = { pattern: RegExp; cause: string; problem: string };

/** First match wins: specific causes before the broad browser catch-all. */
const FAILURE_RULES: readonly FailureRule[] = [
  // The engine's recovery gate: progress was claimed while a sabotage was still up.
  {
    pattern: /while recovering/i,
    cause: "stopped while a sabotage still blocked it",
    problem: "a sabotage still blocked it",
  },
  {
    pattern: /\b429\b|rate[ -]?limit|too many requests/i,
    cause: "stopped after its model provider rate-limited it",
    problem: "the model provider rate-limited it",
  },
  // One spender's slice of the fight's budget: the others race on.
  {
    pattern: /share of the .*budget\b.*\b(?:exhausted|exceeded|spent)\b/i,
    cause: "stopped when its share of the model budget ran out",
    problem: "its share of the model budget ran out",
  },
  {
    pattern: /budget\b.*\b(?:exhausted|exceeded|spent)\b/i,
    cause: "stopped when the fight's model budget ran out",
    problem: "the fight's model budget ran out",
  },
  {
    pattern: /did not call|no tool call|invalid tool arguments|(?:invalid|unsupported) competitor decision|requires (?:targetRole|text|script|url|durationMs|a number)/i,
    cause: "stopped when its model returned no usable action",
    problem: "the model returned no usable action",
  },
  // Any other model or provider trouble, including the runner's "model decision failed" wrapper.
  {
    pattern: /\bmodel\b|openrouter|anthropic|api key/i,
    cause: "stopped after its model provider failed",
    problem: "the model provider failed",
  },
  {
    pattern: /exceeded \d+ actions|step budget/i,
    cause: "stopped after using its whole step budget",
    problem: "the step budget ran out",
  },
  {
    pattern: /browser context lost|context or browser has been closed|browser has (?:been )?(?:closed|disconnected)|(?:target|page|browser) (?:closed|crashed)/i,
    cause: "stopped when its browser crashed",
    problem: "the browser crashed",
  },
  {
    pattern: /steel|browser session|no (?:active|prepared) session/i,
    cause: "stopped when its browser session was lost",
    problem: "the browser session was lost",
  },
  {
    pattern: /verif|course state|run proof|must reach checkpoint|final checkpoint|checkpoint exceeds/i,
    cause: "stopped when its progress could not be verified",
    problem: "its progress could not be verified",
  },
  {
    pattern: /runner exited/i,
    cause: "stopped when its agent quit early",
    problem: "the agent quit early",
  },
  {
    pattern: /time(?:d)? ?out|net::|navigat|locator|selector|element|protocol error|playwright|\bpage\b|browser/i,
    cause: "stopped after a browser error",
    problem: "a browser error",
  },
];

const UNKNOWN_CAUSE = "stopped after an unexpected error";
const UNKNOWN_PROBLEM = "an unexpected error";

/**
 * A short, readable cause for a raw failure reason, phrased to follow the
 * agent ("… it stopped after a browser error"). Null when there is no reason.
 */
export function failureCause(reason: string | null | undefined): string | null {
  if (typeof reason !== "string" || reason.trim().length === 0) return null;
  return FAILURE_RULES.find((rule) => rule.pattern.test(reason))?.cause ?? UNKNOWN_CAUSE;
}

/**
 * The same cause as a short phrase for a note about a retry ("retrying after
 * the model provider rate-limited it"). Null when there is no reason.
 */
export function failureProblem(reason: string | null | undefined): string | null {
  if (typeof reason !== "string" || reason.trim().length === 0) return null;
  return FAILURE_RULES.find((rule) => rule.pattern.test(reason))?.problem ?? UNKNOWN_PROBLEM;
}

const CLOSE_REASONS: Readonly<Record<string, string>> = {
  absolute_deadline: "Timed out at the safety cap",
  all_racers_failed: "Stopped: every agent failed",
  start_failed: "Stopped: the fight could not start",
};

/** The agent log line for a fight that closed without a winner, from its close reason. */
export function closeReasonText(reason: string | null | undefined): string {
  return (typeof reason === "string" ? CLOSE_REASONS[reason] : undefined) ?? "Stopped early";
}
