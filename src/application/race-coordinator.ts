import type {
  OrderReceipt,
  OrderRequest,
  PricePoint,
  RunStatus,
  SabotageState,
} from "../api/dto.js";
import { DomainError } from "../domain/errors.js";
import { RaceEngine } from "../domain/race-engine.js";
import {
  DEFAULT_SABOTAGE_CHECKPOINT,
  describeHazard,
  describeHazardDetail,
  hazardLabel,
  sabotagePlaceholder,
  tierForPolicy,
} from "../domain/sabotage.js";
import type {
  DisruptionCommand,
  ObstacleProvider,
  Race,
  RaceEvent,
  Racer,
  SabotagePlan,
  SabotageTier,
  SabotageTrigger,
} from "../domain/types.js";
import { validateDisruptionCommand } from "../infra/cdp-obstacle-provider.js";
import { VirtualPredictionMarket } from "../prediction/virtual-market.js";
import type { TradeReceipt } from "../prediction/virtual-market.js";
import type { CreditLedger } from "../wallet/credit-ledger.js";
import type {
  AgentActionReport,
  CapturedFrame,
  CompetitorAgentRunner,
  CompetitorContext,
  CourseVerifier,
  RacerSessionHandle,
  RacerSessionManager,
  RaceEventStore,
} from "./contracts.js";
import {
  defaultCheckpointLabel,
  normalizeFightMetadata,
  UNCONFIGURED_MODEL,
  type FightMetadata,
  type SabotageBrief,
} from "./fight-metadata.js";
import {
  RaceTelemetry,
  type RacerTelemetry,
  type StoredFrame,
} from "./race-telemetry.js";

export {
  DEFAULT_AGENT_ROSTER,
  normalizeFightMetadata,
  type FightMetadata,
  type FightMetadataInput,
  type SabotageBrief,
} from "./fight-metadata.js";

export type CreateRaceInput = {
  raceId: string;
  courseId: string;
  seed: string;
  checkpointCount: number;
  targetDurationMs?: number;
  absoluteDurationMs?: number;
  /** Model id per racer id, reported in `snapshot().competitors`. */
  competitorModels?: Record<string, string>;
};

export type RaceCoordinatorInput = CreateRaceInput & {
  /** Master task. `ApiCreateRaceInput` supplies it; fight.task wins. */
  task?: string;
  fight?: Partial<FightMetadata>;
};

export type RaceCoordinatorDependencies = {
  sessionManager: RacerSessionManager;
  agentRunner: CompetitorAgentRunner;
  courseVerifier: CourseVerifier;
  eventStore: RaceEventStore;
  obstacleProvider?: ObstacleProvider;
  /** Shared wallet. Defaults to a private per-market ledger. */
  ledger?: CreditLedger;
  /** Per-race LLM spend, reported in `snapshot().llmUsage`. */
  llmUsage?: () => RaceSnapshot["llmUsage"];
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
  competitors: Array<{
    racerId: string;
    model?: string;
  }>;
  llmUsage?: {
    limitUsd: number;
    spentUsd: number;
    remainingUsd: number;
    requests: number;
  };
};

export type BrowserView = {
  status: "pending" | "live" | "released" | "unavailable";
  viewerUrl: string | null;
};

export type RaceChange =
  | { kind: "fight" }
  | { kind: "price"; point: PricePoint }
  | { kind: "frame"; racerId: string }
  | { kind: "account"; userIds: string[] };

export type RaceChangeListener = (change: RaceChange) => void;

/** Presentation view of the fight's sabotage; the engine plan is the source of truth. */
export type SabotageStatus = {
  /** Bettor-facing brief. `plan.checkpoint` is the engine trigger checkpoint. */
  plan: SabotageBrief;
  checkpointLabel: string;
  /** Arming has settled (policy may still be null). */
  armed: boolean;
  /** The armed hazard; null when not armed or no policy was chosen. */
  policy: DisruptionCommand | null;
  /** Tier of the armed engine plan; null until armed. */
  tier: SabotageTier | null;
  armedAt: number | null;
  /** First time the sabotage was applied to any agent. */
  firedAt: number | null;
  hitRacerIds: string[];
  steps: SabotageStepStatus[];
  state: SabotageState;
};

export type SabotageStepStatus = {
  index: number;
  stepId: string;
  checkpoint: number;
  checkpointLabel: string;
  state: "armed" | "fired" | "recovered" | "expired";
  firedAt: number | null;
  recoveredAt: number | null;
  hitRacerIds: string[];
  policy: DisruptionCommand;
};

