import { HAZARD_TYPES } from "../domain/sabotage.js";
import type {
  DisruptionCommand,
  DisruptionResult,
  ObstacleProvider,
} from "../domain/types.js";
import { Rng } from "./rng.js";

export type Disruption = {
  policy: DisruptionCommand;
  appliedAt: number;
  /** Scaled wall-clock time at which the disruption stops affecting the agent. */
  until: number;
};

/**
 * Shared state of one simulated fight's "web pages": which racers currently
 * suffer an injected disruption. The obstacle executor writes it; the
 * competitor runner reads it.
 */
export class SimulatedWorld {
  private readonly disruptions = new Map<string, Disruption>();

  constructor(
    readonly timeScale: number,
    private readonly clock: () => number = Date.now,
  ) {
    if (!Number.isFinite(timeScale) || timeScale <= 0) {
      throw new Error("timeScale must be a positive number");
    }
  }

  now(): number {
    return this.clock();
  }

  disrupt(racerId: string, policy: DisruptionCommand): Disruption {
    const appliedAt = this.clock();
    const disruption: Disruption = {
      policy: { ...policy },
      appliedAt,
      until: appliedAt + policy.durationMs / this.timeScale,
    };
    this.disruptions.set(racerId, disruption);
    return { ...disruption, policy: { ...disruption.policy } };
  }

  /** The racer's active disruption, or null once it has elapsed. */
  disruption(racerId: string): Disruption | null {
    const disruption = this.disruptions.get(racerId);
    if (!disruption) return null;
    if (this.clock() >= disruption.until) {
      this.disruptions.delete(racerId);
      return null;
    }
    return { ...disruption, policy: { ...disruption.policy } };
  }

  clear(racerId: string): void {
    this.disruptions.delete(racerId);
  }
}

/**
 * Obstacle executor for simulated fights. `apply` flags the racer as disrupted
 * for durationMs / timeScale and always succeeds. `getPolicy` supplies a seeded
 * policy for fights whose sabotage plan has no fixed policy.
 */
export class SimulatedObstacleExecutor implements ObstacleProvider {
  private readonly rng: Rng;

  constructor(
    private readonly world: SimulatedWorld,
    seed: string,
  ) {
    this.rng = new Rng(`${seed}/obstacles`);
  }

  async getPolicy(_raceId: string, _checkpoint: number): Promise<DisruptionCommand | null> {
    return {
      hazardType: this.rng.pick(HAZARD_TYPES),
      targetRole: "primary-action",
      durationMs: this.rng.int(6, 14) * 1_000,
      intensity: this.rng.int(1, 3),
    };
  }

  async apply(racerId: string, policy: DisruptionCommand): Promise<DisruptionResult> {
    this.world.disrupt(racerId, policy);
    return { applied: true };
  }
}
