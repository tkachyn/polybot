import type { ObstacleProvider, Race, Racer } from "../domain/types.js";
import { RaceEngine } from "../domain/race-engine.js";
import { VirtualPredictionMarket } from "../prediction/virtual-market.js";
import type { TradeReceipt } from "../prediction/virtual-market.js";
import type {
  CompetitorAgentRunner,
  CompetitorContext,
  CourseVerifier,
  RacerSessionHandle,
  RacerSessionManager,
  RaceEventStore,
} from "./contracts.js";

export type CreateRaceInput = {
  raceId: string;
  courseId: string;
  seed: string;
  checkpointCount: number;
  targetDurationMs?: number;
  absoluteDurationMs?: number;
};

export type RaceSnapshot = {
  race: Race;
  racers: Racer[];
  sessions: Array<{
    racerId: string;
    steelSessionId: string;
    viewerUrl?: string;
  }>;
  market: {
    status: string;
    prices: Record<string, number>;
    winnerRacerId?: string;
  };
};

export class RaceCoordinator {
  readonly engine: RaceEngine;
  readonly market: VirtualPredictionMarket;

  private readonly sessions = new Map<string, RacerSessionHandle>();
  private readonly runnerTasks = new Map<string, Promise<void>>();
  private persistedEventCount = 0;
  private stopped = false;

  constructor(
    input: CreateRaceInput,
    private readonly dependencies: {
      sessionManager: RacerSessionManager;
      agentRunner: CompetitorAgentRunner;
      courseVerifier: CourseVerifier;
      eventStore: RaceEventStore;
      obstacleProvider?: ObstacleProvider;
    },
  ) {
    this.engine = new RaceEngine(
      {
        raceId: input.raceId,
        courseId: input.courseId,
        seed: input.seed,
        checkpointCount: input.checkpointCount,
      },
      {
        targetDurationMs: input.targetDurationMs,
        absoluteDurationMs: input.absoluteDurationMs,
        obstacleProvider: dependencies.obstacleProvider,
      },
    );
    this.market = new VirtualPredictionMarket([...this.engine.racers.keys()]);
  }

  async prepareAndStart(now = Date.now()): Promise<RaceSnapshot> {
    try {
      const sessions = await Promise.all(
        [...this.engine.racers.keys()].map((racerId) =>
          this.dependencies.sessionManager.create(racerId),
        ),
      );
      for (const session of sessions) {
        this.sessions.set(session.racerId, session);
      }

      await Promise.all(
        sessions.map((session) =>
          this.dependencies.agentRunner.prepare(this.baseContext(session)),
        ),
      );
      for (const session of sessions) {
        this.engine.markReady(session.racerId, now);
      }
      this.engine.start(now);
      await this.persistNewEvents();

      for (const session of sessions) {
        const context: CompetitorContext = {
          ...this.baseContext(session),
          reportCheckpoint: (checkpoint) =>
            this.recordCheckpoint(session.racerId, checkpoint),
          reportFinish: () => this.recordFinish(session.racerId),
        };
        const task = this.dependencies.agentRunner
          .run(context)
          .catch((error: unknown) => this.handleRunnerFailure(session.racerId, error));
        this.runnerTasks.set(session.racerId, task);
      }

      return this.snapshot();
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  async recordCheckpoint(
    racerId: string,
    checkpoint: number,
    now = Date.now(),
  ): Promise<void> {
    const session = this.getSession(racerId);
    const verified = await this.dependencies.courseVerifier.verifyCheckpoint({
      raceId: this.engine.race.id,
      racerId,
      courseId: this.engine.race.courseId,
      checkpoint,
      session,
    });
    if (!verified) {
      throw new Error(`Checkpoint ${checkpoint} was not verified for ${racerId}`);
    }

    await this.engine.reachCheckpoint(racerId, checkpoint, now);
    await this.synchronizeLifecycle(now);
    await this.persistNewEvents();
  }

  async recordFinish(racerId: string, now = Date.now()): Promise<void> {
    const session = this.getSession(racerId);
    const verified = await this.dependencies.courseVerifier.verifyFinish({
      raceId: this.engine.race.id,
      racerId,
      courseId: this.engine.race.courseId,
      session,
    });
    if (!verified) {
      throw new Error(`Final task state was not verified for ${racerId}`);
    }

    const won = this.engine.finishRacer(racerId, now);
    if (won) {
      this.market.freeze();
      this.market.resolve(racerId);
      await this.persistNewEvents();
      await this.stopRacers();
      await this.dependencies.sessionManager.releaseAll();
      this.stopped = true;
      return;
    }
    await this.persistNewEvents();
  }

  async tick(now = Date.now()): Promise<void> {
    this.engine.tick(now);
    await this.synchronizeLifecycle(now);
    await this.persistNewEvents();
  }

  fundSpectator(userId: string, credits: number): void {
    this.market.fund(userId, credits);
  }

  buyShares(userId: string, racerId: string, quantity: number): TradeReceipt {
    return this.market.buy(userId, racerId, quantity);
  }

  sellShares(userId: string, racerId: string, quantity: number): TradeReceipt {
    return this.market.sell(userId, racerId, quantity);
  }

  spectatorBalance(userId: string): number {
    return this.market.balance(userId);
  }

  snapshot(): RaceSnapshot {
    return {
      race: structuredClone(this.engine.race),
      racers: [...this.engine.racers.values()].map((racer) => structuredClone(racer)),
      sessions: [...this.sessions.values()].map((session) => ({
        racerId: session.racerId,
        steelSessionId: session.steelSessionId,
        viewerUrl: session.viewerUrl,
      })),
      market: {
        status: this.market.status,
        prices: this.market.pricesSnapshot(),
        winnerRacerId: this.market.winnerRacerId,
      },
    };
  }

  async events() {
    return this.dependencies.eventStore.list(this.engine.race.id);
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    await this.stopRacers();
    await this.dependencies.sessionManager.releaseAll();
    this.stopped = true;
  }

  private baseContext(
    session: RacerSessionHandle,
  ): Omit<CompetitorContext, "reportCheckpoint" | "reportFinish"> {
    return {
      raceId: this.engine.race.id,
      racerId: session.racerId,
      courseId: this.engine.race.courseId,
      seed: this.engine.race.seed,
      checkpointCount: this.engine.race.checkpointCount,
      session,
    };
  }

  private getSession(racerId: string): RacerSessionHandle {
    const session = this.sessions.get(racerId);
    if (!session) throw new Error(`No prepared session for ${racerId}`);
    return session;
  }

  private async synchronizeLifecycle(now: number): Promise<void> {
    if (this.engine.race.status === "hazards_frozen") {
      this.market.freeze();
    }
    if (this.engine.race.status === "timed_out" && !this.stopped) {
      if (this.market.status !== "resolved" && this.market.status !== "unresolved") {
        this.market.markUnresolved();
      }
      await this.persistNewEvents();
      await this.stopRacers();
      await this.dependencies.sessionManager.releaseAll();
      this.stopped = true;
    }
    void now;
  }

  private async stopRacers(): Promise<void> {
    await Promise.allSettled(
      [...this.engine.racers.keys()].map((racerId) =>
        this.dependencies.agentRunner.stop(racerId),
      ),
    );
  }

  private async handleRunnerFailure(racerId: string, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    this.engine.failRacer(racerId, reason);
    await this.persistNewEvents();
  }

  private async persistNewEvents(): Promise<void> {
    while (this.persistedEventCount < this.engine.events.length) {
      const event = this.engine.events[this.persistedEventCount];
      await this.dependencies.eventStore.append(event);
      this.persistedEventCount += 1;
    }
  }
}
