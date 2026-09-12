import { NoopObstacleProvider } from "./noop-obstacle-provider.js";
import type {
  ObstacleProvider,
  Race,
  RaceEvent,
  Racer,
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
  private readonly stagePolicies = new Map<number, Awaited<ReturnType<ObstacleProvider["getPolicy"]>>>();

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
          } satisfies Racer,
        ];
      }),
    );

    this.emit({ type: "race_created", occurredAt: input.now ?? Date.now() });
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

    if (this.race.status === "finished" || this.race.status === "timed_out") {
      return { claimed: false, obstacleApplied: false };
    }
    const claimKey = `${racerId}:${checkpoint}`;
    if (this.claimedCheckpoints.has(claimKey)) {
      return { claimed: false, obstacleApplied: false };
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

    if (this.race.status === "hazards_frozen") {
      return { claimed: true, obstacleApplied: false };
    }

    let policy = this.stagePolicies.get(checkpoint);
    if (policy === undefined) {
      policy = await this.obstacleProvider.getPolicy(this.race.id, checkpoint);
      this.stagePolicies.set(checkpoint, policy);
    }
    if (!policy) {
      return { claimed: true, obstacleApplied: false };
    }

    const result = await this.obstacleProvider.apply(racerId, policy);
    racer.status = result.applied ? "recovering" : "running";
    return { claimed: true, obstacleApplied: result.applied };
  }

  markRecovered(racerId: string): void {
    const racer = this.getRacer(racerId);
    if (racer.status === "recovering") {
      racer.status = "running";
    }
  }

  finishRacer(racerId: string, now = Date.now()): boolean {
    const racer = this.getRacer(racerId);
    this.tick(now);

    if (this.race.status === "finished" || this.race.status === "timed_out") {
      return false;
    }
    if (racer.checkpoint !== this.race.checkpointCount) {
      throw new Error(`${racerId} has not completed the final checkpoint`);
    }
    if (racer.status === "finished") {
      return false;
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
    if (!this.race.startedAt || !this.race.targetDurationAt || !this.race.absoluteDeadlineAt) {
      return;
    }

    if (
      this.race.status === "running" &&
      now >= this.race.targetDurationAt
    ) {
      this.race.status = "hazards_frozen";
      this.emit({ type: "hazards_frozen", occurredAt: now });
    }

    if (
      now >= this.race.absoluteDeadlineAt &&
      this.race.status !== "finished" &&
      this.race.status !== "timed_out"
    ) {
      this.race.status = "timed_out";
      for (const racer of this.racers.values()) {
        if (racer.status !== "finished") {
          racer.status = "timed_out";
        }
      }
      this.emit({ type: "race_timed_out", occurredAt: now });
    }
  }

  private getRacer(racerId: string): Racer {
    const racer = this.racers.get(racerId);
    if (!racer) {
      throw new Error(`Unknown racer: ${racerId}`);
    }
    return racer;
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
