import { resolve } from "node:path";
import {
  OpenRouterCompetitorDecisionModel,
  OpenRouterMasterPolicyModel,
  OpenRouterUsageBudget,
} from "../agents/openrouter-models.js";
import {
  MasterObstacleProvider,
  type RaceObservationSource,
} from "../agents/master-obstacle-provider.js";
import { PlaywrightCompetitorRunner } from "../agents/playwright-competitor-runner.js";
import type { ApiCreateRaceInput } from "../api/race-registry.js";
import {
  DeterministicCourseVerifier,
  HttpCourseStateGateway,
} from "../course/deterministic-course-verifier.js";
import type { DisruptionCommand } from "../domain/types.js";
import { CdpObstacleProvider } from "../infra/cdp-obstacle-provider.js";
import { SteelSessionManager } from "../infra/steel-session-manager.js";
import { JsonlRaceEventStore } from "../persistence/jsonl-event-store.js";
import { RaceCoordinator } from "./race-coordinator.js";

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

function competitorRoster(): Map<string, string> {
  const models = requiredEnv("COMPETITOR_LLM_MODELS")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  if (models.length !== 4) {
    throw new Error("COMPETITOR_LLM_MODELS must contain exactly four comma-separated models");
  }
  return new Map(models.map((model, index) => [`racer-${index + 1}`, model]));
}

export function createProductionRaceCoordinator(
  input: ApiCreateRaceInput,
): RaceCoordinator {
  const sessionManager = new SteelSessionManager();
  const roster = competitorRoster();
  const budget = new OpenRouterUsageBudget(
    positiveNumberEnv("RACE_LLM_BUDGET_USD", 0.25),
  );
  const competitorModels = new Map(
    [...roster].map(([racerId, model]) => [
      racerId,
      new OpenRouterCompetitorDecisionModel({ model, budget }),
    ]),
  );
  const agentRunner = new PlaywrightCompetitorRunner({
    task: input.task,
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

  coordinator = new RaceCoordinator({
    ...input,
    competitorModels: Object.fromEntries(roster),
  }, {
    sessionManager,
    agentRunner,
    courseVerifier,
    eventStore,
    obstacleProvider,
    llmUsage: () => budget.snapshot(),
  });
  return coordinator;
}
