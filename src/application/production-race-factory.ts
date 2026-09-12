import { resolve } from "node:path";
import {
  MasterObstacleProvider,
  type RaceObservationSource,
} from "../agents/master-obstacle-provider.js";
import {
  OpenRouterCompetitorDecisionModel,
  OpenRouterMasterPolicyModel,
  OpenRouterUsageBudget,
} from "../agents/openrouter-models.js";
import { PlaywrightCompetitorRunner } from "../agents/playwright-competitor-runner.js";
import type { AgentIdentity } from "../api/dto.js";
import type { ApiCreateRaceInput } from "../api/race-registry.js";
import {
  DeterministicCourseVerifier,
  HttpCourseStateGateway,
} from "../course/deterministic-course-verifier.js";
import type { DisruptionCommand } from "../domain/types.js";
import { CdpObstacleProvider } from "../infra/cdp-obstacle-provider.js";
import { SteelSessionManager } from "../infra/steel-session-manager.js";
import type { EvaluationStore } from "../evaluation/store.js";
import { JsonlRaceEventStore } from "../persistence/jsonl-event-store.js";
import type { CreditLedger } from "../wallet/credit-ledger.js";
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
  const competitorModels = new Map(
    [...roster].map(([racerId, model]) => [
      racerId,
      new OpenRouterCompetitorDecisionModel({ model, budget }),
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

  const fallbackPolicies: Record<number, DisruptionCommand> = {
    1: {
      hazardType: "blocking_modal",
      targetRole: "primary-action",
      durationMs: 4_000,
      intensity: 1,
    },
    2: {
      hazardType: "blocking_modal",
      targetRole: "primary-action",
      durationMs: 6_000,
      intensity: 2,
    },
    3: {
      hazardType: "blocking_modal",
      targetRole: "primary-action",
      durationMs: 8_000,
      intensity: 3,
    },
  };
  const cdpExecutor = new CdpObstacleProvider(sessionManager);
  const obstacleProvider = input.obstaclesEnabled
    ? new MasterObstacleProvider(
        new OpenRouterMasterPolicyModel({
          model: requiredEnv("MASTER_LLM_MODEL"),
          budget,
        }),
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
      eventStore,
      obstacleProvider,
      ledger: context.ledger,
      llmUsage: () => budget.snapshot(),
      evaluationStore: context.evaluationStore,
      mode: "live",
    },
  );
  return coordinator;
}
