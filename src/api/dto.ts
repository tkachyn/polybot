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
export type SabotageStepState = "armed" | "fired" | "recovered" | "expired";

export type SabotageTier = "basic" | "intermediate" | "difficult";

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
  /** Tier of the armed race-wide plan. Null until armed or when not revealed. */
  tier: SabotageTier | null;
  /** Ordered master-selected steps, each triggered independently per racer. */
  steps: SabotageStepSummary[];
};

export type SabotageStepSummary = {
  index: number;
  stepId: string;
  checkpoint: number;
  checkpointLabel: string;
  state: SabotageStepState;
  firedAt: number | null;
  recoveredAt: number | null;
  hitRacerIds: string[];
  hazardType: HazardType | null;
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
  /** Last browser pointer position used for a click or text input. */
  cursor?: CursorPosition;
};

export type FrameInfo = {
  /** Increments with each new capture. */
  seq: number;
  capturedAt: number;
  contentType: string;
};

export type CursorPosition = {
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  action: "click" | "type";
};

export type BrowserView = {
  /** Browser session lifecycle, independent of the fight lifecycle. */
  status: "pending" | "live" | "released" | "unavailable";
  /** Read-only Steel debug URL; null when not currently viewable. */
  viewerUrl: string | null;
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
  /** Read-only live browser view, with frame capture as the fallback. */
  browserView: BrowserView;
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
  /** Present once the fight has started; refetch the evaluation when `updatedAt` changes. */
  evaluation?: FightEvaluationPointer | null;
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

/** One judge's mark-to-market result in a single fight. */
export type TraderLeaderboardRow = {
  rank: number;
  userId: string;
  displayName: string;
  /** Current fight P/L, including the value of open positions. */
  pnl: number;
  /** pnl / buy cost. Null until the judge places a buy. */
  returnPct: number | null;
  wagered: number;
  openPositions: number;
};

export type TraderLeaderboardResponse = {
  serverTime: number;
  raceId: string;
  rows: TraderLeaderboardRow[];
};

export type ServerMeta = {
  serverTime: number;
  mode: ServerMode;
  /** Audience-demo safeguards, including locked equal bankrolls. */
  demoMode: boolean;
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
// Evaluation (rules: docs/frontend-contract.md, "Evaluation")
// ---------------------------------------------------------------------------

/** How an agent handled one sabotage hit. `cut_short` hits are never scored. */
export type ReactionLabel =
  | "immune"
  | "recovered"
  | "deceived"
  | "stalled"
  | "derailed"
  | "cut_short";

export type AgentOutcome = "won" | "finished" | "failed" | "timed_out" | "stopped";

export type EvaluationStatus = "provisional" | "final";

/** Why a browser action could not complete. */
export type BlockedBy = "modal" | "disabled" | "hidden" | "missing" | "timeout";

/** A stored keyframe: GET /api/fights/:raceId/agents/:racerId/evidence/:key */
export type EvidenceFrame = {
  key: string;
  capturedAt: number;
  contentType: string;
};

/** One competitor step, with browser-side evidence. */
export type TraceEntry = {
  step: number;
  at: number;
  kind: "action" | "error" | "note";
  text: string;
  url: string | null;
  targetRole: string | null;
  targetText: string | null;
  /** The step clicked a planted decoy. */
  decoy: boolean;
  blockedBy: BlockedBy | null;
};

/** One Steel Agent Traces event, normalised. */
export type SteelTraceEntry = {
  at: number;
  /** "click" | "input" | "navigate" | "scroll" | "drag" | "error" | ... */
  type: string;
  /** Accessible name or visible text of the target. */
  label: string | null;
  role: string | null;
  selector: string | null;
  url: string | null;
  /** The target was a planted decoy. */
  decoy: boolean;
};

export type SabotageReaction = {
  stepId: string;
  /** 1-based position in the fight's sabotage sequence. */
  stepIndex: number;
  /** Preset label, e.g. "Plant a decoy control". */
  label: string;
  hazardType: HazardType;
  tier: SabotageTier;
  checkpoint: number;
  checkpointLabel: string;
  appliedAt: number;
  /** When the hazard itself expired (engine recovery), if it did. */
  expiredAt: number | null;
  /** First verified progress after the hit: the next checkpoint or the finish. */
  progressedAt: number | null;
  reaction: ReactionLabel;
  /** Delay beyond the agent's normal pace. Null when it never progressed. */
  timeLostMs: number | null;
  actionsInWindow: number;
  errorsInWindow: number;
  /** Clicked a planted decoy inside the window (runner or Steel evidence). */
  deceived: boolean;
  /** The first step taken after the hit. */
  firstResponse: string | null;
  /** One plain-language sentence explaining the label. */
  explanation: string;
  /** 0-100; null for cut_short. */
  score: number | null;
  evidence: {
    before: EvidenceFrame | null;
    after: EvidenceFrame | null;
    /** Seconds into the Steel replay where the hit happens. Null without a replay. */
    replayOffsetSec: number | null;
  };
};

export type AgentCrowdSignal = {
  openingYes: number;
  /** YES price just before the agent's first sabotage hit. */
  beforeFirstHitYes: number | null;
  /** YES price 30 s after that hit, or the latest price before then. */
  afterFirstHitYes: number | null;
  /** YES price when the fight resolved (or the latest while live). */
  finalYes: number;
};

export type AgentEvaluation = {
  racerId: string;
  agent: AgentIdentity;
  outcome: AgentOutcome;
  /** A verified finish. */
  success: boolean;
  /** Start to verified finish; null when it did not finish. */
  durationMs: number | null;
  checkpointsReached: number;
  checkpointCount: number;
  /** Actions used. */
  steps: number;
  maxSteps: number;
  errors: number;
  /** Episodes of three or more identical consecutive steps. */
  loops: number;
  /** Median time between verified progress events outside sabotage windows. */
  paceMs: number | null;
  sabotage: SabotageReaction[];
  /** Mean reaction score over scored hits; null when never scored. */
  robustness: number | null;
  /** One sentence summarising the run. */
  summary: string;
  crowd: AgentCrowdSignal;
  /** Oldest first, at most 500 steps. */
  trace: TraceEntry[];
  steel: {
    /** Traces and recordings exist for live Steel sessions only. */
    traceAvailable: boolean;
    replayAvailable: boolean;
    /** Oldest first, at most 300 events. */
    trace: SteelTraceEntry[];
  };
};

export type EvaluatedSabotageStep = {
  stepId: string;
  index: number;
  label: string;
  hazardType: HazardType;
  tier: SabotageTier;
  checkpoint: number;
  checkpointLabel: string;
};

export type FightEvaluation = {
  raceId: string;
  number: number;
  title: string;
  task: string;
  courseId: string;
  /** Simulated fights run scripted agents, not real models. */
  mode: ServerMode;
  status: EvaluationStatus;
  generatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  winnerRacerId: string | null;
  voided: boolean;
  sabotageSteps: EvaluatedSabotageStep[];
  /** Exactly four, racer order. */
  agents: AgentEvaluation[];
  /** Plain-language findings, most notable first (at most 6). */
  findings: string[];
};

export type FightEvaluationPointer = {
  status: EvaluationStatus;
  updatedAt: number;
};

export type FightEvaluationResponse = {
  serverTime: number;
  evaluation: FightEvaluation;
};

export type RobustnessCell = {
  /** Scored hits (cut_short excluded). */
  hits: number;
  immune: number;
  recovered: number;
  deceived: number;
  stalled: number;
  derailed: number;
  /** (immune + recovered + deceived) / hits; null when hits = 0. */
  survivalRate: number | null;
  /** Mean over hits that progressed. */
  meanTimeLostMs: number | null;
  meanScore: number | null;
};

export type RobustnessRow = {
  agent: AgentIdentity;
  /** Final evaluations this agent appears in. */
  fights: number;
  wins: number;
  successRate: number;
  meanRobustness: number | null;
  overall: RobustnessCell;
  byHazard: Partial<Record<HazardType, RobustnessCell>>;
};

export type RobustnessMatrixResponse = {
  serverTime: number;
  windowDays: number;
  since: number;
  mode: ServerMode | "all";
  /** Hazard columns with at least one scored hit, in catalogue order. */
  hazards: HazardType[];
  /** Sorted by meanRobustness (nulls last), then successRate. */
  rows: RobustnessRow[];
  /** Final evaluations included. */
  evaluations: number;
};

/** One line of GET /api/evaluations/export.jsonl */
export type EvaluationExportRow = {
  schemaVersion: 1;
  raceId: string;
  fightNumber: number;
  mode: ServerMode;
  task: string;
  courseId: string;
  startedAt: number | null;
  finishedAt: number | null;
  sabotageSteps: EvaluatedSabotageStep[];
  agent: AgentIdentity;
  outcome: AgentOutcome;
  success: boolean;
  durationMs: number | null;
  steps: number;
  errors: number;
  loops: number;
  robustness: number | null;
  sabotage: Array<Omit<SabotageReaction, "evidence">>;
  trace: TraceEntry[];
  steelTrace: SteelTraceEntry[];
  crowd: AgentCrowdSignal;
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

/** GET /api/fights/:raceId/traders/stream */
export type TraderStreamEvents = {
  standings: TraderLeaderboardResponse;
};
