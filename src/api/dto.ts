/**
 * Spectator-facing API contract shared by the backend (`src/api`) and the web
 * frontend (`web/`).
 *
 * This module must stay types-only: the frontend imports it with
 * `import type`, so any runtime export here would break the web build.
 *
 * Conventions:
 * - Timestamps are epoch milliseconds from the server clock. Every response
 *   carries `serverTime` so clients can correct for clock skew.
 * - Prices are probabilities in [0, 1]. The UI renders them as cents.
 *   `no` is always `1 - yes` (rounded to 6 decimal places).
 * - Money amounts are virtual arena credits, rounded to 6 decimal places.
 * - Fights always carry exactly four agents, ordered racer-1..racer-4.
 */

export type Side = "yes" | "no";
export type OrderAction = "buy" | "sell";

/** UI-level lifecycle derived from the race status. */
export type FightStatus = "upcoming" | "live" | "resolved";

export type RaceStatusDTO =
  | "starting"
  | "running"
  | "hazards_frozen"
  | "finishing"
  | "finished"
  | "timed_out";

export type RacerPhase =
  | "starting"
  | "ready"
  | "running"
  | "recovering"
  | "finished"
  | "failed"
  | "timed_out";

export type MarketStatusDTO = "open" | "frozen" | "resolved" | "unresolved";

/** run = ON TASK, warn = LOOPING, bad = BLOCKED. */
export type RunStatus = "run" | "warn" | "bad";

export type SabotageState = "armed" | "fired" | "expired";

export type HazardType =
  | "blocking_modal"
  | "move_primary_action"
  | "insert_decoy"
  | "temporary_disable"
  | "rename_control";

export type ServerMode = "live" | "simulated";

export type AgentIdentity = {
  /** Stable identity key. UI colours and monograms are keyed on this. */
  key: string;
  /** Display name, e.g. "GPT-5.2". */
  name: string;
  /** "openai" | "anthropic" | "google" | "xai" | "simulated" */
  provider: string;
  /** Provider model id, or "simulated". */
  model: string;
};

export type OutcomeQuote = {
  racerId: string;
  yes: number;
  no: number;
};

// ---------------------------------------------------------------------------
// Fights
// ---------------------------------------------------------------------------

export type FightAgentSummary = {
  racerId: string;
  agent: AgentIdentity;
  yes: number;
  no: number;
  /** yes - openingYes, in probability units (-1..1). */
  change: number;
  /** Verified checkpoints cleared. */
  checkpoint: number;
  runStatus: RunStatus;
  phase: RacerPhase;
};

export type SabotageSummary = {
  /** False when sabotage is hidden until the fight opens. */
  revealed: boolean;
  /** At most 70 characters. Null when not revealed. */
  summary: string | null;
  /** 1-based checkpoint at which the sabotage fires. */
  checkpoint: number;
  checkpointLabel: string;
  state: SabotageState;
  /** First time the sabotage was applied to any agent. */
  firedAt: number | null;
};

export type FightSummary = {
  raceId: string;
  /** Sequential fight number, displayed zero-padded (#0412). */
  number: number;
  status: FightStatus;
  raceStatus: RaceStatusDTO;
  marketStatus: MarketStatusDTO;
  /** At most 90 characters. */
  title: string;
  /** Null when the fight has no sabotage (obstacles disabled). */
  sabotage: SabotageSummary | null;
  createdAt: number;
  /** Scheduled start for upcoming fights. */
  startsAt: number | null;
  startedAt: number | null;
  /** Target duration: hazards and trading freeze here. */
  freezesAt: number | null;
  /** Absolute safety cap: unresolved fights are voided here. */
  closesAt: number | null;
  /** When the fight resolved (winner verified or cap reached). */
  finishedAt: number | null;
  /** now + fastest agent ETA, clamped to closesAt. Null if unknown. */
  estimatedResolutionAt: number | null;
  /** Credits traded: buy and sell notional. */
  volume: number;
  /** Distinct users who have traded. */
  traders: number;
  checkpointCount: number;
  /** Highest checkpoint cleared by any agent. */
  leaderCheckpoint: number;
  agents: FightAgentSummary[];
  winnerRacerId: string | null;
  /** True when the market resolved unresolved (void, refunded). */
  voided: boolean;
};

