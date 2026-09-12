import type {
  DisruptionCommand,
  DisruptionResult,
  ObstacleProvider,
  RacerStatus,
} from "../domain/types.js";
import { validateDisruptionCommand } from "../infra/cdp-obstacle-provider.js";

export type MasterRaceObservation = {
  raceId: string;
  checkpoint: number;
  racers: Array<{
    racerId: string;
    checkpoint: number;
    status: RacerStatus;
    url?: string;
    lastAction?: string;
  }>;
};

export interface RaceObservationSource {
  observe(raceId: string, checkpoint: number): Promise<MasterRaceObservation>;
}

export interface MasterPolicyModel {
  selectObstacle(input: {
    observation: MasterRaceObservation;
    allowedHazards: DisruptionCommand["hazardType"][];
  }): Promise<DisruptionCommand>;
}

export class MasterObstacleProvider implements ObstacleProvider {
  private readonly timeoutMs: number;

  constructor(
    private readonly model: MasterPolicyModel,
    private readonly observations: RaceObservationSource,
    private readonly executor: Pick<ObstacleProvider, "apply">,
    private readonly fallbackPolicies: Record<number, DisruptionCommand> = {},
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 2_500;
  }

  async getPolicy(
    raceId: string,
    checkpoint: number,
  ): Promise<DisruptionCommand | null> {
    const fallback = this.fallbackPolicies[checkpoint] ?? null;
    try {
      const observation = await this.observations.observe(raceId, checkpoint);
      const policy = await this.withTimeout(
        this.model.selectObstacle({
          observation,
          allowedHazards: [
            "blocking_modal",
            "move_primary_action",
            "insert_decoy",
            "temporary_disable",
            "rename_control",
          ],
        }),
      );
      validateDisruptionCommand(policy);
      return policy;
    } catch {
      return fallback;
    }
  }

  async apply(
    racerId: string,
    policy: DisruptionCommand,
  ): Promise<DisruptionResult> {
    return this.executor.apply(racerId, policy);
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("master policy selection timed out")),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
