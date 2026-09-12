export type RaceStatus =
  | "starting"
  | "running"
  | "hazards_frozen"
  | "finishing"
  | "finished"
  | "timed_out";

export type SabotageTier = "basic" | "intermediate" | "difficult";

export type SabotageTrigger = {
  kind: "target_opened";
  /** 1-based checkpoint whose verified report fires the sabotage. Default 1. */
  checkpoint: number;
  milestone: "first_verified_checkpoint";
};

export type SabotageStep = {
  stepId: string;
  checkpoint: number;
  tier: SabotageTier;
  policy: DisruptionCommand;
  selectedAt: number;
};

export type SabotagePlan = {
  raceId: string;
  tier: SabotageTier;
  trigger: SabotageTrigger;
  policy: DisruptionCommand;
  selectedAt: number;
  /** "operator" when the fight supplied a fixed policy. */
  source: "model" | "fallback" | "operator";
  /** Ordered steps selected for this race. Omitted for legacy single-step plans. */
  steps?: readonly SabotageStep[];
};

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
  sabotagePlan?: SabotagePlan;
  sabotageSteps?: readonly SabotageStep[];
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
  /** Legacy recovery deadline; persistent sabotage now ends only manually. */
  recoverAt?: number;
  /** Number of ordered sabotage steps already claimed by this racer. */
  sabotageStep: number;
};

/** Why a racer left `recovering` (sabotage_recovered metadata.cause). */
export type RecoveryCause = "duration" | "manual";

export type RaceEvent = {
  id: string;
  raceId: string;
  racerId?: string;
  type:
    | "race_created"
    | "racer_ready"
    | "race_started"
    | "sabotage_armed"
    | "checkpoint_reached"
    | "sabotage_triggered"
    | "sabotage_applied"
    | "sabotage_misfired"
    | "sabotage_recovered"
    | "hazards_frozen"
    | "racer_finished"
    | "racer_failed"
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
  /** Optional stable id supplied by a policy model. */
  disruptionId?: string;
};

export type DisruptionResult = {
  applied: boolean;
  reason?: string;
};

export interface ObstacleProvider {
  armRace?(input: {
    raceId: string;
    courseId: string;
    seed: string;
    checkpointCount: number;
    trigger: SabotageTrigger;
  }): Promise<SabotagePlan | null>;
  getPolicy(raceId: string, checkpoint: number): Promise<DisruptionCommand | null>;
  apply(
    racerId: string,
    policy: DisruptionCommand,
  ): Promise<DisruptionResult>;
}
