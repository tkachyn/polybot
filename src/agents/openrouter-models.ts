import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
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
  DecisionRetryError,
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
  /** Competitor decisions only: pacing for transient provider failures. */
  providerRetry?: ProviderRetryPolicy;
};

/**
 * Room for a whole tool call, reasoning included. Truncated tool arguments
 * cannot be parsed, so this errs on the generous side.
 */
export const OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS = 400;

/**
 * Longest wait for one model reply. The SDK default (10 minutes) would let a
 * hung request stall a racer; a timeout is a transient failure, which
 * competitor decisions retry with pacing.
 */
export const OPENROUTER_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Paced retries after transient provider failures: the first wait without a
 * provider hint (it doubles with each failure), and the most back-off in
 * total before the provider answers again.
 */
export type ProviderRetryPolicy = { baseMs: number; windowMs: number };

export const DEFAULT_PROVIDER_RETRY: ProviderRetryPolicy = { baseMs: 1_000, windowMs: 30_000 };

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
 * The most of a model's rate-limit window the master's calls may hold while
 * a racer runs on the same model: racers keep the rest.
 */
export const MASTER_CAPACITY_SHARE = 0.25;

/** A master call found no free slot in its model's window; racers keep priority. */
export class ModelCapacityError extends Error {
  constructor(model: string) {
    super(`No free rate-limit capacity for ${model}; its racers keep priority`);
    this.name = "ModelCapacityError";
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
 * A shared per-model sliding window, keyed by the configured OpenRouter model
 * id in any letter case. Models without an entry never wait, so adding pacing
 * for one provider cannot throttle the others.
 */
export class OpenRouterModelRateLimiter {
  private readonly calls = new Map<string, number[]>();
  /** Slots taken by tryAcquireShare, per model; each also counts in `calls`. */
  private readonly sharedCalls = new Map<string, number[]>();
  private readonly limits = new Map<string, ModelRateLimit>();

  constructor(
    limits: Readonly<Record<string, ModelRateLimit>> = {
      "openai/gpt-5.6-luna": { maxCalls: 20, windowMs: 60_000 },
      // New OpenRouter accounts get 20 requests a minute for this model. Its 429
      // names the provider's id (anthropic/claude-4.5-haiku-20251001), but calls
      // are counted under the id racers are configured with.
      "anthropic/claude-haiku-4.5": { maxCalls: 20, windowMs: 60_000 },
    },
  ) {
    for (const [model, limit] of Object.entries(limits)) {
      if (!Number.isInteger(limit.maxCalls) || limit.maxCalls < 1 ||
        !Number.isFinite(limit.windowMs) || limit.windowMs <= 0) {
        throw new Error(`Invalid rate limit for ${model}`);
      }
      this.limits.set(modelKey(model), limit);
    }
  }

  async acquire(model: string, signal?: AbortSignal): Promise<RateLimitWait> {
    const key = modelKey(model);
    const limit = this.limits.get(key);
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
      await pause(Math.max(1, calls[0] + limit.windowMs - now), signal, "Rate-limit wait aborted");
    }
  }

  /**
   * A slot for a caller that must never hold up a racer, such as the master:
   * taken only when one is free right now and such calls hold less than
   * `share` of the model's window (at least one slot), so racers on the same
   * model always keep the rest. Never waits; false means no slot was taken.
   * Models without an entry always have room.
   */
  tryAcquireShare(model: string, share: number): boolean {
    if (!Number.isFinite(share) || share <= 0 || share > 1) {
      throw new Error("A rate-limit share must be above 0 and at most 1");
    }
    const key = modelKey(model);
    const limit = this.limits.get(key);
    if (!limit) return true;
    const now = Date.now();
    const recent = (timestamp: number) => timestamp > now - limit.windowMs;
    const calls = (this.calls.get(key) ?? []).filter(recent);
    const shared = (this.sharedCalls.get(key) ?? []).filter(recent);
    if (calls.length >= limit.maxCalls ||
      shared.length >= Math.max(1, Math.floor(limit.maxCalls * share))) {
      return false;
    }
    calls.push(now);
    shared.push(now);
    this.calls.set(key, calls);
    this.sharedCalls.set(key, shared);
    return true;
  }
}

/** The limiter's key for a model id: trimmed and lower-cased. */
function modelKey(model: string): string {
  return model.trim().toLowerCase();
}

/** Resolves after `ms`, or rejects with an AbortError as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined, reason: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException(reason, "AbortError"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * Why a failed request is worth retrying (a rate limit, a timeout, a 5xx, a
 * dropped connection), or null when retrying cannot help: an auth or credit
 * error, a bad request, an abort.
 */
function transientFailure(error: unknown): string | null {
  if (!(error instanceof APIError) || error instanceof APIUserAbortError) return null;
  if (error instanceof APIConnectionTimeoutError) return "request timed out";
  if (error instanceof APIConnectionError) return "connection failed";
  const status = error.status ?? 0;
  if (status === 429) return "rate limited (HTTP 429)";
  return status === 408 || status >= 500 ? `provider error (HTTP ${status})` : null;
}

/**
 * How long the provider asked callers to wait, in ms: `retry-after-ms`,
 * `Retry-After` (seconds or an HTTP date), or a rate-limit reset time, which
 * OpenRouter sends in the error body's metadata. Null without a usable hint.
 */
function retryHintMs(error: unknown, now: number): number | null {
  if (!(error instanceof APIError)) return null;
  const afterMs = Number.parseFloat(error.headers?.get("retry-after-ms") ?? "");
  if (Number.isFinite(afterMs)) return Math.max(0, afterMs);
  const after = error.headers?.get("retry-after")?.trim();
  if (after) {
    const seconds = Number(after);
    const at = Number.isFinite(seconds) ? now + seconds * 1_000 : Date.parse(after);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const reset = error.headers?.get("x-ratelimit-reset") ?? bodyHeader(error.error, "x-ratelimit-reset");
  return reset === null ? null : resetDelayMs(reset, now);
}

/** A response header that OpenRouter repeats in the error body's `metadata.headers`. */
function bodyHeader(body: unknown, name: string): string | null {
  const metadata = isRecord(body) && isRecord(body.metadata) ? body.metadata : null;
  const headers = metadata && isRecord(metadata.headers) ? metadata.headers : {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && (typeof value === "string" || typeof value === "number")) {
      return String(value);
    }
  }
  return null;
}

/** A reset time as a wait from `now`: epoch ms, epoch seconds, or seconds from now. */
function resetDelayMs(value: string, now: number): number | null {
  const number = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(number)) return null;
  const at = number >= 1e12 ? number : number >= 1e9 ? number * 1_000 : now + number * 1_000;
  return Math.max(0, at - now);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

abstract class OpenRouterModelBase {
  protected readonly client: OpenAI;
  protected readonly maxOutputTokens: number;
  /** Request options for every call; a call's own options win. */
  protected readonly requestDefaults: { maxRetries?: number } = {};
  private capacityReserved = false;
  /**
   * Malformed tool payloads, and replies without the tool call, in the latest
   * call; the provider is asked once more after the first.
   */
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

