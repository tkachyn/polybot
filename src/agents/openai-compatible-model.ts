import { AnthropicCompetitorDecisionModel } from "./anthropic-models.js";
import {
  COMPETITOR_SYSTEM_PROMPT,
  COMPETITOR_TOOL_DESCRIPTION,
  COMPETITOR_TOOL_NAME,
  COMPETITOR_TOOL_SCHEMA,
  parseDecision,
  type CompetitorDecisionInput,
  type ToolJsonSchema,
} from "./competitor-decision.js";
import type {
  AgentDecision,
  CompetitorDecisionModel,
} from "./playwright-competitor-runner.js";

export const DEFAULT_MODEL_TIMEOUT_MS = 30_000;

/**
 * How the tool call is forced. "function" names the tool explicitly;
 * "required" forces any tool call, for endpoints that reject the object form.
 */
export type ToolChoiceMode = "function" | "required";

export type OpenAICompatibleModelOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Label used in error messages. Defaults to "OpenAI-compatible". */
  label?: string;
  toolChoice?: ToolChoiceMode;
  /** Drops `additionalProperties` from the tool schema. */
  looseSchema?: boolean;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      tool_calls?: Array<{
        type?: string;
        function?: { name?: string; arguments?: unknown };
      }>;
    };
  }>;
};

const ERROR_BODY_MAX = 300;

function toolParameters(loose: boolean): ToolJsonSchema {
  const schema = structuredClone(COMPETITOR_TOOL_SCHEMA);
  if (loose) delete schema.additionalProperties;
  return schema;
}

/** Competitor model for any OpenAI Chat Completions compatible endpoint. */
export class OpenAICompatibleCompetitorDecisionModel implements CompetitorDecisionModel {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly label: string;

  constructor(private readonly options: OpenAICompatibleModelOptions) {
    if (!options.baseUrl) throw new Error("OpenAI-compatible baseUrl is required");
    if (!options.apiKey) throw new Error("OpenAI-compatible apiKey is required");
    if (!options.model) throw new Error("OpenAI-compatible model is required");
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
    this.label = options.label ?? "OpenAI-compatible";
  }

  async decide(input: CompetitorDecisionInput): Promise<AgentDecision> {
    const body = {
      model: this.options.model,
      messages: [
        { role: "system", content: COMPETITOR_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(input) },
      ],
      tools: [{
        type: "function",
        function: {
          name: COMPETITOR_TOOL_NAME,
          description: COMPETITOR_TOOL_DESCRIPTION,
          parameters: toolParameters(this.options.looseSchema ?? false),
        },
      }],
      tool_choice: this.options.toolChoice === "required"
        ? "required"
        : { type: "function", function: { name: COMPETITOR_TOOL_NAME } },
    };

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error(`${this.label} request timed out after ${this.timeoutMs}ms`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${this.label} request failed: ${message}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const detail = text.replace(/\s+/g, " ").trim().slice(0, ERROR_BODY_MAX);
      throw new Error(
        `${this.label} request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }

    let payload: ChatCompletionResponse;
    try {
      payload = (await response.json()) as ChatCompletionResponse;
    } catch {
      throw new Error(`${this.label} response was not valid JSON`);
    }
    return parseDecision(this.toolArguments(payload));
  }

  private toolArguments(payload: ChatCompletionResponse): unknown {
    const calls = payload?.choices?.[0]?.message?.tool_calls;
    const call = Array.isArray(calls)
      ? calls.find((item) => item?.function?.name === COMPETITOR_TOOL_NAME) ?? calls[0]
      : undefined;
    if (!call?.function) {
      throw new Error(`${this.label} response did not call ${COMPETITOR_TOOL_NAME}`);
    }
    const raw = call.function.arguments;
    if (raw !== null && typeof raw === "object") return raw;
    if (typeof raw !== "string") {
      throw new Error(`${this.label} tool call had no arguments`);
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`${this.label} returned invalid tool arguments JSON`);
    }
  }
}

export type CompetitorProvider = "openai" | "google" | "xai" | "anthropic";

export type OpenAICompatiblePreset = {
  baseUrl: string;
  apiKeyEnv: string;
  label: string;
  toolChoice: ToolChoiceMode;
  looseSchema: boolean;
};

export const OPENAI_COMPATIBLE_PRESETS: Readonly<
  Record<Exclude<CompetitorProvider, "anthropic">, OpenAICompatiblePreset>
> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    label: "OpenAI",
    toolChoice: "function",
    looseSchema: false,
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    label: "Gemini",
    // Gemini's compatibility layer accepts a narrower schema and tool_choice.
    toolChoice: "required",
    looseSchema: true,
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    label: "xAI",
    toolChoice: "function",
    looseSchema: false,
  },
};

export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

export const COMPETITOR_PROVIDERS: readonly CompetitorProvider[] = [
  "openai",
  "anthropic",
  "google",
  "xai",
];

export function isCompetitorProvider(value: string): value is CompetitorProvider {
  return (COMPETITOR_PROVIDERS as readonly string[]).includes(value);
}

/** The environment variable holding the API key for a provider. */
export function apiKeyEnvFor(provider: CompetitorProvider): string {
  return provider === "anthropic"
    ? ANTHROPIC_API_KEY_ENV
    : OPENAI_COMPATIBLE_PRESETS[provider].apiKeyEnv;
}

export type CreateCompetitorModelOptions = {
  provider: string;
  model: string;
  /** Overrides the key from the environment. */
  apiKey?: string;
  timeoutMs?: number;
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
};

/**
 * Builds a competitor model for a provider. Throws a clear Error for an
 * unknown provider, a missing model or a missing API key.
 */
export function createCompetitorModel(
  options: CreateCompetitorModelOptions,
): CompetitorDecisionModel {
  const { provider, model } = options;
  if (!isCompetitorProvider(provider)) {
    throw new Error(
      `Unsupported competitor provider "${provider}"; expected one of ${COMPETITOR_PROVIDERS.join(", ")}`,
    );
  }
  if (!model || model.trim().length === 0) {
    throw new Error(`A model is required for provider ${provider}`);
  }
  const env = options.env ?? process.env;
  const keyEnv = apiKeyEnvFor(provider);
  const apiKey = options.apiKey ?? env[keyEnv];
  if (!apiKey) {
    throw new Error(`${keyEnv} is required for provider ${provider}`);
  }
  if (provider === "anthropic") {
    return new AnthropicCompetitorDecisionModel({ apiKey, model });
  }
  const preset = OPENAI_COMPATIBLE_PRESETS[provider];
  return new OpenAICompatibleCompetitorDecisionModel({
    baseUrl: preset.baseUrl,
    apiKey,
    model,
    timeoutMs: options.timeoutMs,
    label: preset.label,
    toolChoice: preset.toolChoice,
    looseSchema: preset.looseSchema,
  });
}
