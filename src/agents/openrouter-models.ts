import OpenAI from "openai";
import type {
  AgentDecision,
  BrowserObservation,
  CompetitorDecisionModel,
} from "./playwright-competitor-runner.js";
import {
  COMPETITOR_SYSTEM_PROMPT,
  COMPETITOR_TOOL_DESCRIPTION,
  COMPETITOR_TOOL_NAME,
  COMPETITOR_TOOL_SCHEMA,
  competitorPromptInput,
  parseDecision,
} from "./competitor-decision.js";
import type { MasterPolicyModel } from "./master-obstacle-provider.js";
import type { DecisionIssue } from "../api/dto.js";
import type { DisruptionCommand, SabotageTier } from "../domain/types.js";
import { validateDisruptionCommand } from "../infra/cdp-obstacle-provider.js";
import {
  SABOTAGE_PRESET_IDS,
  type SabotagePresetId,
} from "../domain/sabotage-presets.js";

const browserActionTool = {
  type: "function" as const,
  function: {
    name: COMPETITOR_TOOL_NAME,
    description: COMPETITOR_TOOL_DESCRIPTION,
    parameters: structuredClone(COMPETITOR_TOOL_SCHEMA),
  },
};

type OpenRouterModelOptions = {
  model: string;
  apiKey?: string;
  budget?: OpenRouterUsageBudget;
  maxOutputTokens?: number;
  rateLimiter?: OpenRouterModelRateLimiter;
};

/**
 * Room for a whole tool call, reasoning included. Truncated tool arguments
 * cannot be parsed, so this errs on the generous side.
 */
export const OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS = 400;

export type OpenRouterUsageSnapshot = {
  limitUsd: number;
  spentUsd: number;
  remainingUsd: number;
  requests: number;
};

export class OpenRouterUsageBudget {
  private spentUsd = 0;
  private requests = 0;

  constructor(readonly limitUsd: number) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
      throw new Error("OpenRouter race budget must be a positive number");
    }
  }

  assertAvailable(): void {
    if (this.spentUsd >= this.limitUsd) {
      throw new Error(`OpenRouter race budget of $${this.limitUsd.toFixed(2)} was exhausted`);
    }
  }

  record(costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd < 0) return;
    this.spentUsd += costUsd;
    this.requests += 1;
  }

  snapshot(): OpenRouterUsageSnapshot {
    return {
      limitUsd: this.limitUsd,
      spentUsd: this.spentUsd,
      remainingUsd: Math.max(0, this.limitUsd - this.spentUsd),
      requests: this.requests,
    };
  }
}

function createClient(apiKey?: string): OpenAI {
  const key = apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is required");
  return new OpenAI({
    apiKey: key,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": process.env.OPENROUTER_APP_URL ?? "http://localhost:3001",
      "X-OpenRouter-Title": process.env.OPENROUTER_APP_NAME ?? "Browser Agent Arena",
    },
  });
}

export class OpenRouterToolArgumentsError extends Error {
  constructor(message = "OpenRouter returned invalid tool arguments") {
    super(message);
    this.name = "OpenRouterToolArgumentsError";
  }
}

/**
 * Providers occasionally wrap otherwise-valid tool JSON in markdown or add a
 * short preamble. Accept only bounded JSON repairs; never evaluate provider
 * output as JavaScript.
 */
export function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    if (value && typeof value === "object") return value;
    throw new OpenRouterToolArgumentsError();
  }
  const source = value.trim();
  const stripped = source.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const candidates = [
    source,
    stripped,
    source.replace(/,\s*([}\]])/g, "$1"),
    stripped.replace(/,\s*([}\]])/g, "$1"),
  ];
  const objectStart = source.indexOf("{");
  const objectEnd = source.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(source.slice(objectStart, objectEnd + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next bounded representation.
    }
  }
  throw new OpenRouterToolArgumentsError();
}

export type ModelRateLimit = {
  maxCalls: number;
  windowMs: number;
};

export type RateLimitWait = {
  waitedMs: number;
  maxCalls: number;
  windowMs: number;
};

/**
 * A shared per-model sliding window. Models without a configured entry never
 * wait, so adding pacing for one provider cannot throttle the others.
 */
export class OpenRouterModelRateLimiter {
  private readonly calls = new Map<string, number[]>();

  constructor(
    private readonly limits: Readonly<Record<string, ModelRateLimit>> = {
      "openai/gpt-5.6-luna": { maxCalls: 20, windowMs: 60_000 },
    },
  ) {
    for (const [model, limit] of Object.entries(limits)) {
      if (!Number.isInteger(limit.maxCalls) || limit.maxCalls < 1 ||
        !Number.isFinite(limit.windowMs) || limit.windowMs <= 0) {
        throw new Error(`Invalid rate limit for ${model}`);
      }
    }
  }

