/**
 * RACE_MODE=simulated: seeded stand-ins for browser sessions, competitor
 * agents, the course verifier and the obstacle executor, driving the real
 * RaceCoordinator, engine, market, ledger and telemetry.
 */
export {
  SIM_AGENT_ROSTER,
  SIMULATED_PROVIDER,
  createSimulatedCoordinatorFactory,
  templateForInput,
  type SimulationOptions,
} from "./factory.js";
export {
  BOT_COUNT,
  MAX_RESOLVED_FIGHTS,
  SIM_ABSOLUTE_DURATION_MS,
  SIM_TARGET_DURATION_MS,
  SimulationAutopilot,
  startSimulationAutopilot,
  type SimulationAutopilotOptions,
} from "./autopilot.js";
export {
  SIM_HISTORY_COURSE_ID,
  SIM_TEMPLATES,
  courseIdFor,
  fitTemplate,
  templateById,
  templateForCourse,
  type SimPage,
  type SimStage,
  type SimTemplate,
} from "./catalogue.js";
export { renderSimFrame, AGENT_COLORS, type SimFrameInput } from "./frames.js";
export { planFight, planTimeline, type FightPlan, type RacerPlan } from "./plan.js";
export { Rng, hashString, mulberry32 } from "./rng.js";
export { InertCompetitorRunner, SimulatedCompetitorRunner } from "./runner.js";
export {
  SimRacerScript,
  chooseResponse,
  runScriptOffline,
  scriptHistoryRuns,
  targetForAction,
  type HazardResponse,
  type OfflineRun,
  type ScriptEvent,
  type ScriptHazard,
  type ScriptSabotageStep,
  type ScriptStep,
} from "./script.js";
export { SimulatedSessionManager } from "./sessions.js";
export { SimulatedCourseVerifier } from "./verifier.js";
export { SimulatedObstacleExecutor, SimulatedWorld } from "./world.js";