/** Weight deltas per race event, as multiples of base liquidity L. */
export const CONFIDENCE_SIGNALS = {
  checkpoint: 0.35,
  sabotageHit: -0.25,
  recovery: 0.1,
  completion: 0.5,
} as const;

/** While live, tick appends a price point when the last is this old. */
export const PRICE_HEARTBEAT_MS = 5_000;

type PendingChanges = {
  fight: boolean;
  points: PricePoint[];
  frames: Set<string>;
  accounts: Set<string>;
};

const RECOVERY_TEXT: Record<string, string> = {
  duration: "Recovered: disruption expired",
  manual: "Recovered",
};

function createChanges(): PendingChanges {
  return { fight: false, points: [], frames: new Set(), accounts: new Set() };
}

export class RaceCoordinator {
  readonly engine: RaceEngine;
  readonly market: VirtualPredictionMarket;
  readonly telemetry: RaceTelemetry;

  private readonly fightMeta: FightMetadata;
  private readonly sabotageDefaulted: boolean;
  private sabotageBrief: SabotageBrief | null;
  private sabotageArming?: Promise<DisruptionCommand | null>;
  private sabotageSettled = false;
  private sabotageArmedAt: number | null = null;
  private sabotageFiredAt: number | null = null;
  private readonly sabotageHits: string[] = [];
  private readonly sessions = new Map<string, RacerSessionHandle>();
  private readonly releasedRacers = new Set<string>();
  private readonly runnerTasks = new Map<string, Promise<void>>();
  private readonly orderReceipts = new Map<string, OrderReceipt>();
  private readonly listeners = new Set<RaceChangeListener>();
  private processedEventCount = 0;
  private persistedEventCount = 0;
  private persisting: Promise<void> = Promise.resolve();
  private closedAtValue: number | null = null;
  private stopped = false;
  private cleanupComplete = false;
  private cleanupInFlight?: Promise<void>;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private readonly competitorModels: Record<string, string>;

  constructor(
    input: RaceCoordinatorInput,
    private readonly dependencies: RaceCoordinatorDependencies,
  ) {
    this.fightMeta = normalizeFightMetadata(input);
    this.competitorModels = { ...input.competitorModels };

    if (dependencies.obstacleProvider) {
      const checkpoint = this.fightMeta.sabotage?.checkpoint ??
        (input.checkpointCount >= 4 ? 2 : Math.min(DEFAULT_SABOTAGE_CHECKPOINT, input.checkpointCount));
      this.sabotageBrief = this.fightMeta.sabotage
        ? { ...this.fightMeta.sabotage }
        : { checkpoint, summary: sabotagePlaceholder(this.checkpointLabel(checkpoint)) };
      this.sabotageDefaulted = this.fightMeta.sabotage === null;
    } else {
      this.sabotageDefaulted = false;
      this.sabotageBrief = null;
    }
    this.fightMeta.sabotage = this.sabotageBrief;

    this.engine = new RaceEngine(
      {
        raceId: input.raceId,
        courseId: input.courseId,
        seed: input.seed,
        checkpointCount: input.checkpointCount,
        now: this.fightMeta.createdAt,
      },
      {
        targetDurationMs: input.targetDurationMs,
        absoluteDurationMs: input.absoluteDurationMs,
        obstacleProvider: dependencies.obstacleProvider,
      },
    );
    const racerIds = [...this.engine.racers.keys()];
    this.market = new VirtualPredictionMarket(racerIds, {
      ledger: dependencies.ledger,
      raceId: input.raceId,
    });
    this.telemetry = new RaceTelemetry(racerIds, input.checkpointCount);
    this.telemetry.setOpeningPrices(this.market.pricesSnapshot());
    // Baseline chart sample so upcoming fights have a price series.
    this.telemetry.appendPrice(this.fightMeta.createdAt, this.market.pricesSnapshot());
  }

  get raceId(): string {
    return this.engine.race.id;
  }

  /** When the race became finished or timed_out. */
  get closedAt(): number | null {
    return this.closedAtValue;
  }

