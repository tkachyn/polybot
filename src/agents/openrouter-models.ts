import OpenAI from "openai";
import type {
  AgentDecision,
  BrowserObservation,
  CompetitorDecisionModel,
} from "./playwright-competitor-runner.js";
import { parseAgentDecision } from "./playwright-competitor-runner.js";
import type { MasterPolicyModel } from "./master-obstacle-provider.js";
import type { DisruptionCommand } from "../domain/types.js";
import { validateDisruptionCommand } from "../infra/cdp-obstacle-provider.js";

const browserActionTool = {
  type: "function" as const,
  function: {
    name: "take_browser_action",
    description: "Take one browser action or report verified progress.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["inspect", "click", "type", "navigate", "wait", "checkpoint", "finish"],
        },
        targetRole: { type: "string", maxLength: 100 },
        text: { type: "string", maxLength: 2_000 },
        url: { type: "string", maxLength: 2_000 },
        durationMs: { type: "integer", minimum: 0, maximum: 2_000 },
        checkpoint: { type: "integer", minimum: 1 },
      },
      required: ["type"],
      additionalProperties: false,
    },
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
    tool: typeof browserActionTool | ReturnType<typeof obstacleTool>,
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
    });
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

export class OpenRouterCompetitorDecisionModel
  extends OpenRouterModelBase
  implements CompetitorDecisionModel
{
  async decide(input: {
    task: string;
    racerId: string;
    observation: BrowserObservation;
    history: Array<{ decision: AgentDecision; error?: string }>;
  }): Promise<AgentDecision> {
    const value = await this.call(
      "You control one browser racer. Choose exactly one bounded action. Use data-arena-role values when clicking or typing. Report checkpoints and completion only when the visible task state supports the claim.",
      input,
      browserActionTool,
    );
    return parseAgentDecision(value);
  }
}

export class OpenRouterMasterPolicyModel
  extends OpenRouterModelBase
  implements MasterPolicyModel
{
  async selectObstacle(
    input: Parameters<MasterPolicyModel["selectObstacle"]>[0],
  ): Promise<DisruptionCommand> {
    const value = await this.call(
      "You are the race director for a browser-agent arena. Select one bounded DOM obstacle. Keep the race fair and use only the provided semantic target roles. Never emit JavaScript.",
      input,
      obstacleTool(input.allowedHazards),
    ) as DisruptionCommand;
    validateDisruptionCommand(value);
    return value;
  }
}
