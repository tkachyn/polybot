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
import type { CoordinatorFactory } from "../api/race-registry.js";
import { RaceCoordinator } from "../application/race-coordinator.js";
import type { DatasetStore } from "../dataset/store.js";
import { InMemoryRaceEventStore } from "../persistence/in-memory-event-store.js";
import { SimulatedSessionManager } from "../simulation/sessions.js";
import { SimulatedCourseVerifier } from "../simulation/verifier.js";
import { sourceRaceIdOf } from "./course-id.js";
import type { ReplayLibrary, ReplayRecording } from "./library.js";
import { ReplayObstacleProvider, recordedPolicy } from "./obstacles.js";
import { ReplayCompetitorRunner } from "./runner.js";

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
        // Deliberately no evaluation or dataset store. The fight behind this
        // was recorded once already; recording every replay of it again would
        // fill the training data with copies, skew the robustness matrix and
        // the leaderboard, and feed replays back into the library as source
        // recordings. The live fight still has its own stored report.
        // Stamped live: these are real models on real runs, and marking them
        // simulated would misfile them in the matrix and the dataset.
        mode: "live",
      },
    );
  };
}
