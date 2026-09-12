import type {
  CreateRaceInput,
  FightMetadata,
  RaceChange,
  RaceCoordinator,
  RaceSnapshot,
} from "../application/race-coordinator.js";
import { normalizeFightMetadata } from "../application/fight-metadata.js";
import { DomainError } from "../domain/errors.js";
import type { SabotagePlan } from "../domain/sabotage.js";
import { InMemoryCreditLedger, type CreditLedger } from "../wallet/credit-ledger.js";
import type { AgentIdentity } from "./dto.js";
import { fightStatusOf, leaderboardRecord, type LeaderboardRecord } from "./presenters.js";
import { UserDirectory } from "./users.js";

/** Operator input for POST /races (see docs/frontend-contract.md). */
export type ApiCreateRaceInput = CreateRaceInput & {
  task: string;
  startUrl: string;
  obstaclesEnabled?: boolean;
  /** ≤ 90 chars. Default: task truncated to 90. */
  title?: string;
  taskDetail?: string;
  successCondition?: string;
  /** Exactly checkpointCount labels. */
  checkpointLabels?: string[];
  /** Requires obstaclesEnabled. */
  sabotage?: SabotagePlan;
  /** Exactly four, unique keys, racer order. */
  agents?: AgentIdentity[];
  /** A future timestamp schedules the fight (upcoming). */
  startsAt?: number;
};

/**
 * Builds one coordinator. It MUST construct the coordinator with
 * `input.fight = context.fight` and `deps.ledger = context.ledger`, so fight
 * numbering and the shared wallet work.
 */
export type CoordinatorFactory = (
  input: ApiCreateRaceInput,
  context: { ledger: CreditLedger; fight: FightMetadata },
) => RaceCoordinator | Promise<RaceCoordinator>;

/**
 * A coordinator change, plus registry lifecycle: `created` once a fight is
 * registered, `removed` when it is deleted (failed start) or pruned.
 */
export type CoordinatorChange = RaceChange | { kind: "created" } | { kind: "removed" };

export type CoordinatorChangeListener = (raceId: string, change: CoordinatorChange) => void;

export type RaceRegistryOptions = {
  fightNumberStart?: number;
  startingBalance?: number;
};

/** Enough of a pruned fight to enrich history and the leaderboard. */
export type ArchivedFight = {
  number: number;
  title: string;
  agents: AgentIdentity[];
  leaderboard: LeaderboardRecord | null;
};

const ARCHIVE_LIMIT = 5_000;

