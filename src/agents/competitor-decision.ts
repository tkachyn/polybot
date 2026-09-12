import type {
  AgentDecision,
  CompetitorDecisionModel,
} from "./playwright-competitor-runner.js";

/** The input every competitor decision model receives. */
export type CompetitorDecisionInput = Parameters<CompetitorDecisionModel["decide"]>[0];

export const COMPETITOR_TOOL_NAME = "take_browser_action";
export const COMPETITOR_TOOL_DESCRIPTION =
  "Take one browser action or report verified progress.";
export const COMPETITOR_SYSTEM_PROMPT =
  "You control one browser racer. Choose exactly one bounded action. Use data-arena-role values when clicking or typing. Report checkpoints and completion only when the visible task state supports the claim.";

export const DECISION_TYPES = [
  "inspect",
  "click",
  "type",
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
    text: { type: "string", maxLength: 2_000 },
    url: { type: "string", maxLength: 2_000 },
    durationMs: { type: "integer", minimum: 0, maximum: 2_000 },
    checkpoint: { type: "integer", minimum: 1 },
  },
  required: ["type"],
  additionalProperties: false,
};

/** Validates raw tool arguments into an AgentDecision. Throws on bad input. */
export function parseDecision(value: unknown): AgentDecision {
  if (!value || typeof value !== "object" || !("type" in value)) {
    throw new Error("Invalid competitor decision");
  }
  const input = value as Record<string, unknown>;
  switch (input.type) {
    case "inspect":
    case "finish":
      return { type: input.type };
    case "click":
      if (typeof input.targetRole !== "string") throw new Error("click requires targetRole");
      return { type: "click", targetRole: input.targetRole };
    case "type":
      if (typeof input.targetRole !== "string" || typeof input.text !== "string") {
        throw new Error("type requires targetRole and text");
      }
      return { type: "type", targetRole: input.targetRole, text: input.text };
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

const TYPED_TEXT_MAX = 40;
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
      return `Clicked "${decision.targetRole}"`;
    case "type":
      return `Typed "${clip(decision.text, TYPED_TEXT_MAX)}" into ${decision.targetRole}`;
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
