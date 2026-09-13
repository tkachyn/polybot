import { NoopObstacleProvider } from "./noop-obstacle-provider.js";
import type {
  ObstacleProvider,
  Race,
  RaceEvent,
  Racer,
  RecoveryCause,
  SabotagePlan,
  SabotageStep,
} from "./types.js";

export type RaceEngineOptions = {
  targetDurationMs?: number;
  absoluteDurationMs?: number;
  obstacleProvider?: ObstacleProvider;
  idFactory?: () => string;
};

export class RaceEngine {
  readonly race: Race;
  readonly racers: Map<string, Racer>;
  readonly events: RaceEvent[] = [];

  private readonly obstacleProvider: ObstacleProvider;
  private readonly idFactory: () => string;
  private readonly claimedCheckpoints = new Set<string>();
  private readonly claimedSabotage = new Set<string>();

  constructor(
    input: {
      raceId: string;
      courseId: string;
      seed: string;
      checkpointCount: number;
      now?: number;
    },
    options: RaceEngineOptions = {},
  ) {
    if (input.checkpointCount < 1) {
      throw new Error("checkpointCount must be at least 1");
    }

    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.obstacleProvider = options.obstacleProvider ?? new NoopObstacleProvider();
    this.race = {
      id: input.raceId,
      courseId: input.courseId,
      seed: input.seed,
      racerCount: 4,
      checkpointCount: input.checkpointCount,
      status: "starting",
      targetDurationMs: options.targetDurationMs ?? 180_000,
      absoluteDurationMs: options.absoluteDurationMs ?? 300_000,
    };
    this.racers = new Map(
      Array.from({ length: 4 }, (_, index) => {
        const racerId = `racer-${index + 1}`;
        return [
          racerId,
          {
            raceId: input.raceId,
            racerId,
            checkpoint: 0,
            status: "starting",
            sabotageStep: 0,
          } satisfies Racer,
        ];
      }),
    );

    this.emit({ type: "race_created", occurredAt: input.now ?? Date.now() });
  }

  armSabotage(plan: SabotagePlan, now = Date.now()): void {
    if (this.race.status !== "starting") {
      throw new Error("Sabotage can only be armed before the race starts");
    }
    if (plan.raceId !== this.race.id) {
      throw new Error("Sabotage plan belongs to a different race");
    }
    const steps = normalizeSabotageSteps(plan);
    for (const step of steps) {
      if (
        !Number.isInteger(step.checkpoint) ||
        step.checkpoint < 1 ||
        step.checkpoint > this.race.checkpointCount
      ) {
        throw new Error("Sabotage trigger checkpoint is outside the course");
      }
    }
    if (this.race.sabotagePlan) {
      if (JSON.stringify(this.race.sabotagePlan) !== JSON.stringify(plan)) {
        throw new Error("Race sabotage plan is immutable");
      }
      return;
    }
    const immutablePlan = Object.freeze({
      ...plan,
      trigger: Object.freeze({ ...plan.trigger }),
      policy: Object.freeze({ ...plan.policy }),
      ...(plan.steps
        ? {
            steps: Object.freeze(steps.map((step) => Object.freeze({
              ...step,
              policy: Object.freeze({ ...step.policy }),
            }))),
          }
        : {}),
    }) as SabotagePlan;
    this.race.sabotagePlan = immutablePlan;
    this.race.sabotageSteps = immutablePlan.steps;
    this.emit({
      type: "sabotage_armed",
      occurredAt: now,
      metadata: {
        tier: immutablePlan.tier,
        trigger: immutablePlan.trigger,
        policy: immutablePlan.policy,
        source: immutablePlan.source,
      },
    });
  }

  markReady(racerId: string, now = Date.now()): void {
    const racer = this.getRacer(racerId);
    if (this.race.status !== "starting") {
      throw new Error("Racers can only become ready before the race starts");
    }
    if (racer.status !== "starting") {
      return;
    }

    racer.status = "ready";
    this.emit({ type: "racer_ready", racerId, occurredAt: now });
  }

  start(now = Date.now()): void {
    if (this.race.status !== "starting") {
      throw new Error("Race has already started or finished");
    }
    if ([...this.racers.values()].some((racer) => racer.status !== "ready")) {
      throw new Error("All four racers must be ready before starting");
    }

    this.race.status = "running";
    this.race.startedAt = now;
    this.race.targetDurationAt = now + this.race.targetDurationMs;
    this.race.absoluteDeadlineAt = now + this.race.absoluteDurationMs;
    for (const racer of this.racers.values()) {
      racer.status = "running";
      racer.startedAt = now;
    }
    this.emit({ type: "race_started", occurredAt: now });
  }