  subscribe(listener: RaceChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Selects and arms the race-wide engine sabotage plan (memoised). The
   * policy is the brief's fixed policy, else the provider's `armRace`, else
   * its `getPolicy` fallback. A default brief's summary is generated from
   * the armed hazard. Resolves null without sabotage or when none was chosen.
   */
  arm(now = Date.now()): Promise<DisruptionCommand | null> {
    const provider = this.dependencies.obstacleProvider;
    const brief = this.sabotageBrief;
    if (!provider || !brief) return Promise.resolve(null);
    this.sabotageArming ??= this.selectSabotagePlan(provider, brief, now)
      .catch(() => null)
      .then((plan) => this.settleSabotage(plan, now));
    return this.sabotageArming;
  }

  async prepareAndStart(now = Date.now()): Promise<RaceSnapshot> {
    try {
      await this.arm(now);
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
      await this.afterEngineMutation(now);

      for (const session of sessions) {
        const context: CompetitorContext = {
          ...this.baseContext(session),
          reportCheckpoint: (checkpoint) =>
            this.recordCheckpoint(session.racerId, checkpoint),
          reportFinish: () => this.recordFinish(session.racerId),
          checkFinish: () => this.checkFinish(session.racerId),
        };
        const task = this.dependencies.agentRunner
          .run(context)
          .then(() => this.handleRunnerCompletion(session.racerId))
          .catch((error: unknown) => this.handleRunnerFailure(session.racerId, error))
          .finally(() => {
            this.runnerTasks.delete(session.racerId);
          });
        this.runnerTasks.set(session.racerId, task);
      }

      return this.snapshot();
    } catch (error) {
      await this.abortStart(now);
      throw error;
    }
  }

  async recordCheckpoint(
    racerId: string,
    checkpoint: number,
    now = Date.now(),
  ): Promise<void> {
    return this.enqueueLifecycle(() =>
      this.recordCheckpointInternal(racerId, checkpoint, now),
    );
  }

  private async recordCheckpointInternal(
    racerId: string,
    checkpoint: number,
    now: number,
  ): Promise<void> {
    const session = this.getSession(racerId);
    const verified = await this.dependencies.courseVerifier.verifyCheckpoint({
      raceId: this.engine.race.id,
      racerId,
      courseId: this.engine.race.courseId,
      checkpoint,
      seed: this.engine.race.seed,
      session,
    });
    if (!verified) {
      throw new Error(`Checkpoint ${checkpoint} was not verified for ${racerId}`);
    }

    const plan = this.engine.race.sabotagePlan;
    const sabotageStep = plan?.steps?.find((step) => step.checkpoint === checkpoint);
    if (plan && (sabotageStep || checkpoint === plan.trigger.checkpoint)) {
      const openingVerified = await this.dependencies.courseVerifier.verifyTargetOpening({
        raceId: this.engine.race.id,
        racerId,
        courseId: this.engine.race.courseId,
        seed: this.engine.race.seed,
        session,
      });
      if (!openingVerified) {
        throw new Error(`Target opening was not verified for ${racerId}`);
      }
    }

    // checkpoint_reached (and sabotage_triggered) are emitted synchronously,
    // before the sabotage is applied, so spectators see the checkpoint first.
    const reaching = this.engine.reachCheckpoint(racerId, checkpoint, now);
    const early = createChanges();
    this.processEngineEvents(now, early);
    this.flush(early);
    try {
      await reaching;
    } finally {
      await this.afterEngineMutation(now);
    }
  }

  async recordFinish(racerId: string, now = Date.now()): Promise<void> {
    return this.enqueueLifecycle(() => this.recordFinishInternal(racerId, now));
  }

  /**
   * Attempts verifier-backed completion after an arbitrary browser action.
   * Returning false is normal while the task is still in progress.
   */
  private async checkFinish(racerId: string, now = Date.now()): Promise<boolean> {
    if (this.stopped) return this.engine.racers.get(racerId)?.status === "finished";
    const racer = this.engine.racers.get(racerId);
    if (!racer || racer.status === "failed" || racer.status === "timed_out") return false;
    if (racer.status === "finished") return true;
    try {
      const session = this.getSession(racerId);
      const verified = await this.dependencies.courseVerifier.verifyFinish({
        raceId: this.engine.race.id,
        racerId,
        courseId: this.engine.race.courseId,
        seed: this.engine.race.seed,
        session,
      });
      if (!verified) return false;
      await this.recordFinish(racerId, now);
      return this.engine.racers.get(racerId)?.status === "finished";
    } catch {
      return false;
    }
  }

  private async recordFinishInternal(racerId: string, now: number): Promise<void> {
    const session = this.getSession(racerId);
    const verified = await this.dependencies.courseVerifier.verifyFinish({
      raceId: this.engine.race.id,
      racerId,
      courseId: this.engine.race.courseId,
      seed: this.engine.race.seed,
      session,
    });
    if (!verified) {
      throw new Error(`Final task state was not verified for ${racerId}`);
    }

    const won = this.engine.finishRacer(racerId, now);
    const changes = createChanges();
    // Process the verified completion while the market is still open so the
    // final confidence signal is reflected in the last live quote.
    this.processEngineEvents(now, changes);
    if (won) {
      this.market.freeze();
      this.market.resolve(racerId, now);
      this.addSettledAccounts(changes);
    }
    try {
      await this.synchronizeLifecycle(now, changes);
      await this.persistNewEvents();
    } finally {
      if (won && !this.stopped) {
        await this.shutdownRace();
      }
      this.flush(changes);
    }
  }

  async tick(now = Date.now()): Promise<void> {
    return this.enqueueLifecycle(() => this.tickInternal(now));
  }

  private async tickInternal(now: number): Promise<void> {
    this.engine.tick(now);
    const changes = createChanges();
    this.processEngineEvents(now, changes);
    await this.synchronizeLifecycle(now, changes);
    if (this.isLive()) {
      const last = this.telemetry.lastPricePoint();
      if (last && now - last.t >= PRICE_HEARTBEAT_MS) {
        const point = this.telemetry.appendPrice(now, this.market.pricesSnapshot(), {
          heartbeat: true,
        });
        if (point) changes.points.push(point);
      }
    }
    await this.persistNewEvents();
    this.flush(changes);
  }

  /** Places a spectator order. Idempotent per userId + clientOrderId. */
  placeOrder(order: OrderRequest, now = Date.now()): OrderReceipt {
    const { userId, racerId, side, action, quantity, limitPrice, clientOrderId } = order;
    if (typeof userId !== "string" || userId.length === 0) {
      throw new DomainError("invalid", "userId is required");
    }
    if (
      clientOrderId !== undefined &&
      (typeof clientOrderId !== "string" || clientOrderId.length === 0 ||
        clientOrderId.length > 128)
    ) {
      throw new DomainError("invalid", "clientOrderId must be 1 to 128 characters");
    }
    const idempotencyKey = clientOrderId === undefined
      ? undefined
      : `${userId}\u0000${clientOrderId}`;
    const previous = idempotencyKey ? this.orderReceipts.get(idempotencyKey) : undefined;
    if (previous) {
      return { ...previous };
    }

    if (typeof racerId !== "string" || !this.engine.racers.has(racerId)) {
      throw new DomainError("not_found", `Unknown racer: ${String(racerId)}`);
    }
    if (side !== "yes" && side !== "no") {
      throw new DomainError("invalid", "side must be yes or no");
    }
    if (action !== "buy" && action !== "sell") {
      throw new DomainError("invalid", "action must be buy or sell");
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new DomainError("invalid", "quantity must be a positive integer");
    }

    const options = { limitPrice, now };
    const trade = action === "buy"
      ? this.market.buy(userId, racerId, quantity, side, options)
      : this.market.sell(userId, racerId, quantity, side, options);
    const receipt: OrderReceipt = {
      orderId: crypto.randomUUID(),
      clientOrderId: clientOrderId ?? null,
      raceId: this.engine.race.id,
      racerId,
      side,
      action,
      quantity,
      price: trade.price,
      total: trade.total,
      payoutIfWin: action === "buy" ? quantity : 0,
      executedAt: now,
    };
    if (idempotencyKey) {
      this.orderReceipts.set(idempotencyKey, receipt);
    }
    this.afterTrade(userId, now);
    return { ...receipt };
  }

  fundSpectator(userId: string, credits: number, now = Date.now()): void {
    this.market.fund(userId, credits, now);
    const changes = createChanges();
    changes.accounts.add(userId);
    this.flush(changes);
  }

  buyShares(userId: string, racerId: string, quantity: number, now = Date.now()): TradeReceipt {
    const receipt = this.market.buy(userId, racerId, quantity, "yes", { now });
    this.afterTrade(userId, now);
    return receipt;
  }

  sellShares(userId: string, racerId: string, quantity: number, now = Date.now()): TradeReceipt {
    const receipt = this.market.sell(userId, racerId, quantity, "yes", { now });
    this.afterTrade(userId, now);
    return receipt;
  }

  spectatorBalance(userId: string): number {
    return this.market.balance(userId);
  }

  /** Applies a competitor step report to the racer's telemetry. */
  recordAgentAction(racerId: string, report: AgentActionReport, now = Date.now()): void {
    this.telemetry.recordAction(racerId, report, now);
    this.flush({ ...createChanges(), fight: true });
  }

  /** Stores a racer's latest browser capture and bumps its frame seq. */
  recordAgentFrame(racerId: string, frame: CapturedFrame, now = Date.now()): void {
    this.telemetry.recordFrame(racerId, frame, now);
    const changes = createChanges();
    changes.frames.add(racerId);
    changes.fight = true;
    this.flush(changes);
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
      competitors: [...this.engine.racers.keys()].map((racerId, index) => ({
        racerId,
        model: this.competitorModels[racerId] ?? this.configuredAgentModel(index),
      })),
      llmUsage: this.dependencies.llmUsage?.(),
    };
  }

