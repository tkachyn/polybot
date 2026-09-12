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
  parseDecision,
} from "./competitor-decision.js";
import type { MasterPolicyModel } from "./master-obstacle-provider.js";
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
};

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

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("OpenRouter returned invalid tool arguments");
  }
}

abstract class OpenRouterModelBase {
  protected readonly client: OpenAI;
  protected readonly maxOutputTokens: number;

  constructor(protected readonly options: OpenRouterModelOptions) {
    if (!options.model) throw new Error("OpenRouter model is required");
    this.client = createClient(options.apiKey);
    this.maxOutputTokens = options.maxOutputTokens ?? 150;
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
    this.options.budget?.assertAvailable();
    const response = await this.client.chat.completions.create({
      model: this.options.model,
      max_tokens: this.maxOutputTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(input) },
      ],
      tools: [tool],
      tool_choice: { type: "function", function: { name: tool.function.name } },
    }, signal ? { signal } : undefined);
    const usage = response.usage as (typeof response.usage & { cost?: number }) | undefined;
    this.options.budget?.record(usage?.cost ?? 0);
    const call = response.choices[0]?.message.tool_calls?.[0];
    if (!call || call.type !== "function" || call.function.name !== tool.function.name) {
      throw new Error(`OpenRouter model ${this.options.model} did not call ${tool.function.name}`);
    }
    return parseToolArguments(call.function.arguments);
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
          targetRole: { type: "string", minLength: 1, maxLength: 100 },
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
          targetRole: { type: "string", minLength: 1, maxLength: 100 },
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
  async decide(input: {
    task: string;
    racerId: string;
    observation: BrowserObservation;
    history: Array<{ decision: AgentDecision; error?: string }>;
    signal?: AbortSignal;
  }): Promise<AgentDecision> {
    const value = await this.call(
      COMPETITOR_SYSTEM_PROMPT,
      input,
      browserActionTool,
      input.signal,
    );
    return parseDecision(value);
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
      "You are the race director for a browser-agent arena. Select one bounded DOM obstacle. Keep the race fair and use only the provided semantic target roles. Never emit JavaScript.",
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
      "You are the race director for a browser-agent arena. Select exactly one race-wide sabotage tier and one bounded DOM obstacle. The plan is immutable and will apply independently when each racer reaches the first verified target-opening milestone. Never emit JavaScript.",
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
