import { resolve } from "node:path";
import {
  AnthropicCompetitorDecisionModel,
  AnthropicMasterPolicyModel,
} from "../agents/anthropic-models.js";
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

export function createProductionRaceCoordinator(
  input: ApiCreateRaceInput,
): RaceCoordinator {
  const sessionManager = new SteelSessionManager();
  const competitorModel = new AnthropicCompetitorDecisionModel({
    model: requiredEnv("COMPETITOR_LLM_MODEL"),
  });
  const agentRunner = new PlaywrightCompetitorRunner({
    task: input.task,
    startUrl: input.startUrl,
    model: competitorModel,
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
        new AnthropicMasterPolicyModel({ model: requiredEnv("MASTER_LLM_MODEL") }),
        observationSource,
        cdpExecutor,
        fallbackPolicies,
      )
    : undefined;

  coordinator = new RaceCoordinator(input, {
    sessionManager,
    agentRunner,
    courseVerifier,
    eventStore,
    obstacleProvider,
  });
  return coordinator;
}