  browserView(racerId: string): BrowserView {
    if (!this.engine.racers.has(racerId)) {
      throw new DomainError("not_found", `Unknown racer: ${racerId}`);
    }
    const session = this.sessions.get(racerId);
    if (!session) return { status: "pending", viewerUrl: null };
    if (
      this.releasedRacers.has(racerId) ||
      this.stopped ||
      ["finished", "timed_out"].includes(this.engine.race.status)
    ) {
      return { status: "released", viewerUrl: null };
    }
    if (!session.viewerUrl) return { status: "unavailable", viewerUrl: null };
    return { status: "live", viewerUrl: session.viewerUrl };
  }

  /** A copy of the fight metadata. `sabotage` reflects the effective plan. */
  get fight(): FightMetadata {
    return structuredClone(this.fightMeta);
  }

  checkpointLabel(checkpoint: number): string {
    return this.fightMeta.checkpointLabels[checkpoint - 1] ?? defaultCheckpointLabel(checkpoint);
  }

  /** Null when the fight has no sabotage (no obstacle provider). */
  get sabotage(): SabotageStatus | null {
    const plan = this.sabotageBrief;
    if (!plan) return null;
    const armedPlan = this.engine.race.sabotagePlan;
    const raceStatus = this.engine.race.status;
    const state: SabotageState = this.sabotageFiredAt !== null
      ? "fired"
      : raceStatus === "hazards_frozen" || raceStatus === "finished" ||
          raceStatus === "timed_out"
        ? "expired"
        : "armed";
    const steps = armedPlan
      ? (armedPlan.steps ?? [{
          stepId: "legacy-step-1",
          checkpoint: armedPlan.trigger.checkpoint,
          tier: armedPlan.tier,
          policy: armedPlan.policy,
          selectedAt: armedPlan.selectedAt,
        }]).map((step, index) => {
          const applied = this.engine.events.filter((event) =>
            event.type === "sabotage_applied" &&
            (event.metadata?.stepId === step.stepId ||
              (!armedPlan.steps && event.metadata?.tier === step.tier)),
          );
          const recovered = this.engine.events.filter((event) =>
            event.type === "sabotage_recovered" &&
            (event.metadata?.stepId === step.stepId || !armedPlan.steps),
          );
          const firedAt = applied[0]?.occurredAt ?? null;
          const recoveredAt = recovered.length > 0
            ? recovered[recovered.length - 1]?.occurredAt ?? null
            : null;
          return {
            index: index + 1,
            stepId: step.stepId,
            checkpoint: step.checkpoint,
            checkpointLabel: this.checkpointLabel(step.checkpoint),
            state: firedAt === null
              ? (raceStatus === "hazards_frozen" || raceStatus === "finished" || raceStatus === "timed_out"
                ? "expired"
                : "armed")
              : recovered.length >= applied.length
                ? "recovered"
                : "fired",
            firedAt,
            recoveredAt,
            hitRacerIds: [...new Set(applied.map((event) => event.racerId).filter(Boolean) as string[])],
            policy: { ...step.policy },
          } satisfies SabotageStepStatus;
        })
      : [];
    return {
      plan: structuredClone(plan),
      checkpointLabel: this.checkpointLabel(plan.checkpoint),
      armed: this.sabotageSettled,
      policy: armedPlan ? { ...armedPlan.policy } : null,
      tier: armedPlan?.tier ?? null,
      armedAt: this.sabotageArmedAt,
      firedAt: this.sabotageFiredAt,
      hitRacerIds: [...this.sabotageHits],
      steps,
      state,
    };
  }

