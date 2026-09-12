import type {
  CompetitorAgentRunner,
  CourseVerifier,
  RacerSessionManager,
} from "../src/application/contracts.js";
import { RaceCoordinator } from "../src/application/race-coordinator.js";
import type { ApiCreateRaceInput, CoordinatorFactory } from "../src/api/race-registry.js";
import type {
  DisruptionCommand,
  DisruptionResult,
  ObstacleProvider,
} from "../src/domain/types.js";
import { InMemoryRaceEventStore } from "../src/persistence/in-memory-event-store.js";

export const policy: DisruptionCommand = {
  hazardType: "blocking_modal",
  targetRole: "primary-action",
  durationMs: 4_000,
  intensity: 2,
};

export class FakeObstacles implements ObstacleProvider {
  async getPolicy(): Promise<DisruptionCommand | null> {
    return policy;
  }

  async apply(): Promise<DisruptionResult> {
    return { applied: true };
  }
}

/**
 * A coordinator factory over in-memory fakes. Obstacles are enabled when the
 * input asks for them. Races listed in `failRaceIds` fail during prepare.
 */
export function createFactory(options: { failRaceIds?: Set<string> } = {}) {
  const prepareCalls: string[] = [];
  const sessionManager: RacerSessionManager = {
    async create(racerId) {
      return { racerId, steelSessionId: `steel-${racerId}` };
    },
    async release() {},
    async releaseAll() {},
  };
  const agentRunner: CompetitorAgentRunner = {
    async prepare(context) {
      prepareCalls.push(`${context.raceId}:${context.racerId}`);
      if (options.failRaceIds?.has(context.raceId)) throw new Error("browser session failed");
    },
    run() {
      return new Promise<void>(() => undefined);
    },
    async stop() {},
  };
  const courseVerifier: CourseVerifier = {
    async verifyCheckpoint() {
      return true;
    },
    async verifyFinish() {
      return true;
    },
  };
  const factory: CoordinatorFactory = (input, context) =>
    new RaceCoordinator({ ...input, fight: context.fight }, {
      sessionManager,
      agentRunner,
      courseVerifier,
      eventStore: new InMemoryRaceEventStore(),
      obstacleProvider: input.obstaclesEnabled ? new FakeObstacles() : undefined,
      ledger: context.ledger,
    });
  return { factory, prepareCalls };
}

export function raceInput(
  raceId: string,
  overrides: Partial<ApiCreateRaceInput> = {},
): ApiCreateRaceInput {
  return {
    raceId,
    courseId: "course-1",
    seed: "seed-1",
    checkpointCount: 3,
    task: "Buy the blue mug and check out",
    startUrl: "https://course.test/start",
    ...overrides,
  };
}

/** Clears every checkpoint for `racerId`, then finishes, all at `at`. */
export async function winRace(race: RaceCoordinator, racerId: string, at: number): Promise<void> {
  const count = race.engine.race.checkpointCount;
  for (let checkpoint = race.engine.racers.get(racerId)!.checkpoint + 1; checkpoint <= count; checkpoint += 1) {
    await race.recordCheckpoint(racerId, checkpoint, at);
  }
  await race.recordFinish(racerId, at);
}
