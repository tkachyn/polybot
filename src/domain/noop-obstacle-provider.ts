import type {
  DisruptionCommand,
  DisruptionResult,
  ObstacleProvider,
} from "./types.js";

/**
 * Stage 1 provider. It preserves the checkpoint lifecycle while obstacles
 * are still being designed, so the race core does not depend on CDP yet.
 */
export class NoopObstacleProvider implements ObstacleProvider {
  async getPolicy(
    _raceId: string,
    _checkpoint: number,
  ): Promise<DisruptionCommand | null> {
    return null;
  }

  async apply(
    _racerId: string,
    _policy: DisruptionCommand,
  ): Promise<DisruptionResult> {
    return { applied: false, reason: "obstacles_disabled" };
  }
}
