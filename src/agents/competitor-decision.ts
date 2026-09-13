import type { DatasetAction } from "../api/dto.js";
import type {
  AgentDecision,
  CompetitorDecisionModel,
} from "./playwright-competitor-runner.js";

/** The input every competitor decision model receives. */
export type CompetitorDecisionInput = Parameters<CompetitorDecisionModel["decide"]>[0];

export const COMPETITOR_TOOL_NAME = "take_browser_action";
export const COMPETITOR_TOOL_DESCRIPTION =
  "Take one browser action or report verified progress. Persistent challenges must be actively cleared with bounded DOM recovery, never waited out.";
export const COMPETITOR_SYSTEM_PROMPT =
  "You control one browser racer. Choose exactly one bounded action and give a one-sentence reasoning. Use data-arena-role values when clicking or typing, plus the visible label when several controls share a role. Sabotage, challenges, and blocking overlays persist until you actively clear them; waiting never clears them and is rejected while one is active. First inspect the blocker, then use a visible recovery control when one exists. For an arena blocker with no recovery control, use the bounded same-page evaluate action to inspect or repair the DOM; window.__arenaRecoverDisruptions?.() is an allowed recovery helper. Keep recovery scripts DOM-only and bounded. Do not use evaluate for network access, navigation, storage, secrets, or task completion shortcuts. Report recovery only after the blocker is gone, and report checkpoints and completion only when the visible task state supports the claim.";

/** Longest accepted `label`; longer labels are truncated, which still matches by substring. */
export const LABEL_MAX_LENGTH = 120;
export const EVALUATE_SCRIPT_MAX_LENGTH = 2_000;
/** Longest kept `reasoning`; longer reasons are clipped. */
export const REASONING_MAX_LENGTH = 400;
/** Stands in for text typed into a password field wherever a step is recorded. */
export const REDACTED_TEXT = "[redacted]";

export const DECISION_TYPES = [
  "inspect",
  "click",
  "type",
  "evaluate",
  "navigate",
  "wait",
  "checkpoint",
  "finish",
] as const;

export type ToolJsonSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties?: boolean;
};

/**
 * JSON schema for the take_browser_action tool, shared by every provider.
 * Treat as read-only; clone before handing it to an SDK.
 */
export const COMPETITOR_TOOL_SCHEMA: ToolJsonSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: [...DECISION_TYPES] },
    targetRole: { type: "string", maxLength: 100 },
    label: {
      type: "string",
      maxLength: LABEL_MAX_LENGTH,
      description:
        "Optional, for click and type: the visible label of the control to act on, as shown in the observation's controls. Matched case-insensitively as a substring. Use it when several controls share the same targetRole; without it the first control with that role is used.",
    },
    text: { type: "string", maxLength: 2_000 },
    script: {
      type: "string",
      maxLength: EVALUATE_SCRIPT_MAX_LENGTH,
      description:
        "A bounded same-page DOM-only JavaScript expression or IIFE for active recovery. When a blocking arena disruption is present, inspect it and call window.__arenaRecoverDisruptions?.(); waiting cannot clear it. Network, navigation, storage, secrets, and arbitrary task shortcuts are forbidden.",
    },
    url: { type: "string", maxLength: 2_000 },
    durationMs: { type: "integer", minimum: 0, maximum: 2_000 },
    checkpoint: { type: "integer", minimum: 1 },
    reasoning: {
      type: "string",
      maxLength: REASONING_MAX_LENGTH,
      description: "One short sentence: why you chose this action.",
    },
  },
  required: ["type"],
  additionalProperties: false,
};

/**
 * Validates raw tool arguments into an AgentDecision. Throws on bad input.
 * An optional `reasoning` is kept on any decision type (see normalizeReasoning).
 */
export function parseDecision(value: unknown): AgentDecision {
  if (!value || typeof value !== "object" || !("type" in value)) {
    throw new Error("Invalid competitor decision");
  }
  const input = value as Record<string, unknown>;
  const decision = parseAction(input);
  const reasoning = normalizeReasoning(input.reasoning);
  return reasoning === undefined ? decision : { ...decision, reasoning };
}

function parseAction(input: Record<string, unknown>): AgentDecision {
  switch (input.type) {
    case "inspect":
    case "finish":
      return { type: input.type };
    case "click": {
      if (typeof input.targetRole !== "string") throw new Error("click requires targetRole");
      const label = normalizeLabel(input.label);
      return {
        type: "click",
        targetRole: input.targetRole,
        ...(label === undefined ? {} : { label }),
      };
    }
    case "type": {
      if (typeof input.targetRole !== "string" || typeof input.text !== "string") {
        throw new Error("type requires targetRole and text");
      }
      const label = normalizeLabel(input.label);
      return {
        type: "type",
        targetRole: input.targetRole,
        text: input.text,
        ...(label === undefined ? {} : { label }),
      };
    }
    case "evaluate": {
      if (typeof input.script !== "string" || input.script.trim().length === 0) {
        throw new Error("evaluate requires script");
      }
      if (input.script.length > EVALUATE_SCRIPT_MAX_LENGTH) {
        throw new Error(`evaluate script cannot exceed ${EVALUATE_SCRIPT_MAX_LENGTH} characters`);
      }
      return { type: "evaluate", script: input.script };
    }
    case "navigate":
      if (typeof input.url !== "string") throw new Error("navigate requires url");
      return { type: "navigate", url: input.url };
    case "wait":
      if (typeof input.durationMs !== "number") throw new Error("wait requires durationMs");
      return { type: "wait", durationMs: input.durationMs };
    case "checkpoint":
      if (typeof input.checkpoint !== "number") throw new Error("checkpoint requires a number");
      return { type: "checkpoint", checkpoint: input.checkpoint };
    default:
      throw new Error(`Unsupported competitor decision: ${String(input.type)}`);
  }
}