  async acquire(model: string, signal?: AbortSignal): Promise<RateLimitWait> {
    const key = model.trim().toLowerCase();
    const limit = this.limits[key];
    if (!limit) return { waitedMs: 0, maxCalls: 0, windowMs: 0 };
    const startedAt = Date.now();
    for (;;) {
      if (signal?.aborted) throw new DOMException("Rate-limit wait aborted", "AbortError");
      const now = Date.now();
      const calls = (this.calls.get(key) ?? []).filter((timestamp) =>
        timestamp > now - limit.windowMs,
      );
      if (calls.length < limit.maxCalls) {
        calls.push(now);
        this.calls.set(key, calls);
        return { waitedMs: now - startedAt, ...limit };
      }
      const waitMs = Math.max(1, calls[0] + limit.windowMs - now);
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(new DOMException("Rate-limit wait aborted", "AbortError"));
        };
        timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, waitMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    }
  }
}

abstract class OpenRouterModelBase {
  protected readonly client: OpenAI;
  protected readonly maxOutputTokens: number;
  private capacityReserved = false;
  /** Malformed tool payloads in the latest call; the provider is asked once more after the first. */
  protected malformedAttempts = 0;

  constructor(protected readonly options: OpenRouterModelOptions) {
    if (!options.model) throw new Error("OpenRouter model is required");
    this.client = createClient(options.apiKey);
    this.maxOutputTokens = options.maxOutputTokens ?? OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS;
  }

  async prepareForCall(signal?: AbortSignal): Promise<RateLimitWait> {
    const wait = await this.options.rateLimiter?.acquire(this.options.model, signal) ??
      { waitedMs: 0, maxCalls: 0, windowMs: 0 };
    this.capacityReserved = true;
    return wait;
  }

  protected async call(
    system: string,
    input: unknown,
    tool:
      | typeof browserActionTool
      | ReturnType<typeof obstacleTool>
      | ReturnType<typeof sabotageTool>
      | ReturnType<typeof sabotageSequenceTool>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.malformedAttempts = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.options.budget?.assertAvailable();
      if (!this.capacityReserved) {
        await this.options.rateLimiter?.acquire(this.options.model, signal);
      }
      this.capacityReserved = false;
      const response = await this.client.chat.completions.create({
        model: this.options.model,
        max_tokens: this.maxOutputTokens,
        messages: [{
          role: "system",
          content: attempt === 0
            ? system
            : `${system}\nYour previous tool payload was malformed. Return only strict JSON matching the tool schema; do not use markdown or prose.`,
        }, {
          role: "user",
          content: JSON.stringify(input),
        }],
        tools: [tool],
        tool_choice: { type: "function", function: { name: tool.function.name } },
      }, signal ? { signal } : undefined);
      const usage = response.usage as (typeof response.usage & { cost?: number }) | undefined;
      this.options.budget?.record(usage?.cost ?? 0);
      const call = response.choices[0]?.message.tool_calls?.[0];
      if (!call || call.type !== "function" || call.function.name !== tool.function.name) {
        throw new Error(`OpenRouter model ${this.options.model} did not call ${tool.function.name}`);
      }
      try {
        return parseToolArguments(call.function.arguments);
      } catch (error) {
        if (!(error instanceof OpenRouterToolArgumentsError)) throw error;
        this.malformedAttempts += 1;
        if (attempt === 1) throw error;
      }
    }
    throw new OpenRouterToolArgumentsError();
  }
}

function obstacleTool(allowedHazards: DisruptionCommand["hazardType"][]) {
  return {
    type: "function" as const,
    function: {
      name: "choose_obstacle",
      description: "Choose one validated obstacle for this checkpoint.",
      parameters: {
        type: "object",
        properties: {
          hazardType: { type: "string", enum: allowedHazards },
          targetRole: { type: "string", enum: ["primary-action"] },
          durationMs: { type: "integer", minimum: 0, maximum: 30_000 },
          intensity: { type: "integer", minimum: 1, maximum: 3 },
        },
        required: ["hazardType", "targetRole", "durationMs", "intensity"],
        additionalProperties: false,
      },
    },
  };
}

function sabotageTool(
  allowedHazards: DisruptionCommand["hazardType"][],
  allowedTiers: SabotageTier[],
) {
  return {
    type: "function" as const,
    function: {
      name: "choose_sabotage",
      description: "Choose exactly one bounded race-wide sabotage plan.",
      parameters: {
        type: "object",
        properties: {
          tier: { type: "string", enum: allowedTiers },
          hazardType: { type: "string", enum: allowedHazards },
          targetRole: { type: "string", enum: ["primary-action"] },
          durationMs: { type: "integer", minimum: 0, maximum: 30_000 },
          intensity: { type: "integer", minimum: 1, maximum: 3 },
        },
        required: ["tier", "hazardType", "targetRole", "durationMs", "intensity"],
        additionalProperties: false,
      },
    },
  };
}