  async reachCheckpoint(
    racerId: string,
    checkpoint: number,
    now = Date.now(),
  ): Promise<{ claimed: boolean; obstacleApplied: boolean }> {
    const racer = this.getRacer(racerId);
    this.tick(now);

    if (this.isOver()) {
      return { claimed: false, obstacleApplied: false };
    }
    if (this.race.status === "starting") {
      throw new Error("Race has not started");
    }
    const claimKey = `${racerId}:${checkpoint}`;
    if (this.claimedCheckpoints.has(claimKey)) {
      return { claimed: false, obstacleApplied: false };
    }
    if (racer.status !== "running") {
      throw new Error(`${racerId} cannot reach a checkpoint while ${racer.status}`);
    }

    if (checkpoint !== racer.checkpoint + 1) {
      throw new Error(
        `${racerId} must reach checkpoint ${racer.checkpoint + 1} next`,
      );
    }
    if (checkpoint > this.race.checkpointCount) {
      throw new Error("checkpoint exceeds course length");
    }

    this.claimedCheckpoints.add(claimKey);
    racer.checkpoint = checkpoint;
    this.emit({
      type: "checkpoint_reached",
      racerId,
      checkpoint,
      occurredAt: now,
    });

    const plan = this.race.sabotagePlan;
    const step = plan ? this.sabotageSteps()[racer.sabotageStep] : undefined;
    if (
      !plan ||
      !step ||
      checkpoint !== step.checkpoint ||
      this.race.status === "hazards_frozen" ||
      this.claimedSabotage.has(`${racerId}:${step.stepId}`)
    ) {
      return { claimed: true, obstacleApplied: false };
    }

    this.claimedSabotage.add(`${racerId}:${step.stepId}`);
    racer.sabotageStep += 1;
    const sequenced = Boolean(plan.steps);
    const disruptionId = `disruption-${this.race.id}-${racerId}-${racer.sabotageStep}-${step.stepId}`;
    const appliedPolicy = sequenced
      ? { ...step.policy, disruptionId }
      : step.policy;
    this.emit({
      type: "sabotage_triggered",
      racerId,
      checkpoint,
      occurredAt: now,
      metadata: {
        tier: step.tier,
        trigger: sequenced ? { ...plan.trigger, checkpoint: step.checkpoint } : plan.trigger,
        ...(sequenced ? { stepId: step.stepId, step: racer.sabotageStep } : {}),
      },
    });

    let result;
    try {
      result = await this.obstacleProvider.apply(racerId, appliedPolicy);
    } catch (error) {
      this.emit({
        type: "sabotage_misfired",
        racerId,
        checkpoint,
        occurredAt: now,
        metadata: {
          tier: step.tier,
          ...(sequenced ? { stepId: step.stepId } : {}),
          reason: error instanceof Error ? error.message : String(error),
        },
      });
      return { claimed: true, obstacleApplied: false };
    }
    // The race may have ended, or the racer failed, while the sabotage was
    // being applied; only a still-running racer enters persistent recovery.
    if (result.applied && !this.isOver() && racer.status === "running") {
      racer.status = "recovering";
      this.emit({
        type: "sabotage_applied",
        racerId,
        checkpoint,
        occurredAt: now,
        metadata: {
          tier: step.tier,
          policy: result.policy ?? appliedPolicy,
          ...(sequenced ? { stepId: step.stepId, step: racer.sabotageStep } : {}),
        },
      });
      return { claimed: true, obstacleApplied: true };
    }
    this.emit({
      type: "sabotage_misfired",
      racerId,
      checkpoint,
      occurredAt: now,
      metadata: {
        tier: step.tier,
        ...(sequenced ? { stepId: step.stepId } : {}),
        reason: result.applied ? "racer_not_running" : result.reason ?? "not_applied",
      },
    });
    return { claimed: true, obstacleApplied: false };
  }

