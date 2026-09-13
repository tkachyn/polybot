import { resolve } from "node:path";
import {
  MasterObstacleProvider,
  type RaceObservationSource,
} from "../agents/master-obstacle-provider.js";
import {
  MASTER_CAPACITY_SHARE,
  OpenRouterCompetitorDecisionModel,
  OpenRouterMasterPolicyModel,
  OpenRouterModelRateLimiter,
  OpenRouterUsageBudget,
  type ModelRateLimit,
} from "../agents/openrouter-models.js";
import { PlaywrightCompetitorRunner } from "../agents/playwright-competitor-runner.js";
import type { AgentIdentity } from "../api/dto.js";
import type { ApiCreateRaceInput } from "../api/race-registry.js";
import {
  DeterministicCourseVerifier,
  HttpCourseStateGateway,
} from "../course/deterministic-course-verifier.js";
import type { DisruptionCommand, SabotageTier } from "../domain/types.js";
import { CdpObstacleProvider } from "../infra/cdp-obstacle-provider.js";
import { SteelSessionManager } from "../infra/steel-session-manager.js";
import type { DatasetStore } from "../dataset/store.js";
import type { EvaluationStore } from "../evaluation/store.js";
import { FileReplayStore } from "../infra/replay-store.js";
import { JsonlRaceEventStore } from "../persistence/jsonl-event-store.js";
import type { CreditLedger } from "../wallet/credit-ledger.js";
import type { ReplayStore } from "./contracts.js";
import type { FightMetadata } from "./fight-metadata.js";
import { RaceCoordinator } from "./race-coordinator.js";

/** What the registry supplies alongside the operator's input. */
export type ProductionRaceContext = {
  /** The shared wallet every market settles into. */
  ledger: CreditLedger;
  /**
   * Fight metadata. Its agents are replaced by the OpenRouter roster from
   * COMPETITOR_LLM_MODELS (see openRouterAgents).
   */
  fight: Partial<FightMetadata>;
  /** Where the fight's final evaluation is stored once it closes. */
  evaluationStore?: EvaluationStore;
  /** Where the fight's training record is stored once it closes. */
  datasetStore?: DatasetStore;
  /** Where released Steel recordings are copied for durable replay. */
  replayStore?: ReplayStore;
};

export const OPENROUTER_PROVIDER = "openrouter";
export const COMPETITOR_ROSTER_SIZE = 4;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = positiveNumberEnv(name, fallback);
  if (!Number.isInteger(value)) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** OpenRouter model id per racer id, from COMPETITOR_LLM_MODELS. */
export function competitorRoster(
  value = requiredEnv("COMPETITOR_LLM_MODELS"),
): Map<string, string> {
  const models = value
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  if (models.length !== COMPETITOR_ROSTER_SIZE) {
    throw new Error("COMPETITOR_LLM_MODELS must contain exactly four comma-separated models");
  }
  return new Map(models.map((model, index) => [`racer-${index + 1}`, model]));
}

/** UI identity keys for OpenRouter vendors; colours in the web app key on these. */
const VENDOR_AGENT_KEYS: Record<string, string> = {
  openai: "gpt",
  anthropic: "claude",
  google: "gemini",
  "x-ai": "grok",
};
const UPPERCASE_TOKENS = new Set(["gpt", "it", "ai", "llm"]);
const BRAND_TOKENS: Record<string, string> = { deepseek: "DeepSeek" };

/**
 * A readable label for an OpenRouter model id, so a racer is never shown
 * under another model's name: "openai/gpt-5.6-luna" → "GPT-5.6 Luna",
 * "google/gemma-3-27b-it" → "Gemma 3 27B IT".
 */