function sabotageSequenceTool() {
  return {
    type: "function" as const,
    function: {
      name: "choose_sabotage_sequence",
      description: "Choose exactly three ordered preset sabotage ids for checkpoints 2, 3, and 4.",
      parameters: {
        type: "object",
        properties: {
          presetIds: {
            type: "array",
            minItems: 3,
            maxItems: 3,
            items: { type: "string", enum: SABOTAGE_PRESET_IDS },
          },
        },
        required: ["presetIds"],
        additionalProperties: false,
      },
    },
  };
}

export class OpenRouterCompetitorDecisionModel
  extends OpenRouterModelBase
  implements CompetitorDecisionModel
{
  prepareForCall(signal?: AbortSignal): Promise<RateLimitWait> {
    return super.prepareForCall(signal);
  }

  /** How the latest decision arrived, when not as one valid tool call. */
  private issue: DecisionIssue | null = null;

  /** The latest decision's issue, if any. Cleared on read, so it never leaks into the next step. */
  takeDecisionIssue(): DecisionIssue | null {
    const issue = this.issue;
    this.issue = null;
    return issue;
  }

  async decide(input: {
    task: string;
    racerId: string;
    observation: BrowserObservation;
    history: Array<{ decision: AgentDecision; error?: string }>;
    signal?: AbortSignal;
  }): Promise<AgentDecision> {
    this.issue = null;
    let value: unknown;
    try {
      // Only the model-facing input goes in the prompt; the signal goes to the request.
      value = await this.call(
        COMPETITOR_SYSTEM_PROMPT,
        competitorPromptInput(input),
        browserActionTool,
        input.signal,
      );
    } catch (error) {
      if (error instanceof OpenRouterToolArgumentsError) return this.fallback();
      throw error;
    }
    try {
      const decision = parseDecision(value);
      if (this.malformedAttempts > 0) {
        this.issue = { malformedAttempts: this.malformedAttempts, fallback: false };
      }
      return decision;
    } catch {
      // A malformed tool payload is recoverable: inspect again so the agent
      // can make progress on the next turn instead of terminating the racer.
      this.malformedAttempts += 1;
      return this.fallback();
    }
  }

  /** The runner inspects instead, and the step records that the model gave no usable call. */
  private fallback(): AgentDecision {
    this.issue = { malformedAttempts: this.malformedAttempts, fallback: true };
    return { type: "inspect" };
  }
}

export class OpenRouterMasterPolicyModel
  extends OpenRouterModelBase
  implements MasterPolicyModel
{
  async selectObstacle(
    input: Parameters<NonNullable<MasterPolicyModel["selectObstacle"]>>[0],
  ): Promise<DisruptionCommand> {
    const value = await this.call(
      "You are the race director for a browser-agent arena. Select one bounded DOM obstacle targeting the stable primary-action role. Keep the race fair; prefer a modal with no Close control, a decoy, a disabled/renamed control, or a moved action that makes the competitor inspect and actively repair the DOM. Never emit JavaScript.",
      input,
      obstacleTool(input.allowedHazards),
    ) as DisruptionCommand;
    validateDisruptionCommand(value);
    return value;
  }

  async selectSabotage(
    input: Parameters<NonNullable<MasterPolicyModel["selectSabotage"]>>[0],
  ): Promise<{ tier: SabotageTier; policy: DisruptionCommand }> {
    const tool = sabotageTool(input.allowedHazards, input.allowedTiers);
    const value = await this.call(
      "You are the race director for a browser-agent arena. Select exactly one race-wide sabotage tier and one bounded DOM obstacle targeting the stable primary-action role. Prefer obstacles that require active reasoning: a blocking modal has no Close control and requires bounded DOM recovery; a decoy requires comparing labels/attributes; a disabled or renamed control requires DOM inspection; moving the action requires finding the disclosure. The plan is immutable and will apply independently when each racer reaches the first verified target-opening milestone. Never emit JavaScript.",
      input,
      tool,
    ) as { tier: SabotageTier; hazardType: DisruptionCommand["hazardType"]; targetRole: string; durationMs: number; intensity: number };
    const { tier, ...policy } = value;
    validateDisruptionCommand(policy);
    return { tier, policy };
  }

  async selectSabotageSequence(
    input: Parameters<NonNullable<MasterPolicyModel["selectSabotageSequence"]>>[0],
  ): Promise<{ presetIds: [SabotagePresetId, SabotagePresetId, SabotagePresetId] }> {
    const value = await this.call(
      "You are the race director for a browser-agent arena. Choose exactly three different bounded sabotage presets. They will be applied in the fixed order at checkpoints 2, 3, and 4, independently for each racer, and the next step waits for recovery. Choose fair, varied hazards. Never emit JavaScript.",
      input,
      sabotageSequenceTool(),
    ) as { presetIds: string[] };
    if (
      value.presetIds.length !== 3 ||
      new Set(value.presetIds).size !== 3 ||
      value.presetIds.some((id) => !SABOTAGE_PRESET_IDS.includes(id as SabotagePresetId))
    ) {
      throw new Error("OpenRouter returned an invalid sabotage sequence");
    }
    return {
      presetIds: value.presetIds as [SabotagePresetId, SabotagePresetId, SabotagePresetId],
    };
  }
}