  /** Ends a racer's persistent recovery. Emits only when the status changes. */
  markRecovered(racerId: string, now = Date.now(), cause: RecoveryCause = "manual"): void {
    const racer = this.getRacer(racerId);
    if (racer.status !== "recovering" || this.isOver()) {
      return;
    }
    racer.status = "running";
    racer.recoverAt = undefined;
    const step = this.sabotageSteps()[Math.max(0, racer.sabotageStep - 1)];
    this.emit({
      type: "sabotage_recovered",
      racerId,
      occurredAt: now,
      metadata: {
        checkpoint: racer.checkpoint,
        cause,
        ...(this.race.sabotagePlan?.steps && step
          ? { stepId: step.stepId, step: racer.sabotageStep }
          : {}),
      },
    });
  }

  failRacer(racerId: string, reason: string, now = Date.now()): void {
    const racer = this.getRacer(racerId);
    if (racer.status === "finished" || racer.status === "failed" || racer.status === "timed_out") {
      return;
    }
    racer.status = "failed";
    racer.recoverAt = undefined;
    this.emit({
      type: "racer_failed",
      racerId,
      occurredAt: now,
      metadata: { reason },
    });
  }

  finishRacer(racerId: string, now = Date.now()): boolean {
    const racer = this.getRacer(racerId);
    this.tick(now);

    if (this.isOver()) {
      return false;
    }
    if (racer.checkpoint !== this.race.checkpointCount) {
      throw new Error(`${racerId} has not completed the final checkpoint`);
    }
    if (racer.status === "finished") {
      return false;
    }
    if (racer.status !== "running") {
      throw new Error(`${racerId} cannot finish while ${racer.status}`);
    }

    racer.status = "finished";
    racer.finishedAt = now;
    this.emit({ type: "racer_finished", racerId, occurredAt: now });

    if (!this.race.winnerRacerId) {
      this.race.winnerRacerId = racerId;
      this.race.finishedAt = now;
      this.race.status = "finishing";
      this.emit({
        type: "race_finished",
        racerId,
        occurredAt: now,
        metadata: { winner: true },
      });
      this.race.status = "finished";
      return true;
    }

    return false;
  }

  tick(now = Date.now()): void {
    if (
      this.race.startedAt === undefined ||
      this.race.targetDurationAt === undefined ||
      this.race.absoluteDeadlineAt === undefined
    ) {
      return;
    }

    if (
      this.race.status === "running" &&
      now >= this.race.targetDurationAt
    ) {
      this.race.status = "hazards_frozen";
      this.emit({ type: "hazards_frozen", occurredAt: now });
    }

    if (now >= this.race.absoluteDeadlineAt && !this.isOver()) {
      this.timeOut(now, "absolute_deadline");
    }
  }

  /**
   * Ends a race that has not finished, e.g. because start-up failed. Every
   * unfinished racer is timed out and `race_timed_out` carries the reason.
   */
  abort(reason: string, now = Date.now()): boolean {
    if (this.isOver()) {
      return false;
    }
    this.timeOut(now, reason);
    return true;
  }

  private timeOut(now: number, reason: string): void {
    this.race.status = "timed_out";
    for (const racer of this.racers.values()) {
      if (racer.status !== "finished") {
        racer.status = "timed_out";
        racer.recoverAt = undefined;
      }
    }
    this.emit({ type: "race_timed_out", occurredAt: now, metadata: { reason } });
  }

  private isOver(): boolean {
    return this.race.status === "finished" || this.race.status === "timed_out";
  }

  private getRacer(racerId: string): Racer {
    const racer = this.racers.get(racerId);
    if (!racer) {
      throw new Error(`Unknown racer: ${racerId}`);
    }
    return racer;
  }

  private sabotageSteps(): readonly SabotageStep[] {
    return this.race.sabotageSteps ??
      (this.race.sabotagePlan ? normalizeSabotageSteps(this.race.sabotagePlan) : []);
  }

  private emit(
    event: Omit<RaceEvent, "id" | "raceId">,
  ): void {
    this.events.push({
      id: this.idFactory(),
      raceId: this.race.id,
      ...event,
    });
  }
}

function normalizeSabotageSteps(plan: SabotagePlan): SabotageStep[] {
  if (plan.steps && plan.steps.length > 0) {
    return plan.steps.map((step, index) => ({
      ...step,
      stepId: step.stepId || `step-${index + 1}`,
    }));
  }
  return [{
    stepId: "legacy-step-1",
    checkpoint: plan.trigger.checkpoint,
    tier: plan.tier,
    policy: plan.policy,
    selectedAt: plan.selectedAt,
  }];
}