  racerTelemetry(racerId: string): RacerTelemetry {
    return this.telemetry.racer(racerId);
  }

  runStatus(racerId: string): RunStatus {
    const racer = this.engine.racers.get(racerId);
    if (!racer) throw new DomainError("not_found", `Unknown racer: ${racerId}`);
    return this.telemetry.runStatus(racerId, racer.status);
  }

  /** Oldest first. */
  priceHistory(): PricePoint[] {
    return this.telemetry.priceHistory();
  }

  /** YES prices at race start, or at creation before the start. */
  get openingPrices(): Record<string, number> {
    return this.telemetry.openingPrices() ?? this.market.pricesSnapshot();
  }

  frame(racerId: string): StoredFrame | null {
    return this.telemetry.frame(racerId);
  }

  async events() {
    return this.dependencies.eventStore.list(this.engine.race.id);
  }

  async shutdown(): Promise<void> {
    await this.shutdownRace();
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async shutdownRace(): Promise<void> {
    this.stopped = true;
    if (this.cleanupComplete) return;
    if (this.cleanupInFlight) return this.cleanupInFlight;
    const cleanup = (async () => {
      await this.stopRacers();
      const results = await Promise.allSettled([
        this.dependencies.sessionManager.releaseAll(),
        this.cleanupObstacleProvider(),
      ]);
      this.cleanupComplete = results.every((result) => result.status === "fulfilled");
    })();
    this.cleanupInFlight = cleanup.finally(() => {
      this.cleanupInFlight = undefined;
    });
    return this.cleanupInFlight;
  }

  private async cleanupObstacleProvider(): Promise<void> {
    const cleanup = this.dependencies.obstacleProvider &&
      "cleanup" in this.dependencies.obstacleProvider
      ? (this.dependencies.obstacleProvider as ObstacleProvider & {
          cleanup?: () => Promise<void>;
        }).cleanup
      : undefined;
    await cleanup?.();
  }

  /** Fixed operator policy, else provider.armRace, else the getPolicy fallback. */
  private async selectSabotagePlan(
    provider: ObstacleProvider,
    brief: SabotageBrief,
    now: number,
  ): Promise<SabotagePlan | null> {
    const race = this.engine.race;
    const trigger: SabotageTrigger = {
      kind: "target_opened",
      checkpoint: brief.checkpoint,
      milestone: "first_verified_checkpoint",
    };
    if (brief.policy) {
      return {
        raceId: race.id,
        tier: tierForPolicy(brief.policy),
        trigger,
        policy: { ...brief.policy },
        selectedAt: now,
        source: "operator",
      };
    }
    if (provider.armRace) {
      return provider.armRace({
        raceId: race.id,
        courseId: race.courseId,
        seed: race.seed,
        checkpointCount: race.checkpointCount,
        trigger,
      });
    }
    const policy = await provider.getPolicy(race.id, brief.checkpoint);
    if (!policy) return null;
    return {
      raceId: race.id,
      tier: tierForPolicy(policy),
      trigger,
      policy,
      selectedAt: now,
      source: "fallback",
    };
  }

  /** Arms the engine with a valid plan; a failed or invalid plan arms nothing. */
  private settleSabotage(plan: SabotagePlan | null, now: number): DisruptionCommand | null {
    let armed: SabotagePlan | null = null;
    if (plan && this.engine.race.status === "starting") {
      try {
        validateDisruptionCommand(plan.policy);
        for (const step of plan.steps ?? []) validateDisruptionCommand(step.policy);
        this.engine.armSabotage(plan, now);
        armed = this.engine.race.sabotagePlan ?? null;
      } catch {
        armed = null;
      }
    }
    this.sabotageSettled = true;
    this.sabotageArmedAt ??= now;
    if (this.sabotageDefaulted && armed && this.sabotageBrief) {
      const label = this.checkpointLabel(this.sabotageBrief.checkpoint);
      this.sabotageBrief = {
        ...this.sabotageBrief,
        summary: describeHazard(armed.policy, label),
        detail: describeHazardDetail(armed.policy, label),
      };
      this.fightMeta.sabotage = this.sabotageBrief;
    }
    const changes = createChanges();
    this.processEngineEvents(now, changes);
    changes.fight = true;
    this.flush(changes);
    return armed ? { ...armed.policy } : null;
  }

  private baseContext(
    session: RacerSessionHandle,
  ): Omit<CompetitorContext, "reportCheckpoint" | "reportFinish"> {
    const racerId = session.racerId;
    return {
      raceId: this.engine.race.id,
      racerId,
      courseId: this.engine.race.courseId,
      seed: this.engine.race.seed,
      checkpointCount: this.engine.race.checkpointCount,
      session,
      reportAction: (report) => {
        try {
          this.recordAgentAction(racerId, report);
        } catch {
          // Telemetry must never break the competitor loop.
        }
      },
      reportFrame: (frame) => {
        try {
          this.recordAgentFrame(racerId, frame);
        } catch {
          // Telemetry must never break the competitor loop.
        }
      },
    };
  }

  private configuredAgentModel(index: number): string | undefined {
    const model = this.fightMeta.agents[index]?.model;
    return model && model !== UNCONFIGURED_MODEL ? model : undefined;
  }

  private getSession(racerId: string): RacerSessionHandle {
    const session = this.sessions.get(racerId);
    if (!session) throw new Error(`No prepared session for ${racerId}`);
    return session;
  }

  private isLive(): boolean {
    const status = this.engine.race.status;
    return status === "running" || status === "hazards_frozen" || status === "finishing";
  }

  private afterTrade(userId: string, now: number): void {
    const changes = createChanges();
    changes.fight = true;
    changes.accounts.add(userId);
    // A trade moves every mark in the race, so every holder is notified.
    for (const position of this.market.allPositions()) {
      changes.accounts.add(position.userId);
    }
    this.capturePrices(now, changes, false);
    this.flush(changes);
  }

  private async afterEngineMutation(now: number): Promise<void> {
    const changes = createChanges();
    this.processEngineEvents(now, changes);
    await this.synchronizeLifecycle(now, changes);
    await this.persistNewEvents();
    this.flush(changes);
  }

  /** Reacts to engine events not yet seen, in order. Synchronous. */
  private processEngineEvents(now: number, changes: PendingChanges): void {
    let processed = false;
    while (this.processedEventCount < this.engine.events.length) {
      const event = this.engine.events[this.processedEventCount];
      this.processedEventCount += 1;
      processed = true;
      this.applyEvent(event, changes);
    }
    if (processed) {
      changes.fight = true;
      this.capturePrices(now, changes, false);
    }
  }

  private applyEvent(event: RaceEvent, changes: PendingChanges): void {
    const liquidity = this.market.baseLiquidity;
    const at = event.occurredAt;
    const racerId = event.racerId;
    const metadata = event.metadata ?? {};

    switch (event.type) {
      case "race_started":
        this.telemetry.setOpeningPrices(this.market.pricesSnapshot());
        this.capturePrices(at, changes, true);
        return;
      case "hazards_frozen":
        this.market.freeze();
        return;
      case "race_finished":
        this.closedAtValue ??= at;
        return;
      case "race_timed_out": {
        this.closedAtValue ??= at;
        const reason = String(metadata.reason ?? "absolute_deadline");
        const text = reason === "absolute_deadline"
          ? "Timed out at the safety cap"
          : `Stopped: ${reason}`;
        for (const racer of this.engine.racers.values()) {
          if (racer.status === "timed_out") {
            this.telemetry.appendLog(racer.racerId, { kind: "status", text, at });
          }
        }
        return;
      }
      default:
        break;
    }
    if (!racerId) return;

    switch (event.type) {
      case "checkpoint_reached": {
        const checkpoint = event.checkpoint ?? 0;
        this.telemetry.markCheckpointCleared(racerId, checkpoint, at);
        this.telemetry.appendLog(racerId, {
          kind: "checkpoint",
          text: `Cleared ${this.checkpointLabel(checkpoint)}`,
          at,
        });
        this.market.adjustConfidence(racerId, CONFIDENCE_SIGNALS.checkpoint * liquidity);
        return;
      }
      case "sabotage_applied": {
        this.telemetry.markSabotageHit(racerId, event.checkpoint ?? null, at);
        this.telemetry.appendLog(racerId, {
          kind: "sabotage",
          text: `Sabotage fired: ${this.hazardText()}`,
          at,
        });
        if (!this.sabotageHits.includes(racerId)) this.sabotageHits.push(racerId);
        this.sabotageFiredAt ??= at;
        this.market.adjustConfidence(racerId, CONFIDENCE_SIGNALS.sabotageHit * liquidity);
        return;
      }
      case "sabotage_misfired": {
        const reason = typeof metadata.reason === "string" ? metadata.reason : "not applied";
        this.telemetry.appendLog(racerId, {
          kind: "sabotage",
          text: `Sabotage misfired (${reason}): ${this.hazardText()}`,
          at,
        });
        return;
      }
      case "sabotage_recovered": {
        const cause = String(metadata.cause ?? "manual");
        this.telemetry.markRecovered(racerId, at);
        this.telemetry.appendLog(racerId, {
          kind: "recovered",
          text: RECOVERY_TEXT[cause] ?? "Recovered",
          at,
        });
        this.market.adjustConfidence(racerId, CONFIDENCE_SIGNALS.recovery * liquidity);
        return;
      }
      case "racer_failed":
        this.telemetry.appendLog(racerId, {
          kind: "status",
          text: `Failed: ${String(metadata.reason ?? "unknown error")}`,
          at,
        });
        this.market.collapse(racerId);
        return;
      case "racer_finished":
        this.telemetry.appendLog(racerId, {
          kind: "status",
          text: "Finished: final task state verified",
          at,
        });
        this.market.adjustConfidence(racerId, CONFIDENCE_SIGNALS.completion * liquidity);
        return;
      default:
        return;
    }
  }

  private hazardText(): string {
    return hazardLabel(this.engine.race.sabotagePlan?.policy.hazardType ?? "hazard");
  }

  /** Appends a price point when prices moved (or when forced). */
  private capturePrices(now: number, changes: PendingChanges, force: boolean): void {
    const point = this.telemetry.appendPrice(now, this.market.pricesSnapshot(), {
      heartbeat: force,
    });
    if (!point) return;
    changes.points.push(point);
    changes.fight = true;
    // Marks moved: every holder's position value changed.
    for (const position of this.market.allPositions()) {
      changes.accounts.add(position.userId);
    }
  }

  private addSettledAccounts(changes: PendingChanges): void {
    changes.fight = true;
    for (const line of this.market.settlementLines()) {
      changes.accounts.add(line.userId);
    }
  }

  private async synchronizeLifecycle(now: number, changes: PendingChanges): Promise<void> {
    if (this.engine.race.status === "hazards_frozen") {
      this.market.freeze();
    }
    if (this.engine.race.status === "timed_out" && !this.stopped) {
      if (this.market.status !== "resolved" && this.market.status !== "unresolved") {
        this.market.markUnresolved(now);
        this.addSettledAccounts(changes);
      }
      this.closedAtValue ??= now;
      try {
        await this.persistNewEvents();
      } finally {
        // Persistence failures must not strand browser sessions. A later
        // shutdown call remains safe because cleanup is idempotent.
        await this.shutdownRace();
      }
    }
  }

  /** Start-up failed: void the market, abort the race, release sessions. */
  private async abortStart(now: number): Promise<void> {
    const changes = createChanges();
    try {
      if (this.market.status !== "resolved" && this.market.status !== "unresolved") {
        this.market.markUnresolved(now);
        this.addSettledAccounts(changes);
      }
      this.engine.abort("start_failed", now);
      this.processEngineEvents(now, changes);
    } catch {
      // Never mask the original start-up failure.
    }
    await this.persistNewEvents().catch(() => undefined);
    await this.shutdown().catch(() => undefined);
    this.flush(changes);
  }

  private flush(changes: PendingChanges): void {
    for (const point of changes.points) {
      this.emitChange({ kind: "price", point });
    }
    for (const racerId of changes.frames) {
      this.emitChange({ kind: "frame", racerId });
    }
    if (changes.fight) {
      this.emitChange({ kind: "fight" });
    }
    if (changes.accounts.size > 0) {
      this.emitChange({ kind: "account", userIds: [...changes.accounts] });
    }
  }

  private emitChange(change: RaceChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch {
        // A failing subscriber must not break the race.
      }
    }
  }