export function displayNameForModel(model: string): string {
  const slug = (model.split("/").pop() ?? model).split(":")[0] ?? model;
  const words = slug
    .split("-")
    .filter(Boolean)
    .map((token) => {
      const lower = token.toLowerCase();
      const brand = BRAND_TOKENS[lower];
      if (brand) return brand;
      if (UPPERCASE_TOKENS.has(lower) || /^\d+(\.\d+)?b$/.test(lower) || /^v\d/.test(lower)) {
        return token.toUpperCase();
      }
      return token.charAt(0).toUpperCase() + token.slice(1);
    });
  return words.join(" ").replace(/^GPT (\d)/, "GPT-$1");
}

/** The identity key for a model: its vendor's key, else the vendor name. */
export function agentKeyForModel(model: string): string {
  const vendor = model.includes("/") ? model.split("/")[0].toLowerCase() : "";
  const key = VENDOR_AGENT_KEYS[vendor] ?? vendor;
  return key || displayNameForModel(model).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/**
 * The live fight's agents, each driven by its OpenRouter roster model. An
 * operator-supplied roster keeps its keys and names. Otherwise each agent is
 * named after the model it actually runs, with keys made unique.
 */
export function openRouterAgents(
  agents: readonly AgentIdentity[] | undefined,
  roster: ReadonlyMap<string, string>,
): AgentIdentity[] {
  if (agents && agents.length !== COMPETITOR_ROSTER_SIZE) {
    throw new Error(`A live fight needs exactly ${COMPETITOR_ROSTER_SIZE} agents, got ${agents.length}`);
  }
  const usedKeys = new Set<string>();
  return Array.from({ length: COMPETITOR_ROSTER_SIZE }, (_, index) => {
    const model = roster.get(`racer-${index + 1}`);
    if (!model) throw new Error(`No OpenRouter model configured for racer-${index + 1}`);
    const operator = agents?.[index];
    if (operator) {
      return { key: operator.key, name: operator.name, provider: OPENROUTER_PROVIDER, model };
    }
    const base = agentKeyForModel(model);
    let key = base;
    for (let suffix = 2; usedKeys.has(key); suffix += 1) key = `${base}-${suffix}`;
    usedKeys.add(key);
    return { key, name: displayNameForModel(model), provider: OPENROUTER_PROVIDER, model };
  });
}

/**
 * One sliding-window limit per configured model, the racers' and the
 * master's alike, so every call to a model counts against the same capacity.
 */
export function modelRateLimits(
  models: ReadonlyArray<string | undefined>,
  limit: ModelRateLimit,
): Record<string, ModelRateLimit> {
  const configured = models.filter((model): model is string => Boolean(model?.trim()));
  return Object.fromEntries([...new Set(configured)].map((model) => [model, { ...limit }]));
}

/**
 * The most of its model's window the master may hold: MASTER_CAPACITY_SHARE
 * while a racer runs on the same model, so the racers keep the rest, else
 * the whole window.
 */
export function masterCapacityShare(
  roster: ReadonlyMap<string, string>,
  masterModel: string,
): number {
  const key = masterModel.trim().toLowerCase();
  return [...roster.values()].some((model) => model.trim().toLowerCase() === key)
    ? MASTER_CAPACITY_SHARE
    : 1;
}

export function createProductionRaceCoordinator(
  input: ApiCreateRaceInput,
  context: ProductionRaceContext,
): RaceCoordinator {
  // Resolve models first so misconfiguration fails before any session exists.
  const roster = competitorRoster();
  // context.fight.agents is always the normalised default roster; only an
  // explicit operator roster (input.agents) may override model-derived names.
  const agents = openRouterAgents(input.agents, roster);
  const budget = new OpenRouterUsageBudget(
    positiveNumberEnv("RACE_LLM_BUDGET_USD", 0.25),
  );
  const masterModelId = process.env.MASTER_LLM_MODEL;
  // One sliding window per configured model, shared by every caller of that
  // model, racers and master alike. A provider-specific 429 cannot kill a
  // racer before its first browser action, and the master's calls count
  // against the same capacity as the racers on its model.
  const rateLimiter = new OpenRouterModelRateLimiter(modelRateLimits(
    [...roster.values(), masterModelId],
    {
      maxCalls: positiveIntegerEnv("OPENROUTER_MODEL_MAX_CALLS_PER_MINUTE", 20),
      windowMs: positiveIntegerEnv("OPENROUTER_MODEL_RATE_WINDOW_MS", 60_000),
    },
  ));
  const maxOutputTokens = positiveIntegerEnv("COMPETITOR_LLM_MAX_OUTPUT_TOKENS", 512);
  const competitorModels = new Map(
    [...roster].map(([racerId, model]) => [
      racerId,
      new OpenRouterCompetitorDecisionModel({
        model,
        budget,
        maxOutputTokens,
        rateLimiter,
      }),
    ]),
  );

  const sessionManager = new SteelSessionManager();
  const agentRunner = new PlaywrightCompetitorRunner({
    task: context.fight.task ?? input.task,
    startUrl: input.startUrl,
    modelForRacer(racerId) {
      const model = competitorModels.get(racerId);
      if (!model) throw new Error(`No OpenRouter model configured for ${racerId}`);
      return model;
    },
  });
  const courseVerifier = new DeterministicCourseVerifier(
    new HttpCourseStateGateway(
      requiredEnv("COURSE_BASE_URL"),
      process.env.COURSE_VERIFIER_TOKEN,
    ),
  );
  const eventStore = new JsonlRaceEventStore(
    resolve(process.env.RACE_EVENT_FILE ?? "data/race-events.jsonl"),
  );

  let coordinator: RaceCoordinator | undefined;
  const observationSource: RaceObservationSource = {
    async observe(raceId, checkpoint) {
      if (!coordinator) throw new Error("Race coordinator is not initialized");
      const snapshot = coordinator.snapshot();
      return {
        raceId,
        checkpoint,
        racers: snapshot.racers.map((racer) => ({
          racerId: racer.racerId,
          checkpoint: racer.checkpoint,
          status: racer.status,
        })),
      };
    },
  };

  const fallbackPolicies: Partial<Record<SabotageTier, DisruptionCommand>> = {
    basic: {
      hazardType: "insert_decoy",
      targetRole: "primary-action",
      durationMs: 4_000,
      intensity: 1,
    },
    intermediate: {
      hazardType: "rename_control",
      targetRole: "primary-action",
      durationMs: 6_000,
      intensity: 2,
    },
    difficult: {
      hazardType: "blocking_modal",
      targetRole: "primary-action",
      durationMs: 12_000,
      intensity: 3,
    },
  };
  const cdpExecutor = new CdpObstacleProvider(sessionManager);
  const masterModel = masterModelId
    ? new OpenRouterMasterPolicyModel({
        model: masterModelId,
        budget,
        rateLimiter,
        capacityShare: masterCapacityShare(roster, masterModelId),
      })
    : undefined;
  if (input.obstaclesEnabled && !masterModel) requiredEnv("MASTER_LLM_MODEL");
  const obstacleProvider = input.obstaclesEnabled
    ? new MasterObstacleProvider(
        masterModel!,
        observationSource,
        cdpExecutor,
        fallbackPolicies,
      )
    : undefined;

  coordinator = new RaceCoordinator(
    {
      ...input,
      competitorModels: Object.fromEntries(roster),
      fight: { ...context.fight, agents },
    },
    {
      sessionManager,
      agentRunner,
      courseVerifier,
      completionJudge: masterModel,
      eventStore,
      obstacleProvider,
      ledger: context.ledger,
      llmUsage: () => budget.snapshot(),
      evaluationStore: context.evaluationStore,
      datasetStore: context.datasetStore,
      replayStore: context.replayStore ?? new FileReplayStore(resolve(process.env.REPLAY_DIR ?? "data/replays")),
      mode: "live",
    },
  );
  return coordinator;
}