export type CheckpointInfo = {
  /** 1-based. */
  index: number;
  label: string;
  isSabotage: boolean;
};

export type AgentCheckpointState = {
  index: number;
  label: string;
  state: "cleared" | "pending";
  isSabotage: boolean;
  /** The sabotage was applied to this agent at this checkpoint. */
  sabotageFired: boolean;
  clearedAt: number | null;
};

export type ActionLogKind =
  | "action"
  | "error"
  | "checkpoint"
  | "sabotage"
  | "recovered"
  | "status";

export type ActionLogEntry = {
  /** Monotonically increasing per agent. */
  seq: number;
  at: number;
  kind: ActionLogKind;
  text: string;
  url: string | null;
};

export type FrameInfo = {
  /** Increments with each new capture. */
  seq: number;
  capturedAt: number;
  contentType: string;
};

export type FightAgentDetail = FightAgentSummary & {
  openingYes: number;
  /** checkpoint / checkpointCount, 0..1. */
  progress: number;
  /** Actions taken so far. */
  step: number;
  /** The agent's action budget. */
  maxSteps: number;
  url: string | null;
  currentAction: string | null;
  etaMs: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  sabotageHitAt: number | null;
  recoveredAt: number | null;
  checkpoints: AgentCheckpointState[];
  /** Oldest first, newest last. Bounded to the latest 60 entries. */
  log: ActionLogEntry[];
  /** Fetch bytes from GET /api/fights/:raceId/agents/:racerId/frame?seq=N */
  frame: FrameInfo | null;
};

export type SabotageDetail = SabotageSummary & {
  /** Longer description. Null when not revealed. */
  detail: string | null;
  /** Null when not revealed or not yet armed. */
  hazardType: HazardType | null;
  hitRacerIds: string[];
};

export type FightDetail = Omit<FightSummary, "agents" | "sabotage"> & {
  task: string;
  taskDetail: string;
  successCondition: string;
  checkpoints: CheckpointInfo[];
  sabotage: SabotageDetail | null;
  agents: FightAgentDetail[];
};

/** One sample of every agent's YES price, keyed by racerId. */
export type PricePoint = {
  t: number;
  prices: Record<string, number>;
};

export type FightListResponse = {
  serverTime: number;
  fights: FightSummary[];
};

export type FightDetailResponse = {
  serverTime: number;
  fight: FightDetail;
  /** Oldest first. */
  priceHistory: PricePoint[];
};

// ---------------------------------------------------------------------------
// Accounts, positions and orders
// ---------------------------------------------------------------------------

export type AccountLifetime = {
  deposited: number;
  withdrawn: number;
  /** Total buy cost. */
  wagered: number;
  /** Total sell proceeds. */
  sold: number;
  /** Total settlement payouts. */
  won: number;
  /** Total void refunds. */
  refunded: number;
  /** sold + won + refunded - cost basis of closed positions. */
  realizedPnl: number;
  fightsTraded: number;
};

export type Account = {
  userId: string;
  displayName: string;
  /** Available credits. */
  balance: number;
  /** Cost basis of open positions. */
  held: number;
  /** Mark-to-market value of open positions. */
  positionsValue: number;
  /** balance + positionsValue. */
  equity: number;
  /** positionsValue - held. */
  unrealizedPnl: number;
  lifetime: AccountLifetime;
  createdAt: number;
};

export type Position = {
  raceId: string;
  fightNumber: number;
  fightTitle: string;
  fightStatus: FightStatus;
  marketStatus: MarketStatusDTO;
  racerId: string;
  agent: AgentIdentity;
  side: Side;
  quantity: number;
  avgPrice: number;
  /** Current price of this side. */
  currentPrice: number;
  costBasis: number;
  value: number;
  pnl: number;
  /** pnl / costBasis. */
  pnlPct: number;
};

export type LedgerEntryType =
  | "deposit"
  | "withdraw"
  | "buy"
  | "sell"
  | "payout"
  | "loss"
  | "refund";

export type WalletMethodId = "virtual";

export type LedgerEntry = {
  id: string;
  at: number;
  type: LedgerEntryType;
  /** Signed change to the available balance. Loss entries are 0. */
  amount: number;
  balanceAfter: number;
  raceId: string | null;
  fightNumber: number | null;
  fightTitle: string | null;
  racerId: string | null;
  agent: AgentIdentity | null;
  side: Side | null;
  quantity: number | null;
  /** Execution price, or average price for settlement entries. */
  price: number | null;
  method: WalletMethodId | null;
};

