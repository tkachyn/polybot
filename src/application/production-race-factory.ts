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
import { JsonlRaceEventStore } from "../persistence/jsonl-event-store.js";
import type { CreditLedger } from "../wallet/credit-ledger.js";
import { DEFAULT_AGENT_ROSTER, type FightMetadata } from "./fight-metadata.js";
import { RaceCoordinator } from "./race-coordinator.js";

/** What the registry supplies alongside the operator's input. */
export type ProductionRaceContext = {
  /** The shared wallet every market settles into. */
  ledger: CreditLedger;
  /**
   * Fight metadata. Each agent keeps its key and name; its provider and
   * model are replaced by the OpenRouter roster from COMPETITOR_LLM_MODELS.
   */
  fight: Partial<FightMetadata>;
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

/** The fight's agents (or the default roster) driven by the OpenRouter roster. */
export function openRouterAgents(
  agents: readonly AgentIdentity[] | undefined,
  roster: ReadonlyMap<string, string>,
): AgentIdentity[] {
  const base = agents ?? DEFAULT_AGENT_ROSTER;
  if (base.length !== COMPETITOR_ROSTER_SIZE) {
    throw new Error(`A live fight needs exactly ${COMPETITOR_ROSTER_SIZE} agents, got ${base.length}`);
  }
  return base.map((agent, index) => {
    const model = roster.get(`racer-${index + 1}`);
    if (!model) throw new Error(`No OpenRouter model configured for racer-${index + 1}`);
    return { key: agent.key, name: agent.name, provider: OPENROUTER_PROVIDER, model };
  });
}

export function createProductionRaceCoordinator(
  input: ApiCreateRaceInput,
  context: ProductionRaceContext,
): RaceCoordinator {
  // Resolve models first so misconfiguration fails before any session exists.
  const roster = competitorRoster();
  const agents = openRouterAgents(context.fight.agents, roster);
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
    maxActions: positiveNumberEnv("COMPETITOR_MAX_ACTIONS", 20),
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
    },
  );
  return coordinator;
}
