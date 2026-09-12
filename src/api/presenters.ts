/**
 * Pure mappings from backend state to the spectator DTOs in ./dto.ts. Every
 * derivation listed in docs/frontend-contract.md lives here. Nothing in this
 * module mutates its inputs.
 */
import type {
  FightMetadata,
  RaceCoordinator,
  SabotageStatus,
} from "../application/race-coordinator.js";
import type { RaceStatus, Racer } from "../domain/types.js";
import type { CreditLedger, CreditLedgerEntry } from "../wallet/credit-ledger.js";
import type {
  Account,
  AccountLifetime,
  AgentCheckpointState,
  AgentIdentity,
  CheckpointInfo,
  FightAgentDetail,
  FightAgentSummary,
  FightDetail,
  FightDetailResponse,
  FightListResponse,
  FightSettlementLine,
  FightStatus,
  FightSummary,
  FrameInfo,
  LeaderboardResponse,
  LeaderboardRow,
  LedgerEntry,
  MyFightResponse,
  Portfolio,
  Position,
  RaceStatusDTO,
  SabotageDetail,
  SabotageSummary,
  SabotageStepSummary,
  ServerMeta,
  ServerMode,
} from "./dto.js";
import type { UserRecord } from "./users.js";

const PRECISION = 1_000_000;
export const HISTORY_LIMIT = 200;
export const LEADERBOARD_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

export function round(value: number): number {
  return Math.round(value * PRECISION) / PRECISION;
}

export type PresentOptions = {
  now: number;
  showSabotageUpfront: boolean;
};

// ---------------------------------------------------------------------------
// Fights
// ---------------------------------------------------------------------------

export function fightStatusOf(raceStatus: RaceStatus): FightStatus {
  switch (raceStatus) {
    case "starting":
      return "upcoming";
    case "finished":
    case "timed_out":
      return "resolved";
    default:
      return "live";
  }
}

function isActive(racer: Racer): boolean {
  return racer.status === "running" || racer.status === "recovering";
}

/**
 * Active racer with c ≥ 1 cleared: (now - startedAt) / c × (N - c); c = N
 * (awaiting finish): 0; c = 0 or not active: null.
 */
export function racerEtaMs(
  racer: Pick<Racer, "status" | "checkpoint" | "startedAt">,
  checkpointCount: number,
  now: number,
): number | null {
  if (!isActive(racer as Racer) || racer.startedAt === undefined) return null;
  const cleared = racer.checkpoint;
  if (cleared >= checkpointCount) return 0;
  if (cleared < 1) return null;
  const elapsed = Math.max(0, now - racer.startedAt);
  return Math.round((elapsed / cleared) * (checkpointCount - cleared));
}

/** now + fastest ETA, clamped to closesAt; null when unknown or not live. */
export function estimateResolutionAt(
  status: FightStatus,
  etas: Array<number | null>,
  now: number,
  closesAt: number | null,
): number | null {
  if (status !== "live") return null;
  const known = etas.filter((eta): eta is number => eta !== null);
  if (known.length === 0) return null;
  const estimate = now + Math.min(...known);
  return closesAt === null ? estimate : Math.min(estimate, closesAt);
}

export function agentFor(fight: Pick<FightMetadata, "agents">, racerIndex: number, racerId: string): AgentIdentity {
  const agent = fight.agents[racerIndex];
  return agent
    ? { ...agent }
    : { key: racerId, name: racerId, provider: "unknown", model: "unknown" };
}

/** Sabotage text is hidden until the fight is live when not shown upfront. */
export function isSabotageRevealed(status: FightStatus, showSabotageUpfront: boolean): boolean {
  return showSabotageUpfront || status !== "upcoming";
}

type FightView = {
  coordinator: RaceCoordinator;
  fight: FightMetadata;
  status: FightStatus;
  racers: Racer[];
  prices: Record<string, number>;
  opening: Record<string, number>;
  sabotage: SabotageStatus | null;
  now: number;
  showSabotageUpfront: boolean;
};

