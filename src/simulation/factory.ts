import type { AgentIdentity } from "../api/dto.js";
import type { ApiCreateRaceInput, CoordinatorFactory } from "../api/race-registry.js";
import type { CompetitorAgentRunner } from "../application/contracts.js";
import {
  DEFAULT_AGENT_ROSTER,
  RaceCoordinator,
  type FightMetadata,
} from "../application/race-coordinator.js";
import { InMemoryRaceEventStore } from "../persistence/in-memory-event-store.js";
import {
  SIM_HISTORY_COURSE_ID,
  SIM_TEMPLATES,
  fitTemplate,
  templateForCourse,
  type SimTemplate,
} from "./catalogue.js";
import { planFight } from "./plan.js";
import { hashString } from "./rng.js";
import { InertCompetitorRunner, SimulatedCompetitorRunner } from "./runner.js";
import { SimulatedSessionManager } from "./sessions.js";
import { SimulatedCourseVerifier } from "./verifier.js";
import { SimulatedObstacleExecutor, SimulatedWorld } from "./world.js";

export type SimulationOptions = {
  /** Base RNG seed (SIM_SEED). */
  seed: string;
  /** Wall-clock speed-up: 1 is real time, 40 runs a 3-minute fight in 4.5 s. */
  timeScale: number;
};

export const SIMULATED_PROVIDER = "simulated";

/** The default roster, marked as simulated. */
export const SIM_AGENT_ROSTER: readonly AgentIdentity[] = DEFAULT_AGENT_ROSTER.map((agent) => ({
  ...agent,
  provider: SIMULATED_PROVIDER,
  model: SIMULATED_PROVIDER,
}));

export function assertTimeScale(timeScale: number): void {
  if (typeof timeScale !== "number" || !Number.isFinite(timeScale) || timeScale <= 0) {
    throw new Error("timeScale must be a positive number");
  }
}

/** The template for a fight: its `sim-<id>` course, or one chosen by seed. */
export function templateForInput(input: Pick<ApiCreateRaceInput, "courseId" | "seed">): SimTemplate {
  return templateForCourse(input.courseId) ??
    SIM_TEMPLATES[hashString(input.seed) % SIM_TEMPLATES.length];
}

function simulatedFight(fight: FightMetadata): FightMetadata {
  return {
    ...fight,
    agents: fight.agents.map((agent) => ({
      ...agent,
      provider: SIMULATED_PROVIDER,
      model: SIMULATED_PROVIDER,
    })),
  };
}

/**
 * Builds real RaceCoordinators whose browser sessions, competitors, course
 * verifier and obstacle executor are simulated. Sabotage arms on the real
 * engine plan and fires through the engine; money moves through the shared
 * ledger.
 */
export function createSimulatedCoordinatorFactory(options: SimulationOptions): CoordinatorFactory {
  assertTimeScale(options.timeScale);
  return (input, context) => {
    const fight = simulatedFight(context.fight);
    const fightSeed = `${options.seed}/${input.seed}`;
    const world = new SimulatedWorld(options.timeScale);
    const obstacleProvider = input.obstaclesEnabled
      ? new SimulatedObstacleExecutor(world, fightSeed)
      : undefined;

    let agentRunner: CompetitorAgentRunner;
    if (input.courseId === SIM_HISTORY_COURSE_ID) {
      agentRunner = new InertCompetitorRunner();
    } else {
      const template = fitTemplate(templateForInput(input), fight.checkpointLabels);
      const racerIds = fight.agents.map((_, index) => `racer-${index + 1}`);
      const agents = Object.fromEntries(
        racerIds.map((racerId, index) => [racerId, fight.agents[index]]),
      );
      agentRunner = new SimulatedCompetitorRunner({
        template,
        world,
        plan: planFight(
          fightSeed,
          racerIds.map((racerId, index) => ({ racerId, key: fight.agents[index].key })),
          template.stages.length,
        ),
        agents,
        timeScale: options.timeScale,
        seed: fightSeed,
      });
    }

    return new RaceCoordinator(
      { ...input, fight },
      {
        sessionManager: new SimulatedSessionManager(input.raceId),
        agentRunner,
        courseVerifier: new SimulatedCourseVerifier(),
        eventStore: new InMemoryRaceEventStore(),
        obstacleProvider,
        ledger: context.ledger,
        // Final evaluations land in the registry's store, labelled as
        // scripted agents rather than real models.
        evaluationStore: context.evaluationStore,
        // Each closed fight's training record goes to the registry's dataset store.
        datasetStore: context.datasetStore,
        mode: "simulated",
      },
    );
  };
}