export type Portfolio = {
  account: Account;
  positions: Position[];
  /** Newest first, bounded to the latest 200 entries. */
  history: LedgerEntry[];
};

export type PortfolioResponse = Portfolio & { serverTime: number };

export type AccountResponse = {
  serverTime: number;
  account: Account;
};

export type EnsureUserRequest = {
  userId?: string;
  displayName?: string;
};

export type WalletTransferRequest = {
  amount: number;
  method: WalletMethodId;
};

export type WalletTransferResponse = {
  serverTime: number;
  account: Account;
  entry: LedgerEntry;
};

export type OrderRequest = {
  userId: string;
  racerId: string;
  side: Side;
  action: OrderAction;
  /** Positive integer number of shares. */
  quantity: number;
  /**
   * Price guard. For buys, rejected with `price_moved` if the current price
   * is above the limit. For sells, rejected if it is below.
   */
  limitPrice?: number;
  /** Idempotency key. A repeat returns the original receipt. */
  clientOrderId?: string;
};

export type OrderReceipt = {
  orderId: string;
  clientOrderId: string | null;
  raceId: string;
  racerId: string;
  side: Side;
  action: OrderAction;
  quantity: number;
  price: number;
  total: number;
  /** quantity * 1.00 for buys; 0 for sells. */
  payoutIfWin: number;
  executedAt: number;
};

export type OrderResponse = {
  serverTime: number;
  receipt: OrderReceipt;
  account: Account;
  quotes: OutcomeQuote[];
};

export type SettlementResult = "won" | "lost" | "refunded";

export type FightSettlementLine = {
  racerId: string;
  agent: AgentIdentity;
  side: Side;
  quantity: number;
  avgPrice: number;
  costBasis: number;
  /** 1 or 0; null for a voided fight. */
  settlementPrice: number | null;
  payout: number;
  result: SettlementResult;
};

export type MyFightResponse = {
  serverTime: number;
  raceId: string;
  open: Position[];
  settled: FightSettlementLine[];
  totals: {
    /** Sum of buy costs in this fight. */
    cost: number;
    /** Sum of sell proceeds in this fight. */
    proceeds: number;
    /** Settlement payouts plus refunds. */
    payout: number;
    /** proceeds + payout - cost (settled fights only). */
    net: number;
    /** net / cost. Null when cost is 0. */
    returnPct: number | null;
  };
};

// ---------------------------------------------------------------------------
// Leaderboard and meta
// ---------------------------------------------------------------------------

export type LeaderboardRow = {
  rank: number;
  agent: AgentIdentity;
  fights: number;
  wins: number;
  /** wins / fights. */
  winRate: number;
  sabotageHits: number;
  sabotageSurvived: number;
  /** sabotageSurvived / sabotageHits. Null when never hit. */
  sabotageSurvival: number | null;
  /** (yes payouts + yes sell proceeds - yes buy cost) / yes buy cost. */
  backerRoi: number | null;
  /** Mean finish time of wins, measured from the start. */
  avgFinishMs: number | null;
};

export type LeaderboardResponse = {
  serverTime: number;
  windowDays: number;
  since: number;
  rows: LeaderboardRow[];
};

export type ServerMeta = {
  serverTime: number;
  mode: ServerMode;
  showSabotageUpfront: boolean;
  startingBalance: number;
};

export type ApiErrorCode =
  | "invalid"
  | "not_found"
  | "conflict"
  | "market_closed"
  | "price_moved"
  | "insufficient_balance"
  | "insufficient_position";

export type ApiError = {
  error: string;
  code: ApiErrorCode;
};

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

/** GET /api/fights/stream */
export type FightListStreamEvents = {
  fights: FightListResponse;
};

/** GET /api/fights/:raceId/stream */
export type FightStreamEvents = {
  /** Sent first on every (re)connect. Replaces all client state. */
  snapshot: FightDetailResponse;
  /** Throttled full state, without price history. */
  fight: { serverTime: number; fight: FightDetail };
  /** One appended chart sample. */
  price: { serverTime: number; point: PricePoint };
};

/** GET /api/users/:userId/stream */
export type UserStreamEvents = {
  portfolio: PortfolioResponse;
};