function inspect(coordinator: RaceCoordinator, options: PresentOptions): FightView {
  return {
    coordinator,
    fight: coordinator.fight,
    status: fightStatusOf(coordinator.engine.race.status),
    racers: coordinator.market.racerIds.map((racerId) => {
      const racer = coordinator.engine.racers.get(racerId);
      if (!racer) throw new Error(`racer ${racerId} is missing`);
      return racer;
    }),
    prices: coordinator.market.pricesSnapshot(),
    opening: coordinator.openingPrices,
    sabotage: coordinator.sabotage,
    now: options.now,
    showSabotageUpfront: options.showSabotageUpfront,
  };
}

function agentSummary(view: FightView, racer: Racer, index: number): FightAgentSummary {
  const yes = view.prices[racer.racerId] ?? 0;
  return {
    racerId: racer.racerId,
    agent: agentFor(view.fight, index, racer.racerId),
    yes,
    no: round(1 - yes),
    change: round(yes - (view.opening[racer.racerId] ?? yes)),
    checkpoint: racer.checkpoint,
    runStatus: view.coordinator.runStatus(racer.racerId),
    phase: racer.status,
  };
}

function sabotageSummary(view: FightView): SabotageSummary | null {
  const sabotage = view.sabotage;
  if (!sabotage) return null;
  const revealed = isSabotageRevealed(view.status, view.showSabotageUpfront);
  return {
    revealed,
    summary: revealed ? sabotage.plan.summary : null,
    checkpoint: sabotage.plan.checkpoint,
    checkpointLabel: sabotage.checkpointLabel,
    state: sabotage.state,
    firedAt: sabotage.firedAt,
    tier: revealed ? sabotage.tier : null,
    steps: revealed ? sabotage.steps.map(stepSummary) : [],
  };
}

function stepSummary(step: SabotageStatus["steps"][number]): SabotageStepSummary {
  return {
    index: step.index,
    stepId: step.stepId,
    checkpoint: step.checkpoint,
    checkpointLabel: step.checkpointLabel,
    state: step.state,
    firedAt: step.firedAt,
    recoveredAt: step.recoveredAt,
    hitRacerIds: [...step.hitRacerIds],
    hazardType: step.policy.hazardType,
  };
}

function sabotageDetail(view: FightView): SabotageDetail | null {
  const summary = sabotageSummary(view);
  const sabotage = view.sabotage;
  if (!summary || !sabotage) return null;
  return {
    ...summary,
    detail: summary.revealed ? sabotage.plan.detail ?? null : null,
    hazardType: summary.revealed ? sabotage.policy?.hazardType ?? null : null,
    hitRacerIds: [...sabotage.hitRacerIds],
    steps: summary.steps,
  };
}

function fightBase(view: FightView): Omit<FightSummary, "agents" | "sabotage"> {
  const { coordinator, fight, status, now } = view;
  const race = coordinator.engine.race;
  const stats = coordinator.market.stats();
  const startsAt = fight.startsAt;
  // Before the start, project the deadlines from the scheduled start.
  const projectedStart = race.startedAt ?? startsAt;
  const freezesAt = race.targetDurationAt ??
    (projectedStart === null ? null : projectedStart + race.targetDurationMs);
  const closesAt = race.absoluteDeadlineAt ??
    (projectedStart === null ? null : projectedStart + race.absoluteDurationMs);
  const etas = view.racers.map((racer) => racerEtaMs(racer, race.checkpointCount, now));
  return {
    raceId: race.id,
    number: fight.number,
    status,
    raceStatus: race.status as RaceStatusDTO,
    marketStatus: coordinator.market.status,
    title: fight.title,
    createdAt: fight.createdAt,
    startsAt,
    startedAt: race.startedAt ?? null,
    freezesAt,
    closesAt,
    finishedAt: status === "resolved" ? race.finishedAt ?? coordinator.closedAt ?? null : null,
    estimatedResolutionAt: estimateResolutionAt(status, etas, now, closesAt),
    volume: stats.volume,
    traders: stats.traders,
    checkpointCount: race.checkpointCount,
    leaderCheckpoint: Math.max(0, ...view.racers.map((racer) => racer.checkpoint)),
    winnerRacerId: race.winnerRacerId ?? coordinator.market.winnerRacerId ?? null,
    voided: coordinator.market.status === "unresolved",
  };
}

export function presentFightSummary(
  coordinator: RaceCoordinator,
  options: PresentOptions,
): FightSummary {
  const view = inspect(coordinator, options);
  return {
    ...fightBase(view),
    sabotage: sabotageSummary(view),
    agents: view.racers.map((racer, index) => agentSummary(view, racer, index)),
  };
}

