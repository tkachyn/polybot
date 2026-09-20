/**
 * The sabotage a replayed fight had the first time it ran.
 *
 * A replay has no page to break, but the fight still needs its sabotage to
 * exist: the coordinator drops the brief entirely when no obstacle provider is
 * wired (see RaceCoordinator's constructor), and without it the strip, the hit
 * markers and the recovering states never appear. This supplies the recorded
 * hazard and reports it applied, so the engine runs the same
 * armed → fired → recovered lifecycle it ran live.
 */
import type {
  DisruptionCommand,
  DisruptionResult,
  ObstacleProvider,
} from "../domain/types.js";
import type { ReplayRecording } from "./library.js";

/** Matches the live default; a replay never waits for a hazard to lapse. */
const DEFAULT_DURATION_MS = 8_000;
const DEFAULT_INTENSITY = 2;

/** The hazard a recording's first sabotage step used, if it had one. */
export function recordedPolicy(recording: ReplayRecording): DisruptionCommand | null {
  const step = recording.evaluation.sabotageSteps[0];
  if (!step) return null;
  // The reaction carries the role the hazard actually aimed at; the step only
  // names the hazard, so fall back to the primary action.
  const reaction = recording.evaluation.agents
    .flatMap((agent) => agent.sabotage)
    .find((hit) => hit.stepId === step.stepId);
  return {
    hazardType: step.hazardType,
    targetRole: "primary-action",
    durationMs: DEFAULT_DURATION_MS,
    intensity: DEFAULT_INTENSITY,
    ...(reaction ? { disruptionId: reaction.stepId } : {}),
  };
}

/** Reports the recorded hazard; there is no browser to apply it to. */
export class ReplayObstacleProvider implements ObstacleProvider {
  constructor(private readonly policy: DisruptionCommand | null) {}

  async getPolicy(): Promise<DisruptionCommand | null> {
    return this.policy ? { ...this.policy } : null;
  }

  async apply(_racerId: string, _policy: DisruptionCommand): Promise<DisruptionResult> {
    return { applied: true };
  }
}