  private async stopRacers(): Promise<void> {
    const stops = Promise.allSettled(
      [...this.engine.racers.keys()].map((racerId) =>
        this.dependencies.agentRunner.stop(racerId),
      ),
    );
    await Promise.race([stops, delay(1_000)]);
    await Promise.race([
      Promise.allSettled([...this.runnerTasks.values()]),
      delay(1_000),
    ]);
  }

  private async handleRunnerFailure(racerId: string, error: unknown): Promise<void> {
    return this.enqueueLifecycle(() => this.handleRunnerFailureInternal(racerId, error));
  }

  private async handleRunnerFailureInternal(racerId: string, error: unknown): Promise<void> {
    // Runners commonly reject once they are stopped; that is not a failure.
    if (this.stopped) return;
    const reason = error instanceof Error ? error.message : String(error);
    try {
      this.engine.failRacer(racerId, reason);
      this.releasedRacers.add(racerId);
      await this.dependencies.sessionManager.release(racerId).catch(() => undefined);
      const active = [...this.engine.racers.values()].some(
        (racer) => racer.status === "running" || racer.status === "recovering",
      );
      if (!active) this.engine.abort("all_racers_failed");
      await this.afterEngineMutation(Date.now());
    } catch {
      // The runner task must never reject unhandled.
    }
  }

  private async handleRunnerCompletion(racerId: string): Promise<void> {
    if (this.stopped) return;
    const racer = this.engine.racers.get(racerId);
    if (!racer || ["finished", "failed", "timed_out"].includes(racer.status)) return;
    await this.handleRunnerFailure(racerId, new Error("competitor runner exited before completion"));
  }

  /** Serialised so concurrent callers never append an event twice. */
  private persistNewEvents(): Promise<void> {
    const run = this.persisting.then(async () => {
      while (this.persistedEventCount < this.engine.events.length) {
        const event = this.engine.events[this.persistedEventCount];
        await this.dependencies.eventStore.append(event);
        this.persistedEventCount += 1;
      }
    });
    this.persisting = run.catch(() => undefined);
    return run;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