/**
 * Normalises an optional control label: whitespace is collapsed, and a blank
 * or non-string value is dropped rather than failing the model's turn.
 */
export function normalizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX_LENGTH).trim();
  return label.length > 0 ? label : undefined;
}

/**
 * Normalises the model's optional reasoning: whitespace is collapsed, it is
 * clipped at REASONING_MAX_LENGTH, and a blank or non-string value is dropped.
 */
export function normalizeReasoning(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const reasoning = value.replace(/\s+/g, " ").trim().slice(0, REASONING_MAX_LENGTH).trim();
  return reasoning.length > 0 ? reasoning : undefined;
}

/**
 * The decision without its reasoning: what the model gets back in its
 * history, and what loop signatures and dataset actions are built from.
 */
export function withoutReasoning(decision: AgentDecision): AgentDecision {
  if (decision.reasoning === undefined) return decision;
  const copy: AgentDecision = { ...decision };
  delete copy.reasoning;
  return copy;
}

/** What a competitor model is sent as its user message, before serialisation. */
export type CompetitorPrompt = Omit<CompetitorDecisionInput, "signal">;

/**
 * The model-facing part of a decision input: the task, racer, observation
 * and history (never with reasoning). The runner's abort signal is left out;
 * adapters pass it to the request instead.
 */
export function competitorPromptInput(input: CompetitorPrompt): CompetitorPrompt {
  return {
    task: input.task,
    racerId: input.racerId,
    observation: input.observation,
    history: input.history.map((entry) => ({ ...entry, decision: withoutReasoning(entry.decision) })),
  };
}

/** The exact user message every competitor adapter sends. */
export function competitorUserMessage(input: CompetitorPrompt): string {
  return JSON.stringify(competitorPromptInput(input));
}

/**
 * The exact tool call as a dataset records it: without reasoning, with the
 * typed text's length, and with the text itself replaced by "[redacted]"
 * when it went into a password field.
 */
export function datasetAction(
  decision: AgentDecision,
  options: { redactText?: boolean } = {},
): DatasetAction {
  switch (decision.type) {
    case "inspect":
    case "finish":
      return { type: decision.type };
    case "click":
      return {
        type: "click",
        targetRole: decision.targetRole,
        ...(decision.label === undefined ? {} : { label: decision.label }),
      };
    case "type":
      return {
        type: "type",
        targetRole: decision.targetRole,
        ...(decision.label === undefined ? {} : { label: decision.label }),
        text: options.redactText ? REDACTED_TEXT : decision.text,
        textLength: decision.text.length,
      };
    case "evaluate":
      return { type: "evaluate", script: decision.script };
    case "navigate":
      return { type: "navigate", url: decision.url };
    case "wait":
      return { type: "wait", durationMs: decision.durationMs };
    case "checkpoint":
      return { type: "checkpoint", checkpoint: decision.checkpoint };
  }
}

const TYPED_TEXT_MAX = 40;
const LABEL_TEXT_MAX = 60;
const RELATIVE_BASE = "http://relative.invalid";

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function describeUrl(url: string): string {
  try {
    const parsed = new URL(url, RELATIVE_BASE);
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return parsed.origin === RELATIVE_BASE ? path : `${parsed.host}${path}`;
  } catch {
    return clip(url, 80);
  }
}

/** Human-readable text for a spectator action log. */
export function describeDecision(decision: AgentDecision): string {
  switch (decision.type) {
    case "inspect":
      return "Inspected the page";
    case "click":
      return decision.label === undefined
        ? `Clicked "${decision.targetRole}"`
        : `Clicked "${clip(decision.label, LABEL_TEXT_MAX)}" (${decision.targetRole})`;
    case "type": {
      const typed = `Typed "${clip(decision.text, TYPED_TEXT_MAX)}" into`;
      return decision.label === undefined
        ? `${typed} ${decision.targetRole}`
        : `${typed} "${clip(decision.label, LABEL_TEXT_MAX)}" (${decision.targetRole})`;
    }
    case "evaluate":
      return "Ran active DOM recovery against the blocking challenge";
    case "navigate":
      return `Navigated to ${describeUrl(decision.url)}`;
    case "wait":
      return `Waited ${Math.max(0, Math.round(decision.durationMs))}ms`;
    case "checkpoint":
      return `Reported checkpoint ${decision.checkpoint}`;
    case "finish":
      return "Reported finish";
  }
}
