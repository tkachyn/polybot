import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentDecision,
  BrowserObservation,
  CompetitorDecisionModel,
} from "./playwright-competitor-runner.js";
import { parseAgentDecision } from "./playwright-competitor-runner.js";
import type { MasterPolicyModel } from "./master-obstacle-provider.js";
import type { DisruptionCommand } from "../domain/types.js";
import { validateDisruptionCommand } from "../infra/cdp-obstacle-provider.js";

type AnthropicModelOptions = {
  apiKey?: string;
  model: string;
};

function createClient(apiKey?: string): Anthropic {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is required");
  return new Anthropic({ apiKey: key });
}

function toolInput(response: Anthropic.Message, toolName: string): unknown {
  const block = response.content.find(
    (item) => item.type === "tool_use" && item.name === toolName,
  );
  if (!block || block.type !== "tool_use") {
    throw new Error(`Anthropic response did not call ${toolName}`);
  }
  return block.input;
}

export class AnthropicMasterPolicyModel implements MasterPolicyModel {
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicModelOptions) {
    this.client = createClient(options.apiKey);
  }

  async selectObstacle(
    input: Parameters<MasterPolicyModel["selectObstacle"]>[0],
  ): Promise<DisruptionCommand> {
    const response = await this.client.messages.create({
      model: this.options.model,
      max_tokens: 500,
      system:
        "You are the race director for a browser-agent arena. Select one bounded DOM obstacle. Keep the race fair and use only the provided semantic target roles. Never emit JavaScript.",
      messages: [{
        role: "user",
        content: JSON.stringify(input),
      }],
      tools: [{
        name: "choose_obstacle",
        description: "Choose one validated obstacle for this checkpoint.",
        input_schema: {
          type: "object",
          properties: {
            hazardType: { type: "string", enum: input.allowedHazards },
            targetRole: { type: "string", minLength: 1, maxLength: 100 },
            durationMs: { type: "integer", minimum: 0, maximum: 30_000 },
            intensity: { type: "integer", minimum: 1, maximum: 3 },
          },
          required: ["hazardType", "targetRole", "durationMs", "intensity"],
          additionalProperties: false,
        },
      }],
      tool_choice: { type: "tool", name: "choose_obstacle" },
    });
    const policy = toolInput(response, "choose_obstacle") as DisruptionCommand;
    validateDisruptionCommand(policy);
    return policy;
  }
}

export class AnthropicCompetitorDecisionModel implements CompetitorDecisionModel {
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicModelOptions) {
    this.client = createClient(options.apiKey);
  }

  async decide(input: {
    task: string;
    racerId: string;
    observation: BrowserObservation;
    history: Array<{ decision: AgentDecision; error?: string }>;
  }): Promise<AgentDecision> {
    const response = await this.client.messages.create({
      model: this.options.model,
      max_tokens: 500,
      system:
        "You control one browser racer. Choose exactly one bounded action. Use data-arena-role values when clicking or typing. Report checkpoints and completion only when the visible task state supports the claim.",
      messages: [{ role: "user", content: JSON.stringify(input) }],
      tools: [{
        name: "take_browser_action",
        description: "Take one browser action or report verified progress.",
        input_schema: {
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
      }],
      tool_choice: { type: "tool", name: "take_browser_action" },
    });
    return parseAgentDecision(toolInput(response, "take_browser_action"));
  }
}