function agentDetail(view: FightView, racer: Racer, index: number): FightAgentDetail {
  const { coordinator, fight, now } = view;
  const checkpointCount = coordinator.engine.race.checkpointCount;
  const telemetry = coordinator.racerTelemetry(racer.racerId);
  const sabotageCheckpoint = view.sabotage?.plan.checkpoint ?? null;
  const checkpoints: AgentCheckpointState[] = Array.from({ length: checkpointCount }, (_, i) => {
    const checkpoint = i + 1;
    const clearedAt = telemetry.checkpointClearedAt[i] ?? null;
    return {
      index: checkpoint,
      label: fight.checkpointLabels[i] ?? coordinator.checkpointLabel(checkpoint),
      state: clearedAt !== null || racer.checkpoint >= checkpoint ? "cleared" : "pending",
      isSabotage: sabotageCheckpoint === checkpoint,
      sabotageFired: telemetry.sabotageHitAt !== null &&
        telemetry.sabotageHitCheckpoint === checkpoint,
      clearedAt,
    };
  });
  const frame: FrameInfo | null = telemetry.frame
    ? {
        seq: telemetry.frame.seq,
        capturedAt: telemetry.frame.capturedAt,
        contentType: telemetry.frame.contentType,
      }
    : null;
  const summary = agentSummary(view, racer, index);
  return {
    ...summary,
    openingYes: view.opening[racer.racerId] ?? summary.yes,
    progress: round(Math.min(1, racer.checkpoint / checkpointCount)),
    step: telemetry.step,
    maxSteps: telemetry.maxSteps,
    url: telemetry.url,
    currentAction: telemetry.currentAction,
    etaMs: racerEtaMs(racer, checkpointCount, now),
    startedAt: racer.startedAt ?? null,
    finishedAt: racer.finishedAt ?? null,
    sabotageHitAt: telemetry.sabotageHitAt,
    recoveredAt: telemetry.recoveredAt,
    checkpoints,
    log: telemetry.log,
    frame,
    browserView: coordinator.browserView(racer.racerId),
  };
}

export function presentFightDetail(
  coordinator: RaceCoordinator,
  options: PresentOptions,
): FightDetail {
  const view = inspect(coordinator, options);
  const sabotageCheckpoint = view.sabotage?.plan.checkpoint ?? null;
  const checkpoints: CheckpointInfo[] = view.fight.checkpointLabels.map((label, i) => ({
    index: i + 1,
    label,
    isSabotage: sabotageCheckpoint === i + 1,
  }));
  return {
    ...fightBase(view),
    task: view.fight.task,
    taskDetail: view.fight.taskDetail,
    successCondition: view.fight.successCondition,
    checkpoints,
    sabotage: sabotageDetail(view),
    agents: view.racers.map((racer, index) => agentDetail(view, racer, index)),
  };
}

export function presentFightDetailResponse(
  coordinator: RaceCoordinator,
  options: PresentOptions,
): FightDetailResponse {
  return {
    serverTime: options.now,
    fight: presentFightDetail(coordinator, options),
    priceHistory: coordinator.priceHistory(),
  };
}

const STATUS_ORDER: Record<FightStatus, number> = { live: 0, upcoming: 1, resolved: 2 };

/** Live (newest start first), upcoming (soonest first), resolved (newest first). */
export function compareFights(left: FightSummary, right: FightSummary): number {
  const byStatus = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
  if (byStatus !== 0) return byStatus;
  switch (left.status) {
    case "live":
      return (right.startedAt ?? 0) - (left.startedAt ?? 0) || right.number - left.number;
    case "upcoming":
      return (left.startsAt ?? left.createdAt) - (right.startsAt ?? right.createdAt) ||
        left.number - right.number;
    default:
      return (right.finishedAt ?? 0) - (left.finishedAt ?? 0) || right.number - left.number;
  }
}