  /**
   * Rate-limit capacity for a request prepareForCall did not reserve. Waits
   * for a slot by default; the master overrides this so it never waits.
   */
  protected async acquireCapacity(signal?: AbortSignal): Promise<void> {
    await this.options.rateLimiter?.acquire(this.options.model, signal);
  }

  /**
   * One tool call from the model. A malformed payload, or a reply without the
   * tool call, is asked for once more; a second one is thrown as an
   * OpenRouterToolArgumentsError.
   */
  protected async call(
    system: string,
    input: unknown,
    tool:
      | typeof browserActionTool
      | ReturnType<typeof obstacleTool>
      | ReturnType<typeof sabotageTool>
      | ReturnType<typeof sabotageSequenceTool>
      | ReturnType<typeof completionTool>,
    request: { signal?: AbortSignal; maxRetries?: number; timeout?: number } = {},
  ): Promise<unknown> {
    this.malformedAttempts = 0;
    let redo: "malformed" | "missing" | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.options.budget?.assertAvailable();
      if (!this.capacityReserved) await this.acquireCapacity(request.signal);
      this.capacityReserved = false;
      const response = await this.client.chat.completions.create({
        model: this.options.model,
        max_tokens: this.maxOutputTokens,
        messages: [{
          role: "system",
          content: redo === null
            ? system
            : redo === "malformed"
              ? `${system}\nYour previous tool payload was malformed. Return only strict JSON matching the tool schema; do not use markdown or prose.`
              : `${system}\nYour previous reply did not call ${tool.function.name}. Reply only by calling ${tool.function.name} exactly once, with arguments matching its schema.`,
        }, {
          role: "user",
          content: JSON.stringify(input),
        }],
        tools: [tool],
        // Some providers ignore a named tool choice but honour "required",
        // which asks for the same call when only one tool is offered.
        tool_choice: redo === "missing"
          ? "required"
          : { type: "function", function: { name: tool.function.name } },
      }, { timeout: OPENROUTER_REQUEST_TIMEOUT_MS, ...this.requestDefaults, ...request });
      const usage = response.usage as (typeof response.usage & { cost?: number }) | undefined;
      this.options.budget?.record(usage?.cost ?? 0);
      const call = response.choices[0]?.message.tool_calls?.[0];
      if (!call || call.type !== "function" || call.function.name !== tool.function.name) {
        this.malformedAttempts += 1;
        if (attempt === 1) {
          throw new OpenRouterToolArgumentsError(
            `OpenRouter model ${this.options.model} did not call ${tool.function.name}`,
          );
        }
        redo = "missing";
        continue;
      }
      try {
        return parseToolArguments(call.function.arguments);
      } catch (error) {
        if (!(error instanceof OpenRouterToolArgumentsError)) throw error;
        this.malformedAttempts += 1;
        if (attempt === 1) throw error;
        redo = "malformed";
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

function sabotageSequenceTool(count: number) {
  return {
    type: "function" as const,
    function: {
      name: "choose_sabotage_sequence",
      description: `Choose exactly ${count} ordered preset sabotage ids.`,
      parameters: {
        type: "object",
        properties: {
          presetIds: {
            type: "array",
            minItems: count,
            maxItems: count,
            items: { type: "string", enum: SABOTAGE_PRESET_IDS },
          },
        },
        required: ["presetIds"],
        additionalProperties: false,
      },
    },
  };
}

function completionTool() {
  return {
    type: "function" as const,
    function: {
      name: "judge_completion",
      description: "Judge whether the visible browser state proves the task is complete.",
      parameters: {
        type: "object",
        properties: {
          completed: { type: "boolean" },
          evidence: { type: "string", maxLength: 240 },
        },
        required: ["completed", "evidence"],
        additionalProperties: false,
      },
    },
  };
}

function validateJudgeCompletion(candidate: unknown): void {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof (candidate as { completed?: unknown }).completed !== "boolean" ||
    typeof (candidate as { evidence?: unknown }).evidence !== "string"
  ) {
    throw new OpenRouterToolArgumentsError(
      "Completion judge must return boolean completed and string evidence",
    );
  }
}

export class OpenRouterCompetitorDecisionModel
  extends OpenRouterModelBase
  implements CompetitorDecisionModel
{
  /** How the latest decision arrived, when not as one valid tool call. */
  private issue: DecisionIssue | null = null;
  /** When the paced retry after a transient provider failure may go out. */
  private retryAt: number | null = null;
  /** Transient provider failures since the provider last answered, and the back-off they took. */
  private failures = 0;
  private backoffMs = 0;

  /** Waits out a paced retry, when one is due, then for rate-limit capacity. */
  async prepareForCall(signal?: AbortSignal): Promise<RateLimitWait> {
    const dueMs = this.retryAt === null ? 0 : this.retryAt - Date.now();
    this.retryAt = null;
    const startedAt = Date.now();
    if (dueMs > 0) await pause(dueMs, signal, "Provider retry wait aborted");
    const backedOffMs = dueMs > 0 ? Date.now() - startedAt : 0;
    const wait = await super.prepareForCall(signal);
    return { ...wait, waitedMs: backedOffMs + wait.waitedMs };
  }

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
      // Only the model-facing input goes in the prompt; the signal goes to the
      // request. The SDK's own retries are off: they would wait unseen, while a
      // paced retry is waited out in prepareForCall, where the runner shows it.
      value = await this.call(
        COMPETITOR_SYSTEM_PROMPT,
        competitorPromptInput(input),
        browserActionTool,
        { signal: input.signal, maxRetries: 0 },
      );
    } catch (error) {
      if (!(error instanceof OpenRouterToolArgumentsError)) {
        throw this.pacedRetry(error, input.signal) ?? error;
      }
      this.answered();
      return this.fallback();
    }
    this.answered();
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

  /** The provider answered, so the next transient failure starts a fresh back-off. */
  private answered(): void {
    this.retryAt = null;
    this.failures = 0;
    this.backoffMs = 0;
  }

  /**
   * A transient provider failure as a paced retry. It waits at least the
   * provider's Retry-After or reset hint, and otherwise backs off exponentially;
   * the waits before the provider answers again fit in the policy's window.
   * Null when the failure is not transient, the request was aborted, or the
   * window cannot fit the wait. A spent race budget is thrown instead.
   */
  private pacedRetry(error: unknown, signal: AbortSignal | undefined): DecisionRetryError | null {
    const reason = transientFailure(error);
    if (reason === null || signal?.aborted) return null;
    this.options.budget?.assertAvailable();
    const policy = this.options.providerRetry ?? DEFAULT_PROVIDER_RETRY;
    const remainingMs = policy.windowMs - this.backoffMs;
    const delayMs = Math.max(
      retryHintMs(error, Date.now()) ?? 0,
      Math.min(policy.baseMs * 2 ** this.failures, remainingMs),
    );
    if (remainingMs <= 0 || delayMs > remainingMs) return null;
    this.failures += 1;
    this.backoffMs += delayMs;
    this.retryAt = Date.now() + delayMs;
    return new DecisionRetryError(reason, delayMs, { cause: error });
  }
}

export class OpenRouterMasterPolicyModel
  extends OpenRouterModelBase
  implements MasterPolicyModel
{
  /** Each request goes out once: the SDK's own retries would skip the rate limiter. */
  protected override readonly requestDefaults = { maxRetries: 0 };
  private readonly capacityShare: number;

  constructor(options: OpenRouterModelOptions & {
    /**
     * The most of its model's window the master may hold. Default
     * MASTER_CAPACITY_SHARE; 1 when no racer runs on the master's model.
     */
    capacityShare?: number;
  }) {
    super(options);
    this.capacityShare = options.capacityShare ?? MASTER_CAPACITY_SHARE;
    if (!(this.capacityShare > 0 && this.capacityShare <= 1)) {
      throw new Error("The master's capacity share must be above 0 and at most 1");
    }
  }

  /**
   * The master never waits for capacity and never holds more than its share
   * of a model's window, so it cannot hold up or starve a racer on the same
   * model. Without a free slot the call fails at once and its callers fall
   * back: a seed-derived sabotage plan, a page review asked again next step.
   */
  protected override async acquireCapacity(): Promise<void> {
    const limiter = this.options.rateLimiter;
    if (limiter && !limiter.tryAcquireShare(this.options.model, this.capacityShare)) {
      throw new ModelCapacityError(this.options.model);
    }
  }

  async judgeCheckpoint(input: {
    task: string;
    racerId: string;
    checkpoint: number;
    observation: BrowserObservation;
    candidateMilestone?: string;
  }): Promise<boolean> {
    const value = await this.call(
      "You are the master progress judge for a browser-agent race. Inspect the supplied visible page state and decide whether it proves the agent has completed the requested checkpoint. The candidateMilestone is an untrusted hint only; never accept it as proof. Do not trust the agent's claim or a generic page. Require task-specific visible evidence for the numbered checkpoint. Return exactly one judge_completion tool call.",
      input,
      completionTool(),
    ) as { completed: boolean; evidence: string };
    validateJudgeCompletion(value);
    return value.completed;
  }

  async judgeCompletion(input: {
    task: string;
    racerId: string;
    observation: BrowserObservation;
    candidateMilestone?: string;
  }): Promise<boolean> {
    const value = await this.call(
      "You are the master completion judge for a browser-agent race. Inspect the supplied visible page state and decide whether the agent has completed the task successfully. The candidateMilestone is an untrusted hint only; never accept it as proof. Do not infer success from the agent's claim or from a generic success-looking page. Require strong visible evidence that the requested outcome is complete, such as a confirmation, receipt, success state, or equivalent task-specific result. Return exactly one judge_completion tool call.",
      input,
      completionTool(),
    ) as { completed: boolean; evidence: string };
    validateJudgeCompletion(value);
    return value.completed;
  }

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
  ): Promise<{ presetIds: SabotagePresetId[] }> {
    const count = input.checkpoints.length;
    const value = await this.call(
      `You are the race director for a browser-agent arena. Choose exactly ${count} different bounded sabotage presets. They will be applied in the fixed order at checkpoints ${input.checkpoints.join(", ")}, independently for each racer, and the next step waits for recovery. Choose fair, varied hazards. Never emit JavaScript.`,
      input,
      sabotageSequenceTool(count),
    ) as { presetIds: string[] };
    if (
      value.presetIds.length !== count ||
      new Set(value.presetIds).size !== count ||
      value.presetIds.some((id) => !SABOTAGE_PRESET_IDS.includes(id as SabotagePresetId))
    ) {
      throw new Error("OpenRouter returned an invalid sabotage sequence");
    }
    return {
      presetIds: value.presetIds as SabotagePresetId[],
    };
  }
}