function invalid(message: string): never {
  throw new DomainError("invalid", message);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${name} is required`);
  return value;
}

/** Validates the operator input and returns the normalized fight metadata. */
export function buildFightMetadata(
  input: ApiCreateRaceInput,
  number: number,
  now: number,
): FightMetadata {
  if (!input || typeof input !== "object") invalid("race input is required");
  requireString(input.raceId, "raceId");
  if (input.raceId.length > 128) invalid("raceId must be at most 128 characters");
  requireString(input.courseId, "courseId");
  requireString(input.seed, "seed");
  requireString(input.task, "task");
  requireString(input.startUrl, "startUrl");
  if (!Number.isInteger(input.checkpointCount) || input.checkpointCount < 1) {
    invalid("checkpointCount must be a positive integer");
  }
  if (input.obstaclesEnabled !== undefined && typeof input.obstaclesEnabled !== "boolean") {
    invalid("obstaclesEnabled must be a boolean");
  }
  if (input.sabotage !== undefined && input.sabotage !== null && input.obstaclesEnabled !== true) {
    invalid("sabotage requires obstaclesEnabled: true");
  }
  if (input.startsAt !== undefined && input.startsAt !== null &&
    (typeof input.startsAt !== "number" || !Number.isFinite(input.startsAt))) {
    invalid("startsAt must be a timestamp");
  }
  for (const name of ["targetDurationMs", "absoluteDurationMs"] as const) {
    const value = input[name];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
      invalid(`${name} must be a positive number`);
    }
  }
  // Title ≤ 90, summary ≤ 70, detail ≤ 280, labels === N, 4 unique agents and
  // the sabotage checkpoint range are validated here.
  return normalizeFightMetadata(
    {
      courseId: input.courseId,
      checkpointCount: input.checkpointCount,
      task: input.task,
      fight: {
        number,
        title: input.title,
        task: input.task,
        taskDetail: input.taskDetail,
        successCondition: input.successCondition,
        checkpointLabels: input.checkpointLabels,
        agents: input.agents,
        sabotage: input.sabotage,
        createdAt: now,
        startsAt: input.startsAt ?? null,
      },
    },
    now,
  );
}

/** Owns every fight, the shared wallet and the spectator accounts. */
export class RaceRegistry {
  readonly ledger: CreditLedger;
  readonly users: UserDirectory;

  private readonly races = new Map<string, RaceCoordinator>();
  private readonly unsubscribers = new Map<string, () => void>();
  /** Upcoming fights not yet started, by raceId → startsAt. */
  private readonly scheduled = new Map<string, number>();
  private readonly listeners = new Set<CoordinatorChangeListener>();
  private readonly archive = new Map<string, ArchivedFight>();
  private nextFightNumber: number;

  constructor(
    private readonly factory: CoordinatorFactory,
    options: RaceRegistryOptions = {},
  ) {
    const start = options.fightNumberStart ?? 1;
    if (!Number.isInteger(start) || start < 1) invalid("fightNumberStart must be a positive integer");
    this.nextFightNumber = start;
    this.ledger = new InMemoryCreditLedger();
    this.users = new UserDirectory(this.ledger, {
      startingBalance: options.startingBalance ?? 1_000,
    });
  }

  /**
   * Creates a fight. A future `startsAt` registers and arms it without
   * starting (upcoming); otherwise it is armed and started. A failed start
   * removes the fight and rethrows.
   */
  async create(input: ApiCreateRaceInput, now = Date.now()): Promise<RaceSnapshot> {
    const raceId = input?.raceId;
    if (typeof raceId === "string" && this.races.has(raceId)) {
      throw new DomainError("conflict", `Race ${raceId} already exists`);
    }
    const number = this.nextFightNumber;
    const fight = buildFightMetadata(input, number, now);
    const coordinator = await this.factory(input, { ledger: this.ledger, fight: structuredClone(fight) });
    if (coordinator.raceId !== input.raceId) {
      throw new Error(`factory returned race ${coordinator.raceId} for ${input.raceId}`);
    }
    if (this.races.has(raceId)) {
      await coordinator.shutdown().catch(() => undefined);
      throw new DomainError("conflict", `Race ${raceId} already exists`);
    }
    this.nextFightNumber = Math.max(this.nextFightNumber, number + 1);
    this.register(coordinator);

    const startsAt = input.startsAt;
    try {
      if (typeof startsAt === "number" && startsAt > now) {
        this.scheduled.set(raceId, startsAt);
        await coordinator.arm(now);
        return coordinator.snapshot();
      }
      return await coordinator.prepareAndStart(now);
    } catch (error) {
      this.remove(raceId);
      // Give the number back when nothing was created in between.
      if (this.nextFightNumber === number + 1) this.nextFightNumber = number;
      throw error;
    }
  }

  /** Throws DomainError `not_found`. */
  get(raceId: string): RaceCoordinator {
    const race = this.races.get(raceId);
    if (!race) throw new DomainError("not_found", `Race ${raceId} was not found`);
    return race;
  }

  list(): RaceCoordinator[] {
    return [...this.races.values()];
  }

  /** Number, title and agents of a live or pruned fight, for history rows. */
  fightInfo(raceId: string): Pick<ArchivedFight, "number" | "title" | "agents"> | undefined {
    const race = this.races.get(raceId);
    if (race) {
      const fight = race.fight;
      return { number: fight.number, title: fight.title, agents: fight.agents };
    }
    return this.archive.get(raceId);
  }

  /** Leaderboard records of fights removed by prune(). */
  archivedLeaderboard(): LeaderboardRecord[] {
    return [...this.archive.values()]
      .map((entry) => entry.leaderboard)
      .filter((record): record is LeaderboardRecord => record !== null);
  }

  /** Scheduled start of an upcoming fight that has not been started yet. */
  scheduledStart(raceId: string): number | null {
    return this.scheduled.get(raceId) ?? null;
  }

  /**
   * Starts due scheduled fights (each exactly once), then ticks every fight.
   * A failed scheduled start leaves the fight voided: the coordinator refunds
   * positions and aborts the race.
   */
  async tickAll(now = Date.now()): Promise<void> {
    const due = [...this.scheduled.entries()].filter(([, startsAt]) => startsAt <= now);
    for (const [raceId] of due) this.scheduled.delete(raceId);
    await Promise.all(due.map(async ([raceId]) => {
      const race = this.races.get(raceId);
      if (!race) return;
      try {
        await race.prepareAndStart(now);
      } catch {
        // The coordinator voided the market and aborted the race.
      }
    }));

    const results = await Promise.allSettled(this.list().map((race) => race.tick(now)));
    const failure = results.find((result): result is PromiseRejectedResult =>
      result.status === "rejected");
    if (failure) throw failure.reason;
  }

  subscribe(listener: CoordinatorChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Keeps the newest `maxResolved` resolved fights and archives the rest. */
  prune(maxResolved: number): void {
    const keep = Math.max(0, Math.floor(maxResolved));
    const resolved = this.list()
      .filter((race) => fightStatusOf(race.engine.race.status) === "resolved")
      .sort((left, right) => resolvedAt(right) - resolvedAt(left));
    for (const race of resolved.slice(keep)) {
      const fight = race.fight;
      this.archive.set(race.raceId, {
        number: fight.number,
        title: fight.title,
        agents: fight.agents,
        leaderboard: leaderboardRecord(race),
      });
      this.remove(race.raceId);
      void race.shutdown().catch(() => undefined);
    }
    while (this.archive.size > ARCHIVE_LIMIT) {
      const oldest = this.archive.keys().next().value;
      if (oldest === undefined) break;
      this.archive.delete(oldest);
    }
  }

  async shutdown(): Promise<void> {
    this.scheduled.clear();
    await Promise.allSettled(this.list().map((race) => race.shutdown()));
  }

  private register(coordinator: RaceCoordinator): void {
    const raceId = coordinator.raceId;
    this.races.set(raceId, coordinator);
    this.unsubscribers.set(raceId, coordinator.subscribe((change) => this.emit(raceId, change)));
    this.emit(raceId, { kind: "created" });
  }

  private remove(raceId: string): void {
    if (!this.races.has(raceId)) return;
    this.unsubscribers.get(raceId)?.();
    this.unsubscribers.delete(raceId);
    this.scheduled.delete(raceId);
    this.races.delete(raceId);
    this.emit(raceId, { kind: "removed" });
  }

  private emit(raceId: string, change: CoordinatorChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(raceId, change);
      } catch {
        // A failing subscriber must not break the registry.
      }
    }
  }
}

function resolvedAt(race: RaceCoordinator): number {
  return race.engine.race.finishedAt ?? race.closedAt ?? race.fight.createdAt;
}