export function presentFightList(
  coordinators: readonly RaceCoordinator[],
  options: PresentOptions & { status?: FightStatus },
): FightListResponse {
  const fights = coordinators
    .map((coordinator) => presentFightSummary(coordinator, options))
    .filter((fight) => options.status === undefined || fight.status === options.status)
    .sort(compareFights);
  return { serverTime: options.now, fights };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export type FightInfo = { number: number; title: string; agents: AgentIdentity[] };

export type AccountSources = {
  ledger: CreditLedger;
  coordinators: readonly RaceCoordinator[];
  /** Live or archived fight metadata, used to enrich history rows. */
  fightInfo(raceId: string): FightInfo | undefined;
};

function racerIndex(racerId: string): number {
  const match = /^racer-(\d+)$/.exec(racerId);
  return match ? Number(match[1]) - 1 : -1;
}

export function presentPositions(
  coordinator: RaceCoordinator,
  userId: string,
  fight: FightMetadata = coordinator.fight,
): Position[] {
  const market = coordinator.market;
  const positions = market.positionsFor(userId);
  if (positions.length === 0) return [];
  const fightStatus = fightStatusOf(coordinator.engine.race.status);
  return positions
    .map((position): Position => {
      const index = market.racerIds.indexOf(position.racerId);
      const currentPrice = market.sidePrice(position.racerId, position.side);
      const costBasis = round(position.quantity * position.averagePrice);
      const value = round(position.quantity * currentPrice);
      const pnl = round(value - costBasis);
      return {
        raceId: coordinator.raceId,
        fightNumber: fight.number,
        fightTitle: fight.title,
        fightStatus,
        marketStatus: market.status,
        racerId: position.racerId,
        agent: agentFor(fight, index, position.racerId),
        side: position.side,
        quantity: position.quantity,
        avgPrice: position.averagePrice,
        currentPrice,
        costBasis,
        value,
        pnl,
        pnlPct: costBasis > 0 ? round(pnl / costBasis) : 0,
      };
    })
    .sort((left, right) =>
      left.racerId.localeCompare(right.racerId) || left.side.localeCompare(right.side));
}

export function presentAllPositions(sources: AccountSources, userId: string): Position[] {
  return sources.coordinators.flatMap((coordinator) => presentPositions(coordinator, userId));
}

/**
 * Lifetime totals from the ledger. Buy entries carry negative amounts;
 * withdraw likewise. `loss` entries are zero-amount markers.
 *
 * realizedPnl = sold + won + refunded − cost basis of closed positions, where
 * the closed cost basis is every buy ever made minus the cost basis still held
 * in open positions (`wagered − held`). Selling part of a position leaves its
 * average price unchanged, so the remainder's quantity × avgPrice is exactly
 * the unclosed part of the buy cost (up to 6dp rounding of avgPrice).
 */
export function presentLifetime(entries: readonly CreditLedgerEntry[], held: number): AccountLifetime {
  let deposited = 0;
  let withdrawn = 0;
  let wagered = 0;
  let sold = 0;
  let won = 0;
  let refunded = 0;
  const fights = new Set<string>();
  for (const entry of entries) {
    switch (entry.type) {
      case "deposit":
        deposited += entry.amount;
        break;
      case "withdraw":
        withdrawn += -entry.amount;
        break;
      case "buy":
        wagered += -entry.amount;
        if (entry.raceId) fights.add(entry.raceId);
        break;
      case "sell":
        sold += entry.amount;
        if (entry.raceId) fights.add(entry.raceId);
        break;
      case "payout":
        won += entry.amount;
        break;
      case "refund":
        refunded += entry.amount;
        break;
      default:
        break;
    }
  }
  const closedCostBasis = wagered - held;
  return {
    deposited: round(deposited),
    withdrawn: round(withdrawn),
    wagered: round(wagered),
    sold: round(sold),
    won: round(won),
    refunded: round(refunded),
    realizedPnl: round(sold + won + refunded - closedCostBasis),
    fightsTraded: fights.size,
  };
}

export function presentAccountFrom(
  user: UserRecord,
  balance: number,
  positions: readonly Position[],
  entries: readonly CreditLedgerEntry[],
): Account {
  const held = round(positions.reduce((sum, position) => sum + position.costBasis, 0));
  const positionsValue = round(positions.reduce((sum, position) => sum + position.value, 0));
  return {
    userId: user.userId,
    displayName: user.displayName,
    balance: round(balance),
    held,
    positionsValue,
    equity: round(balance + positionsValue),
    unrealizedPnl: round(positionsValue - held),
    lifetime: presentLifetime(entries, held),
    createdAt: user.createdAt,
  };
}

export function presentAccount(user: UserRecord, sources: AccountSources): Account {
  return presentAccountFrom(
    user,
    sources.ledger.balance(user.userId),
    presentAllPositions(sources, user.userId),
    sources.ledger.entries(user.userId),
  );
}

export function presentLedgerEntry(
  entry: CreditLedgerEntry,
  fightInfo: AccountSources["fightInfo"],
): LedgerEntry {
  const fight = entry.raceId ? fightInfo(entry.raceId) : undefined;
  const agent = fight && entry.racerId
    ? agentFor(fight, racerIndex(entry.racerId), entry.racerId)
    : null;
  return {
    id: entry.id,
    at: entry.at,
    type: entry.type,
    amount: entry.amount,
    balanceAfter: entry.balanceAfter,
    raceId: entry.raceId ?? null,
    fightNumber: fight?.number ?? null,
    fightTitle: fight?.title ?? null,
    racerId: entry.racerId ?? null,
    agent,
    side: entry.side ?? null,
    quantity: entry.quantity ?? null,
    price: entry.price ?? null,
    method: entry.method ?? null,
  };
}

export function presentPortfolio(user: UserRecord, sources: AccountSources): Portfolio {
  const entries = sources.ledger.entries(user.userId);
  const positions = presentAllPositions(sources, user.userId);
  const account = presentAccountFrom(user, sources.ledger.balance(user.userId), positions, entries);
  const history = entries
    .slice(-HISTORY_LIMIT)
    .reverse()
    .map((entry) => presentLedgerEntry(entry, sources.fightInfo));
  return { account, positions, history };
}

export function presentMyFight(
  coordinator: RaceCoordinator,
  userId: string,
  ledger: CreditLedger,
  now: number,
): MyFightResponse {
  const fight = coordinator.fight;
  const market = coordinator.market;
  const settled: FightSettlementLine[] = market.settlementLines()
    .filter((line) => line.userId === userId)
    .map((line) => ({
      racerId: line.racerId,
      agent: agentFor(fight, market.racerIds.indexOf(line.racerId), line.racerId),
      side: line.side,
      quantity: line.quantity,
      avgPrice: line.averagePrice,
      costBasis: line.costBasis,
      settlementPrice: line.settlementPrice,
      payout: line.payout,
      result: line.result,
    }));

  let cost = 0;
  let proceeds = 0;
  let payout = 0;
  for (const entry of ledger.entries(userId)) {
    if (entry.raceId !== coordinator.raceId) continue;
    if (entry.type === "buy") cost += -entry.amount;
    else if (entry.type === "sell") proceeds += entry.amount;
    else if (entry.type === "payout" || entry.type === "refund") payout += entry.amount;
  }
  // net and returnPct describe a settled fight; they stay 0 / null until then.
  const isSettled = market.status === "resolved" || market.status === "unresolved";
  const net = isSettled ? round(proceeds + payout - cost) : 0;
  return {
    serverTime: now,
    raceId: coordinator.raceId,
    open: presentPositions(coordinator, userId, fight),
    settled,
    totals: {
      cost: round(cost),
      proceeds: round(proceeds),
      payout: round(payout),
      net,
      returnPct: isSettled && cost > 0 ? round(net / cost) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Leaderboard and meta
// ---------------------------------------------------------------------------

/** Per-fight leaderboard inputs, kept after the fight is pruned. */
export type LeaderboardRecord = {
  raceId: string;
  finishedAt: number;
  agents: Array<{
    racerId: string;
    agent: AgentIdentity;
    won: boolean;
    /** Finish time from the start, for wins only. */
    finishMs: number | null;
    hit: boolean;
    /** Hit, then cleared a later checkpoint or finished. */
    survived: boolean;
    yesBuyCost: number;
    yesSellProceeds: number;
    yesPayout: number;
  }>;
};

/** Null unless the fight resolved with a winner (not void). */
export function leaderboardRecord(coordinator: RaceCoordinator): LeaderboardRecord | null {
  const race = coordinator.engine.race;
  if (fightStatusOf(race.status) !== "resolved" || coordinator.market.status === "unresolved") {
    return null;
  }
  const finishedAt = race.finishedAt ?? coordinator.closedAt;
  if (finishedAt === null || finishedAt === undefined) return null;
  const fight = coordinator.fight;
  const stats = coordinator.market.stats();
  return {
    raceId: race.id,
    finishedAt,
    agents: coordinator.market.racerIds.map((racerId, index) => {
      const racer = coordinator.engine.racers.get(racerId);
      const telemetry = coordinator.racerTelemetry(racerId);
      const won = race.winnerRacerId === racerId;
      const hit = telemetry.sabotageHitAt !== null;
      const hitAt = telemetry.sabotageHitAt ?? 0;
      const from = telemetry.sabotageHitCheckpoint ?? 0;
      const clearedLater = telemetry.checkpointClearedAt
        .some((at, i) => at !== null && i + 1 > from && at >= hitAt);
      const racerStats = stats.racers[racerId];
      return {
        racerId,
        agent: agentFor(fight, index, racerId),
        won,
        finishMs: won && racer?.finishedAt !== undefined && race.startedAt !== undefined
          ? racer.finishedAt - race.startedAt
          : null,
        hit,
        survived: hit && (racer?.status === "finished" || clearedLater),
        yesBuyCost: racerStats?.yesBuyCost ?? 0,
        yesSellProceeds: racerStats?.yesSellProceeds ?? 0,
        yesPayout: racerStats?.yesPayout ?? 0,
      };
    }),
  };
}

type AgentTally = {
  agent: AgentIdentity;
  latestAt: number;
  fights: number;
  wins: number;
  hits: number;
  survived: number;
  buyCost: number;
  returns: number;
  finishTotal: number;
  finishCount: number;
};

/**
 * Resolved, non-void fights finished in the last 30 days, grouped by
 * agent.key and ranked by win rate, then fights.
 */
export function presentLeaderboard(
  records: readonly LeaderboardRecord[],
  now: number,
): LeaderboardResponse {
  const since = now - LEADERBOARD_WINDOW_DAYS * DAY_MS;
  const tallies = new Map<string, AgentTally>();
  for (const record of records) {
    if (record.finishedAt < since || record.finishedAt > now) continue;
    for (const entry of record.agents) {
      let tally = tallies.get(entry.agent.key);
      if (!tally) {
        tally = {
          agent: { ...entry.agent },
          latestAt: record.finishedAt,
          fights: 0,
          wins: 0,
          hits: 0,
          survived: 0,
          buyCost: 0,
          returns: 0,
          finishTotal: 0,
          finishCount: 0,
        };
        tallies.set(entry.agent.key, tally);
      }
      if (record.finishedAt >= tally.latestAt) {
        tally.agent = { ...entry.agent };
        tally.latestAt = record.finishedAt;
      }
      tally.fights += 1;
      if (entry.won) tally.wins += 1;
      if (entry.hit) tally.hits += 1;
      if (entry.survived) tally.survived += 1;
      tally.buyCost += entry.yesBuyCost;
      tally.returns += entry.yesPayout + entry.yesSellProceeds;
      if (entry.finishMs !== null) {
        tally.finishTotal += entry.finishMs;
        tally.finishCount += 1;
      }
    }
  }
  const rows = [...tallies.values()]
    .map((tally): Omit<LeaderboardRow, "rank"> => ({
      agent: tally.agent,
      fights: tally.fights,
      wins: tally.wins,
      winRate: round(tally.wins / tally.fights),
      sabotageHits: tally.hits,
      sabotageSurvived: tally.survived,
      sabotageSurvival: tally.hits > 0 ? round(tally.survived / tally.hits) : null,
      backerRoi: tally.buyCost > 0 ? round((tally.returns - tally.buyCost) / tally.buyCost) : null,
      avgFinishMs: tally.finishCount > 0 ? Math.round(tally.finishTotal / tally.finishCount) : null,
    }))
    .sort((left, right) =>
      right.winRate - left.winRate ||
      right.fights - left.fights ||
      left.agent.key.localeCompare(right.agent.key))
    .map((row, index) => ({ rank: index + 1, ...row }));
  return { serverTime: now, windowDays: LEADERBOARD_WINDOW_DAYS, since, rows };
}

export function presentMeta(
  options: { mode: ServerMode; showSabotageUpfront: boolean; startingBalance: number },
  now: number,
): ServerMeta {
  return {
    serverTime: now,
    mode: options.mode,
    showSabotageUpfront: options.showSabotageUpfront,
    startingBalance: options.startingBalance,
  };
}
