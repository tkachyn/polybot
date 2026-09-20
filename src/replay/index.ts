/**
 * Replays of recorded fights. A resolved live fight leaves a dataset record
 * behind; these play one back through the real engine, market and ledger, so
 * the agents are a recording but the betting is live.
 */
export {
  MAX_RESOLVED_REPLAYS,
  ReplayAutopilot,
  startReplayAutopilot,
  type ReplayAutopilotOptions,
} from "./autopilot.js";
export {
  REPLAY_COURSE_PREFIX,
  createReplayCoordinatorFactory,
  isReplayInput,
  replayCourseId,
  sourceRaceIdOf,
  type ReplayFactoryOptions,
} from "./factory.js";
export {
  ReplayLibrary,
  isReplayable,
  type ReplayLibraryOptions,
  type ReplayRecording,
} from "./library.js";
export { ReplayObstacleProvider, recordedPolicy } from "./obstacles.js";
export { ReplayCompetitorRunner, timelineFor, type ReplayRunnerOptions } from "./runner.js";
