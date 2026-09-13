import type {
  AgentIdentity,
  EvaluationStatus,
  FightEvaluation,
  FightEvaluationPointer,
  OrderReceipt,
  OrderRequest,
  PricePoint,
  RunStatus,
  SabotageState,
  ServerMode,
} from "../api/dto.js";
import { captureFightDataset, type FightCaptureInput } from "../dataset/capture.js";
import type { DatasetStore } from "../dataset/store.js";
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
import {
  evaluateFight,
  sabotageStepIdOf,
  type EvaluationAgentInput,
  type EvaluationInput,
  type EvaluationSteelInput,
} from "../evaluation/evaluator.js";
import type { EvaluationStore } from "../evaluation/store.js";
import { validateDisruptionCommand } from "../infra/cdp-obstacle-provider.js";
import {
  collectSteelEvidence,
  downloadSteelReplay,
  fetchSteelHlsPlaylist,
  mergeSteelEvidence,
  STEEL_EVIDENCE_RETRY_MS,
  steelEvidenceComplete,
  type SteelEvidence,
  type SteelSessionCredentials,
} from "../infra/steel-evidence.js";
import { isTransientCourseStateError } from "../course/deterministic-course-verifier.js";
import { VirtualPredictionMarket } from "../prediction/virtual-market.js";
import type { TradeReceipt } from "../prediction/virtual-market.js";
import type { CreditLedger } from "../wallet/credit-ledger.js";
import type {
  AgentActionReport,
  CapturedFrame,
  CompletionJudge,
  CompetitorAgentRunner,
  CompetitorContext,
  CourseVerifier,
  RacerSessionHandle,
  RacerSessionManager,
  ReplayStore,
  RaceEventStore,
  WorkerStateObservation,
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
  /** Optional site-agnostic master judge used when course proof is unavailable. */
  completionJudge?: CompletionJudge;
  eventStore: RaceEventStore;
  obstacleProvider?: ObstacleProvider;
  /** Shared wallet. Defaults to a private per-market ledger. */
  ledger?: CreditLedger;
  /** Per-race LLM spend, reported in `snapshot().llmUsage`. */
  llmUsage?: () => RaceSnapshot["llmUsage"];
  /** The final evaluation is stored here once the fight closes. */
  evaluationStore?: EvaluationStore;
  /**
   * The fight's training record (docs/training-data.md), with its step
   * screenshots and raw Steel traces, is stored here after the final
   * evaluation, and again whenever Steel evidence published late updates it.
   * A failure never reaches the race or the evaluation.
   */
  datasetStore?: DatasetStore;
  /** Durable HLS replay storage, independent of the released Steel session. */
  replayStore?: ReplayStore;
  /** Stamped on evaluations; Steel evidence is read in live mode only. Default "live". */
  mode?: ServerMode;
  /** Fetch used for Steel evidence (agent traces, HLS). Default: the global fetch. */
  steelFetch?: typeof fetch;
  /**
   * Overall budget for reading Steel evidence once the fight closes, and for
   * each later read. Default 8 s.
   */
  steelEvidenceTimeoutMs?: number;
  /** Wait before refetching Steel evidence that was not ready yet. Default 1.5 s. */
  steelEvidenceRetryMs?: number;
  /**
   * When, after the evaluation became final, Steel evidence still missing (a
   * trace with no events, or no recording) is read again. Default 15 s,
   * 45 s, 2 min and 5 min.
   */
  steelBackfillDelaysMs?: readonly number[];
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

/** Overall budget for reading Steel traces and recordings once the fight closes. */
export const STEEL_EVIDENCE_TIMEOUT_MS = 8_000;
const REPLAY_COPY_TIMEOUT_MS = 20_000;

/**
 * Steel publishes a released session's traces, and sometimes its recording,
 * seconds to minutes late. Evidence still missing when the evaluation became
 * final is read again this long after it did.
 */
export const STEEL_BACKFILL_DELAYS_MS: readonly number[] = [15_000, 45_000, 120_000, 300_000];

type PendingChanges = {
  fight: boolean;
  points: PricePoint[];
  frames: Set<string>;
  accounts: Set<string>;
};

/** Steel evidence still missing when the evaluation became final, read again in the background. */
type SteelBackfill = {
  /** What the final evaluation was computed from; only its Steel evidence changes. */
  input: EvaluationInput;
  /** What the dataset record was built from; only its evaluation and raw traces change. */
  dataset: FightCaptureInput | null;
  /** The best evidence read so far, by racer. */
  steel: Map<string, SteelEvidence>;
  /** Wall-clock time the evaluation became final; the delays count from here. */
  finalizedAt: number;
  /** Index of the next delay. */
  next: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Aborts a read in flight on shutdown. */
  controller: AbortController;
};

const RECOVERY_TEXT: Record<string, string> = {
  duration: "Recovered: disruption expired",
  manual: "Recovered",
};

function createChanges(): PendingChanges {
  return { fight: false, points: [], frames: new Set(), accounts: new Set() };
}

type ProgressReviewOutcome = {
  finished: boolean;
  progressed: boolean;
};

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
  private readonly mode: ServerMode;
  private readonly progressSyncs = new Map<string, Promise<void>>();
  private readonly progressReviews = new Map<string, Promise<ProgressReviewOutcome>>();
  private readonly progressReviewKeys = new Map<string, string>();
  private evaluationVersion = 0;
  private evaluationUpdatedAt = 0;
  private lastEvaluationInputAt: number | null = null;
  private evaluationCache: { key: string; evaluation: FightEvaluation } | null = null;
  private finalEvaluation: FightEvaluation | null = null;
  private finalizeRequested = false;
  private steelBackfill: SteelBackfill | null = null;
  private steelBackfillStopped = false;
  private readonly finalWaiters: Array<(evaluation: FightEvaluation) => void> = [];

  constructor(
    input: RaceCoordinatorInput,
    private readonly dependencies: RaceCoordinatorDependencies,
  ) {
    this.fightMeta = normalizeFightMetadata(input);
    this.competitorModels = { ...input.competitorModels };
    this.mode = dependencies.mode ?? "live";

    if (dependencies.obstacleProvider) {
      const checkpoint = this.fightMeta.sabotage?.checkpoint ??
        Math.min(DEFAULT_SABOTAGE_CHECKPOINT, input.checkpointCount);
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
          reportCheckpoint: (checkpoint, source) =>
            this.recordCheckpoint(session.racerId, checkpoint, Date.now(), source),
          reportFinish: (source) =>
            this.recordFinish(session.racerId, Date.now(), source),
          reportRecovery: () => this.recordRecovery(session.racerId),
          syncProgress: () => this.syncProgress(session.racerId),
          checkFinish: () => this.checkFinish(session.racerId),
          reviewProgress: (observation) =>
            this.reviewProgress(session.racerId, observation),
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
    source: "course" | "master" = "course",
  ): Promise<boolean> {
    return this.enqueueLifecycle(() =>
      this.recordCheckpointInternal(racerId, checkpoint, now, source === "master"),
    );
  }

  private async recordCheckpointInternal(
    racerId: string,
    checkpoint: number,
    now: number,
    alreadyVerified = false,
  ): Promise<boolean> {
    const session = this.getSession(racerId);
    const racer = this.engine.racers.get(racerId);
    if (!racer) throw new Error(`Unknown racer: ${racerId}`);
    // Browser actions and verifier sync can report the same checkpoint more
    // than once. Treat an already-claimed checkpoint as an idempotent success.
    if (checkpoint <= racer.checkpoint) return true;
    if (checkpoint !== racer.checkpoint + 1) {
      throw new Error(`${racerId} must reach checkpoint ${racer.checkpoint + 1} next`);
    }
    if (!alreadyVerified) {
      let verified: boolean;
      try {
        verified = await this.dependencies.courseVerifier.verifyCheckpoint({
          raceId: this.engine.race.id,
          racerId,
          courseId: this.engine.race.courseId,
          checkpoint,
          seed: this.engine.race.seed,
          session,
        });
      } catch (error) {
        if (isTransientCourseStateError(error)) return false;
        throw error;
      }
      // A false result is normal while the page is still settling. The next
      // browser action's progress sync will retry it without failing the run.
      if (!verified) return false;
    }

    const plan = this.engine.race.sabotagePlan;
    const sabotageStep = plan?.steps?.find((step) => step.checkpoint === checkpoint);
    if (!alreadyVerified && plan && (sabotageStep || checkpoint === plan.trigger.checkpoint)) {
      let openingVerified: boolean;
      try {
        openingVerified = await this.dependencies.courseVerifier.verifyTargetOpening({
          raceId: this.engine.race.id,
          racerId,
          courseId: this.engine.race.courseId,
          seed: this.engine.race.seed,
          session,
        });
      } catch (error) {
        if (isTransientCourseStateError(error)) return false;
        throw error;
      }
      if (!openingVerified) {
        return false;
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
    return (this.engine.racers.get(racerId)?.checkpoint ?? -1) >= checkpoint;
  }

  async recordFinish(
    racerId: string,
    now = Date.now(),
    source: "course" | "master" = "course",
  ): Promise<boolean> {
    return this.enqueueLifecycle(() => this.recordFinishInternal(
      racerId,
      now,
      source === "master",
    ));
  }

  async recordRecovery(racerId: string, now = Date.now()): Promise<void> {
    return this.enqueueLifecycle(async () => {
      this.engine.markRecovered(racerId, now, "manual");
      await this.afterEngineMutation(now);
    });
  }

  /**
   * Attempts verifier-backed completion after an arbitrary browser action.
   * Returning false is normal while the task is still in progress.
   */
  private async checkFinish(racerId: string, now = Date.now()): Promise<boolean> {
    await this.syncProgress(racerId);
    return this.enqueueLifecycle(() => this.checkFinishInternal(racerId, now));
  }

  private async checkFinishInternal(racerId: string, now: number): Promise<boolean> {
    if (this.stopped) return this.engine.racers.get(racerId)?.status === "finished";
    const racer = this.engine.racers.get(racerId);
    if (!racer || racer.status === "failed" || racer.status === "timed_out") return false;
    if (racer.status === "finished") return true;
    let verified = false;
    try {
      const session = this.getSession(racerId);
      verified = await this.dependencies.courseVerifier.verifyFinish({
        raceId: this.engine.race.id,
        racerId,
        courseId: this.engine.race.courseId,
        seed: this.engine.race.seed,
        session,
      });
      if (!verified) return false;
      await this.recordFinishInternal(racerId, now, true);
      return this.engine.racers.get(racerId)?.status === "finished";
    } catch (error) {
      if (verified) {
        const reason = error instanceof Error ? error.message : String(error);
        this.telemetry.appendLog(racerId, {
          kind: "status",
          text: `Verified completion could not be finalized: ${reason}`,
          at: now,
        });
        this.flush({ ...createChanges(), fight: true });
      }
      return false;
    }
  }

  /**
   * Verifier-backed progress sync after a browser action: records, in order
   * and through the normal lifecycle path, each checkpoint the course already
   * verified that the race has not claimed. Stops at the first unverified
   * checkpoint, and while the racer is recovering (the engine rejects
   * progress then; the next sync retries). Serialised per racer. Never throws.
   */
  private syncProgress(racerId: string): Promise<void> {
    const previous = this.progressSyncs.get(racerId) ?? Promise.resolve();
    const run = previous
      .then(() => this.syncProgressOnce(racerId))
      .catch(() => undefined);
    this.progressSyncs.set(racerId, run);
    void run.then(() => {
      if (this.progressSyncs.get(racerId) === run) this.progressSyncs.delete(racerId);
    });
    return run;
  }

  /** Reviews the live page when a worker did not emit an explicit milestone. */
  private reviewProgress(
    racerId: string,
    observation: WorkerStateObservation,
  ): Promise<boolean> {
    const checkpoint = this.engine.racers.get(racerId)?.checkpoint ?? -1;
    const key = JSON.stringify({
      checkpoint,
      url: observation.url,
      title: observation.title,
      bodyText: observation.bodyText,
      controls: observation.controls,
      candidateMilestone: observation.candidateMilestone,
    });
    const previous = this.progressReviews.get(racerId) ??
      Promise.resolve({ finished: false, progressed: false });
    const run = previous
      .catch(() => ({ finished: false, progressed: false }))
      .then(async () => {
        if (this.progressReviewKeys.get(racerId) === key) {
          return { finished: false, progressed: false };
        }
        const outcome = await this.reviewProgressOnce(racerId, observation);
        if (outcome.progressed) this.progressReviewKeys.set(racerId, key);
        return outcome;
      })
      .catch(() => ({ finished: false, progressed: false }));
    this.progressReviews.set(racerId, run);
    void run.then(() => {
      if (this.progressReviews.get(racerId) === run) {
        this.progressReviews.delete(racerId);
      }
    });
    return run.then((outcome) => outcome.finished);
  }

  private async reviewProgressOnce(
    racerId: string,
    observation: WorkerStateObservation,
  ): Promise<ProgressReviewOutcome> {
    const judge = this.dependencies.completionJudge;
    if (!judge) return { finished: false, progressed: false };
    const racer = this.engine.racers.get(racerId);
    if (!racer) return { finished: false, progressed: false };
    if (racer.status === "finished") return { finished: true, progressed: false };
    if (racer.status !== "running") return { finished: false, progressed: false };

    const now = observation.at;
    let progressed = false;
    const nextCheckpoint = racer.checkpoint + 1;
    if (nextCheckpoint <= this.engine.race.checkpointCount) {
      const verified = await judge.judgeCheckpoint({
        task: this.fightMeta.task,
        racerId,
        checkpoint: nextCheckpoint,
        observation,
        candidateMilestone: observation.candidateMilestone,
      });
      if (!verified) return { finished: false, progressed: false };
      const recorded = await this.recordCheckpoint(
        racerId,
        nextCheckpoint,
        now,
        "master",
      );
      if (!recorded) return { finished: false, progressed: false };
      progressed = true;
    }

    const current = this.engine.racers.get(racerId);
    if (!current || current.status !== "running") {
      return { finished: false, progressed };
    }
    if (current.checkpoint !== this.engine.race.checkpointCount) {
      return { finished: false, progressed };
    }

    const completed = await judge.judgeCompletion({
      task: this.fightMeta.task,
      racerId,
      observation,
      candidateMilestone: observation.candidateMilestone,
    });
    if (!completed) return { finished: false, progressed };
    return {
      finished: await this.recordFinish(racerId, now, "master"),
      progressed: true,
    };
  }

  private async syncProgressOnce(racerId: string): Promise<void> {
    const checkpointCount = this.engine.race.checkpointCount;
    for (;;) {
      const racer = this.engine.racers.get(racerId);
      if (!racer || !this.canClaimProgress(racer, Date.now())) return;
      const checkpoint = racer.checkpoint + 1;
      if (checkpoint > checkpointCount) return;
      const verified = await this.dependencies.courseVerifier.verifyCheckpoint({
        raceId: this.engine.race.id,
        racerId,
        courseId: this.engine.race.courseId,
        checkpoint,
        seed: this.engine.race.seed,
        session: this.getSession(racerId),
      });
      if (!verified) return;
      // Re-checked inside the queue so a concurrent report never double-claims.
      const recorded = await this.enqueueLifecycle(async () => {
        const current = this.engine.racers.get(racerId);
        const now = Date.now();
        if (!current || current.checkpoint + 1 !== checkpoint || !this.canClaimProgress(current, now)) {
          return false;
        }
        await this.recordCheckpointInternal(racerId, checkpoint, now);
        return true;
      });
      if (!recorded) return;
    }
  }

  /** Progress is claimable only after persistent sabotage was cleared. */
  private canClaimProgress(racer: Racer, _now: number): boolean {
    if (this.stopped || !this.isLive()) return false;
    return racer.status === "running";
  }

  private async recordFinishInternal(
    racerId: string,
    now: number,
    alreadyVerified = false,
  ): Promise<boolean> {
    const session = this.getSession(racerId);
    if (!alreadyVerified) {
      let verified: boolean;
      try {
        verified = await this.dependencies.courseVerifier.verifyFinish({
          raceId: this.engine.race.id,
          racerId,
          courseId: this.engine.race.courseId,
          seed: this.engine.race.seed,
          session,
        });
      } catch (error) {
        if (isTransientCourseStateError(error)) return false;
        throw error;
      }
      if (!verified) return false;
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
      this.scheduleFinalEvaluation();
    }
    return this.engine.racers.get(racerId)?.status === "finished";
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
        if (point) {
          changes.points.push(point);
          this.touchEvaluation(point.t);
        }
      }
    }
    await this.persistNewEvents();
    this.flush(changes);
    this.scheduleFinalEvaluation();
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
    this.touchEvaluation(typeof report.at === "number" ? report.at : now);
    this.flush({ ...createChanges(), fight: true });
  }

  /** Stores the latest redacted browser state without treating it as proof. */
  recordAgentState(racerId: string, observation: WorkerStateObservation, now = Date.now()): void {
    if (!this.telemetry.recordState(racerId, observation, now)) return;
    this.touchEvaluation(typeof observation.at === "number" ? observation.at : now);
    this.flush({ ...createChanges(), fight: true });
  }

  /** Stores a racer's latest browser capture and bumps its frame seq. */
  recordAgentFrame(racerId: string, frame: CapturedFrame, now = Date.now()): void {
    const keyframes = this.telemetry.keyframeRevision;
    const stored = this.telemetry.recordFrame(racerId, frame, now);
    // Only a sabotage keyframe changes the evaluation.
    if (this.telemetry.keyframeRevision !== keyframes) this.touchEvaluation(stored.capturedAt);
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

  latestAgentState(racerId: string) {
    return this.telemetry.latestState(racerId);
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

  /**
   * The fight's evaluation (docs/frontend-contract.md, "Evaluation").
   * Provisional while the fight runs and until the closing evidence is in,
   * cached until its inputs change; final once finalized, after which only
   * Steel evidence published late can still update it.
   */
  evaluation(now = Date.now()): FightEvaluation {
    if (this.finalEvaluation) return structuredClone(this.finalEvaluation);
    const key = `${this.evaluationVersion}:${this.engine.race.status}:${this.market.status}`;
    if (this.evaluationCache?.key !== key) {
      this.evaluationCache = {
        key,
        evaluation: evaluateFight(this.evaluationInput("provisional", now)),
      };
    }
    return structuredClone(this.evaluationCache.evaluation);
  }

  /** Null before the race starts. `updatedAt` changes whenever the evaluation's inputs do. */
  get evaluationPointer(): FightEvaluationPointer | null {
    if (this.engine.race.startedAt === undefined) return null;
    return {
      status: this.finalEvaluation ? "final" : "provisional",
      updatedAt: this.evaluationUpdatedAt,
    };
  }

  /** Resolves with the final evaluation once it has been stored. */
  whenEvaluationFinal(): Promise<FightEvaluation> {
    if (this.finalEvaluation) return Promise.resolve(structuredClone(this.finalEvaluation));
    return new Promise((resolve) => {
      this.finalWaiters.push(resolve);
    });
  }

  /** A sabotage keyframe (`<stepId>-before` / `<stepId>-after`) with its body. */
  evidenceFrame(racerId: string, key: string): StoredFrame | null {
    if (!this.engine.racers.has(racerId) || typeof key !== "string") return null;
    return this.telemetry.keyframe(racerId, key);
  }

  /**
   * Live Steel sessions only: a fresh fetch of the racer's HLS playlist, read
   * with the key that created the session. Null otherwise or on failure.
   */
  async replayPlaylist(racerId: string): Promise<string | null> {
    if (this.mode !== "live" || !this.engine.racers.has(racerId)) return null;
    try {
      const stored = await this.dependencies.replayStore?.playlist(this.engine.race.id, racerId);
      if (stored) return stored;
      const credentials = this.dependencies.sessionManager.evidence?.(racerId) ?? null;
      if (!credentials) return null;
      return await fetchSteelHlsPlaylist(credentials, { fetch: this.dependencies.steelFetch });
    } catch {
      return null;
    }
  }

  async events() {
    return this.dependencies.eventStore.list(this.engine.race.id);
  }

  async shutdown(): Promise<void> {
    this.stopSteelBackfill();
    await this.shutdownRace();
    this.scheduleFinalEvaluation();
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
    if (trigger.checkpoint >= race.checkpointCount) return null;
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
    if (!provider.getPolicy) return null;
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
    if (!armed) {
      // A course with no pre-completion checkpoint cannot receive sabotage.
      // Do not leave a misleading armed brief in the spectator state.
      this.sabotageBrief = null;
      this.fightMeta.sabotage = null;
    }
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
      completionJudge: this.dependencies.completionJudge,
      reportState: (observation) => {
        try {
          this.recordAgentState(racerId, observation);
        } catch {
          // State telemetry must never interrupt the competitor loop.
        }
      },
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
      this.touchEvaluation(now);
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
        this.telemetry.captureHitKeyframes(racerId, sabotageStepIdOf(event), at);
        this.telemetry.appendLog(racerId, {
          kind: "sabotage",
          text: `Sabotage active: ${this.hazardText()}. Recover it with DOM inspection or a visible recovery action.`,
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
          text: `Sabotage attempt did not apply (${reason}): ${this.hazardText()}`,
          at,
        });
        return;
      }
      case "sabotage_recovered": {
        const cause = String(metadata.cause ?? "manual");
        this.telemetry.markRecovered(racerId, at);
        this.telemetry.appendLog(racerId, {
          kind: "recovered",
          text: `Sabotage cleared: ${RECOVERY_TEXT[cause] ?? "recovered"}`,
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
    this.touchEvaluation(point.t);
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
        this.scheduleFinalEvaluation();
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

  /** Evaluation inputs changed at `at`: invalidate the cache and bump the pointer. */
  private touchEvaluation(at: number): void {
    if (this.finalEvaluation) return;
    this.evaluationVersion += 1;
    const time = Number.isFinite(at) ? at : this.evaluationUpdatedAt;
    this.evaluationUpdatedAt = Math.max(this.evaluationUpdatedAt + 1, time);
    this.lastEvaluationInputAt = Math.max(this.lastEvaluationInputAt ?? time, time);
  }

  /** Finalizes exactly once, after a started race closes. Never blocks or throws. */
  private scheduleFinalEvaluation(): void {
    const race = this.engine.race;
    if (this.finalizeRequested || race.startedAt === undefined) return;
    if (race.status !== "finished" && race.status !== "timed_out") return;
    this.finalizeRequested = true;
    void this.finalizeEvaluation().catch(() => undefined);
  }

  /**
   * Waits for the sessions to be released, reads the Steel evidence (live
   * only, bounded), computes and stores the final evaluation, then marks it
   * final and publishes the new pointer on the fight stream. Steel evidence
   * still missing by then is read again in the background.
   */
  private async finalizeEvaluation(): Promise<void> {
    await this.shutdownRace().catch(() => undefined);
    const [steel] = await Promise.all([
      this.readSteelEvidence().catch(() => undefined),
      this.persistSteelReplays().catch(() => undefined),
    ]);
    const race = this.engine.race;
    // Event times, not the wall clock: history seeded in the past stays in the past.
    const generatedAt = Math.max(
      race.finishedAt ?? this.closedAtValue ?? -Infinity,
      this.lastEvaluationInputAt ?? -Infinity,
    );
    let input: EvaluationInput;
    let evaluation: FightEvaluation;
    try {
      input = this.evaluationInput(
        "final",
        Number.isFinite(generatedAt) ? generatedAt : Date.now(),
        steel,
      );
      evaluation = evaluateFight(input);
    } catch {
      return;
    }
    try {
      await this.dependencies.evaluationStore?.put(structuredClone(evaluation));
    } catch {
      // A storage failure must not keep the evaluation provisional.
    }
    // Captured now, stored in the background: the dataset never delays finality.
    const source = this.datasetSource(evaluation, steel);
    const dataset = this.storeDataset(source);
    this.publishFinalEvaluation(evaluation);
    this.scheduleSteelBackfill(input, source, steel);
    await dataset;
  }

  /** Makes `evaluation` the final one and publishes the new pointer on the fight stream. */
  private publishFinalEvaluation(evaluation: FightEvaluation): void {
    this.finalEvaluation = evaluation;
    this.evaluationCache = null;
    this.evaluationVersion += 1;
    this.evaluationUpdatedAt = Math.max(this.evaluationUpdatedAt + 1, evaluation.generatedAt);
    for (const resolve of this.finalWaiters.splice(0)) resolve(structuredClone(evaluation));
    this.flush({ ...createChanges(), fight: true });
  }

  /**
   * What the fight's training record (docs/training-data.md) is built from:
   * every racer's step records and step screenshots, the engine events, and
   * the Steel evidence the evaluation already read (never fetched again).
   * Null without a dataset store. Never throws.
   */
  private datasetSource(
    evaluation: FightEvaluation,
    steel: ReadonlyMap<string, SteelEvidence> | undefined,
  ): FightCaptureInput | null {
    if (!this.dependencies.datasetStore) return null;
    try {
      const race = this.engine.race;
      const fight = this.fightMeta;
      return {
        raceId: race.id,
        fightNumber: fight.number,
        title: fight.title,
        mode: this.mode,
        task: {
          text: fight.task,
          courseId: race.courseId,
          seed: race.seed,
          checkpointLabels: [...fight.checkpointLabels],
          checkpointCount: race.checkpointCount,
        },
        startedAt: evaluation.startedAt,
        finishedAt: evaluation.finishedAt,
        evaluation,
        events: [...this.engine.events],
        racers: [...this.engine.racers.keys()].map((racerId, index) => ({
          racerId,
          agent: this.agentIdentity(index, racerId),
          steps: this.telemetry.stepRecords(racerId),
          frame: (step: number) => this.telemetry.stepFrame(racerId, step),
          steelRaw: steel?.get(racerId)?.raw ?? null,
        })),
      };
    } catch {
      // The dataset must never break the race or hold up its evaluation.
      return null;
    }
  }

  /**
   * Hands a training record and its files (step screenshots, raw Steel
   * traces) to the dataset store, where the latest put per fight wins. Never
   * throws and never rejects.
   */
  private storeDataset(source: FightCaptureInput | null): Promise<void> {
    const store = this.dependencies.datasetStore;
    if (!store || !source) return Promise.resolve();
    try {
      const { record, files } = captureFightDataset(source);
      return Promise.resolve(store.put(record, files)).catch(() => undefined);
    } catch {
      // The dataset must never break the race or hold up its evaluation.
      return Promise.resolve();
    }
  }

  /**
   * Steel publishes a released session's traces, and sometimes its recording,
   * seconds to minutes late. Sessions whose trace had no events or whose
   * recording was missing at finalization are read again in the background,
   * once per backfill delay, until nothing is missing. Live mode only.
   */
  private scheduleSteelBackfill(
    input: EvaluationInput,
    dataset: FightCaptureInput | null,
    steel: ReadonlyMap<string, SteelEvidence> | undefined,
  ): void {
    if (!steel || this.steelBackfillStopped) return;
    const backfill: SteelBackfill = {
      input: { ...input, events: [...input.events] },
      dataset,
      steel: new Map(steel),
      finalizedAt: Date.now(),
      next: 0,
      controller: new AbortController(),
    };
    if (this.incompleteSteelRacers(backfill.steel).length === 0) return;
    this.steelBackfill = backfill;
    this.armSteelBackfill(backfill);
  }

  /** Waits for the next backfill delay; the backfill ends after the last. */
  private armSteelBackfill(backfill: SteelBackfill): void {
    if (this.steelBackfill !== backfill) return;
    const after = (this.dependencies.steelBackfillDelaysMs ?? STEEL_BACKFILL_DELAYS_MS)[backfill.next];
    if (typeof after !== "number" || !Number.isFinite(after)) {
      this.steelBackfill = null;
      return;
    }
    backfill.next += 1;
    const timer = setTimeout(() => {
      backfill.timer = undefined;
      void this.runSteelBackfill(backfill).catch(() => undefined);
    }, Math.max(0, backfill.finalizedAt + after - Date.now()));
    timer.unref?.();
    backfill.timer = timer;
  }

  /** Reads the sessions still missing evidence once, and applies whatever is newer. */
  private async runSteelBackfill(backfill: SteelBackfill): Promise<void> {
    const read = await this.readSteelEvidence(this.incompleteSteelRacers(backfill.steel), {
      attempts: 1,
      signal: backfill.controller.signal,
    }).catch(() => undefined);
    // Shut down meanwhile: nothing more is applied or scheduled.
    if (this.steelBackfill !== backfill) return;
    let changed = false;
    for (const [racerId, evidence] of read ?? []) {
      const previous = backfill.steel.get(racerId);
      const merged = mergeSteelEvidence(previous, evidence);
      if (merged && merged !== previous) {
        backfill.steel.set(racerId, merged);
        changed = true;
      }
    }
    if (changed) await this.applySteelBackfill(backfill);
    if (this.incompleteSteelRacers(backfill.steel).length > 0) {
      this.armSteelBackfill(backfill);
    } else if (this.steelBackfill === backfill) {
      this.steelBackfill = null;
    }
  }

  /**
   * Re-derives the final evaluation from the input it was computed from, with
   * the newer Steel evidence, stores and publishes it (it stays final), and
   * stores the fight's dataset record again with the new traces.
   */
  private async applySteelBackfill(backfill: SteelBackfill): Promise<void> {
    let evaluation: FightEvaluation;
    try {
      evaluation = evaluateFight({
        ...backfill.input,
        agents: backfill.input.agents.map((agent) => ({
          ...agent,
          steel: steelInput(backfill.steel.get(agent.racerId)),
        })),
      });
    } catch {
      return;
    }
    try {
      await this.dependencies.evaluationStore?.put(structuredClone(evaluation));
    } catch {
      // A storage failure must not hold back the newer evidence.
    }
    const source = backfill.dataset;
    if (source) {
      void this.storeDataset({
        ...source,
        evaluation,
        racers: source.racers.map((racer) => ({
          ...racer,
          steelRaw: backfill.steel.get(racer.racerId)?.raw ?? null,
        })),
      });
    }
    void this.persistSteelReplays().catch(() => undefined);
    this.publishFinalEvaluation(evaluation);
  }

  /** Copies provider-owned HLS media into the configured durable replay store. */
  private async persistSteelReplays(): Promise<void> {
    const store = this.dependencies.replayStore;
    if (this.mode !== "live" || !store) return;
    await Promise.all([...this.engine.racers.keys()].map(async (racerId) => {
      if (await store.playlist(this.engine.race.id, racerId)) return;
      const credentials = this.steelCredentials(racerId);
      if (!credentials) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REPLAY_COPY_TIMEOUT_MS);
      timer.unref?.();
      try {
        const artifact = await downloadSteelReplay(credentials, {
          fetch: this.dependencies.steelFetch,
          timeoutMs: this.dependencies.steelEvidenceTimeoutMs ?? STEEL_EVIDENCE_TIMEOUT_MS,
          signal: controller.signal,
        });
        if (artifact) {
          await store.put(this.engine.race.id, racerId, artifact);
        }
      } finally {
        clearTimeout(timer);
      }
    }));
  }

  /** Ends the backfill for good: its timer is cleared and a read in flight aborted. */
  private stopSteelBackfill(): void {
    this.steelBackfillStopped = true;
    const backfill = this.steelBackfill;
    this.steelBackfill = null;
    if (backfill?.timer) clearTimeout(backfill.timer);
    backfill?.controller.abort();
  }

  /** Racers with a Steel session whose trace had no events or whose recording was missing. */
  private incompleteSteelRacers(steel: ReadonlyMap<string, SteelEvidence>): string[] {
    return [...this.engine.racers.keys()].filter((racerId) =>
      !steelEvidenceComplete(steel.get(racerId)) && this.steelCredentials(racerId) !== null);
  }

  /** The racer's Steel session and the key that created it; null without one. */
  private steelCredentials(racerId: string): SteelSessionCredentials | null {
    try {
      return this.dependencies.sessionManager.evidence?.(racerId) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Live mode: the Steel traces and replay start of each racer (default:
   * every racer), within the overall budget. What is missing is read again
   * while the budget lasts, up to `attempts`; `signal` ends the read early.
   */
  private async readSteelEvidence(
    racerIds: readonly string[] = [...this.engine.racers.keys()],
    options: { attempts?: number; signal?: AbortSignal } = {},
  ): Promise<Map<string, SteelEvidence> | undefined> {
    const manager = this.dependencies.sessionManager;
    if (this.mode !== "live" || typeof manager.evidence !== "function") return undefined;
    const timeoutMs = this.dependencies.steelEvidenceTimeoutMs ?? STEEL_EVIDENCE_TIMEOUT_MS;
    const retryMs = Math.max(10, this.dependencies.steelEvidenceRetryMs ?? STEEL_EVIDENCE_RETRY_MS);
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const collected = new Map<string, SteelEvidence>();
    const work = Promise.all(racerIds.map(async (racerId) => {
      const credentials = this.steelCredentials(racerId);
      if (!credentials) return;
      // A just-released session may still be publishing its traces and
      // recording, so what is missing is fetched again while the budget
      // lasts. Progress is kept as it arrives, so the deadline never
      // discards what was read.
      await collectSteelEvidence(credentials, {
        fetch: this.dependencies.steelFetch,
        signal,
        attempts: options.attempts ?? Math.max(1, Math.floor(timeoutMs / retryMs)),
        retryMs,
        onProgress: (evidence) => {
          collected.set(racerId, evidence);
        },
      });
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      if (signal.aborted) resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    try {
      await Promise.race([work.then(() => undefined, () => undefined), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
    return new Map(collected);
  }

  private evaluationInput(
    status: EvaluationStatus,
    now: number,
    steel?: ReadonlyMap<string, SteelEvidence>,
  ): EvaluationInput {
    const race = this.engine.race;
    const fight = this.fightMeta;
    const closed = race.status === "finished" || race.status === "timed_out";
    const agents = [...this.engine.racers.keys()].map((racerId, index): EvaluationAgentInput => {
      const telemetry = this.telemetry.racer(racerId);
      const stats = this.telemetry.traceStats(racerId);
      return {
        racerId,
        agent: this.agentIdentity(index, racerId),
        steps: telemetry.step,
        maxSteps: telemetry.maxSteps,
        errors: stats.errors,
        loops: stats.loops,
        trace: this.telemetry.trace(racerId),
        keyframes: this.telemetry.keyframes(racerId),
        steel: steelInput(steel?.get(racerId)),
      };
    });
    return {
      raceId: race.id,
      number: fight.number,
      title: fight.title,
      task: fight.task,
      courseId: race.courseId,
      mode: this.mode,
      status,
      now,
      startedAt: race.startedAt ?? null,
      finishedAt: closed ? race.finishedAt ?? this.closedAtValue ?? null : null,
      winnerRacerId: race.winnerRacerId ?? null,
      voided: this.market.status === "unresolved",
      checkpointCount: race.checkpointCount,
      checkpointLabels: [...fight.checkpointLabels],
      sabotagePlan: race.sabotagePlan ?? null,
      events: this.engine.events,
      priceHistory: this.telemetry.priceHistory(),
      openingPrices: this.openingPrices,
      agents,
    };
  }

  private agentIdentity(index: number, racerId: string): AgentIdentity {
    const agent = this.fightMeta.agents[index];
    return agent
      ? { ...agent }
      : { key: racerId, name: racerId, provider: "unknown", model: "unknown" };
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

/** A session's Steel evidence as the evaluator reads it; null when none was read. */
function steelInput(evidence: SteelEvidence | undefined): EvaluationSteelInput | null {
  return evidence
    ? {
        traceAvailable: evidence.trace !== null,
        replayAvailable: evidence.replayAvailable,
        trace: evidence.trace ?? [],
        replayStart: evidence.replayStart,
      }
    : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
