export type RaceStatus =
  | "starting"
  | "running"
  | "hazards_frozen"
  | "finishing"
  | "finished"
  | "timed_out";

export type RacerStatus =
  | "starting"
  | "ready"
  | "running"
  | "recovering"
  | "finished"
  | "failed"
  | "timed_out";

export type Race = {
  id: string;
  courseId: string;
  seed: string;
  racerCount: 4;
  checkpointCount: number;
  status: RaceStatus;
  startedAt?: number;
  targetDurationMs: number;
  absoluteDurationMs: number;
  targetDurationAt?: number;
  absoluteDeadlineAt?: number;
  winnerRacerId?: string;
  finishedAt?: number;
};

export type Racer = {
  raceId: string;
  racerId: string;
  steelSessionId?: string;
  checkpoint: number;
  status: RacerStatus;
  startedAt?: number;
  finishedAt?: number;
};

export type RaceEvent = {
  id: string;
  raceId: string;
  racerId?: string;
  type:
    | "race_created"
    | "racer_ready"
    | "race_started"
    | "checkpoint_reached"
    | "hazards_frozen"
    | "racer_finished"
    | "race_finished"
    | "race_timed_out";
  checkpoint?: number;
  occurredAt: number;
  metadata?: Record<string, unknown>;
};

export type DisruptionCommand = {
  hazardType:
    | "blocking_modal"
    | "move_primary_action"
    | "insert_decoy"
    | "temporary_disable"
    | "rename_control";
  targetRole: string;
  durationMs: number;
  intensity: number;
};

export type DisruptionResult = {
  applied: boolean;
  reason?: string;
};

export interface ObstacleProvider {
  getPolicy(raceId: string, checkpoint: number): Promise<DisruptionCommand | null>;
  apply(
    racerId: string,
    policy: DisruptionCommand,
  ): Promise<DisruptionResult>;
}
