/**
 * Builds a coordinator that replays a recorded fight.
 *
 * A replay fight is created like any other, and its course id names the
 * recording behind it (`replay:<raceId>`). Sessions and the course verifier
 * are the simulation's stand-ins: there is no browser to open and no course
 * to ask, because the run already happened and its progress is known. The
 * engine, market, ledger, evaluation and dataset are the real ones, so a
 * replayed fight settles bets exactly as a live one does.
 */
import type { ApiCreateRaceInput, CoordinatorFactory } from "../api/race-registry.js";
import { RaceCoordinator } from "../application/race-coordinator.js";
import type { DatasetStore } from "../dataset/store.js";
import { InMemoryRaceEventStore } from "../persistence/in-memory-event-store.js";
import { SimulatedSessionManager } from "../simulation/sessions.js";
import { SimulatedCourseVerifier } from "../simulation/verifier.js";
import type { ReplayLibrary, ReplayRecording } from "./library.js";
import { ReplayObstacleProvider, recordedPolicy } from "./obstacles.js";
import { ReplayCompetitorRunner } from "./runner.js";

/** Course id prefix that marks a fight as a replay of a recorded one. */
export const REPLAY_COURSE_PREFIX = "replay:";

/** The course id a replay of `sourceRaceId` runs under. */
export function replayCourseId(sourceRaceId: string): string {
  return `${REPLAY_COURSE_PREFIX}${sourceRaceId}`;
}

/** The recorded fight a replay course id names, or null for any other course. */
export function sourceRaceIdOf(courseId: string): string | null {
  return courseId.startsWith(REPLAY_COURSE_PREFIX)
    ? courseId.slice(REPLAY_COURSE_PREFIX.length)
    : null;
}

/** True for an input that should be replayed rather than run for real. */
export function isReplayInput(input: Pick<ApiCreateRaceInput, "courseId">): boolean {
  return sourceRaceIdOf(input.courseId) !== null;
}

export type ReplayFactoryOptions = {
  library: ReplayLibrary;
  /** Reads the recorded screenshots. */
  store: DatasetStore;
  /** 1 is the original pace. Default 1. */
  timeScale?: number;
};

/**
 * A factory for replay fights only. Wrap it around the production factory so
 * everything else still runs for real (see src/server.ts).
 */
export function createReplayCoordinatorFactory(options: ReplayFactoryOptions): CoordinatorFactory {
  return (input, context) => {
    const sourceRaceId = sourceRaceIdOf(input.courseId);
    if (sourceRaceId === null) {
      throw new Error(`${input.courseId} is not a replay course`);
    }
    const recording: ReplayRecording | null = options.library.find(sourceRaceId);
    if (!recording) {
      throw new Error(`No recording loaded for ${sourceRaceId}`);
    }

    return new RaceCoordinator(
      { ...input, fight: context.fight },
      {
        sessionManager: new SimulatedSessionManager(input.raceId),
        agentRunner: new ReplayCompetitorRunner({
          recording,
          store: options.store,
          timeScale: options.timeScale,
        }),
        // The run already happened: its progress is the recording's, not a
        // course's to re-verify.
        courseVerifier: new SimulatedCourseVerifier(),
        // Without a provider the coordinator drops the sabotage brief, and the
        // replay would show a fight that was never sabotaged.
        obstacleProvider: new ReplayObstacleProvider(recordedPolicy(recording)),
        eventStore: new InMemoryRaceEventStore(),
        ledger: context.ledger,
        evaluationStore: context.evaluationStore,
        datasetStore: context.datasetStore,
        // Stamped live: these are real models on real runs, and marking them
        // simulated would misfile them in the matrix and the dataset.
        mode: "live",
      },
    );
  };
}
