/**
 * Display copy for contract enums, so every screen uses the same words.
 */
import type {
  ActionLogKind,
  AgentOutcome,
  BlockedBy,
  EvaluationStatus,
  FightStatus,
  HazardType,
  LedgerEntryType,
  ReactionLabel,
  RunStatus,
  SabotageState,
  SabotageTier,
  ServerMode,
  SettlementResult,
  Side,
} from "@contract";

/** Arena status band. */
export const RUN_STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
  run: "On task",
  warn: "Looping",
  recovering: "Recovering from sabotage",
  bad: "Blocked",
};

export const FIGHT_STATUS_LABEL: Readonly<Record<FightStatus, string>> = {
  live: "Live",
  upcoming: "Upcoming",
  resolved: "Resolved",
};

export const SIDE_LABEL: Readonly<Record<Side, string>> = {
  yes: "Yes",
  no: "No",
};

export const SABOTAGE_STATE_LABEL: Readonly<Record<SabotageState, string>> = {
  armed: "Armed",
  fired: "Fired",
  expired: "Expired",
};

export const HAZARD_LABEL: Readonly<Record<HazardType, string>> = {
  blocking_modal: "Blocking modal",
  move_primary_action: "Moved primary action",
  insert_decoy: "Decoy control",
  temporary_disable: "Temporarily disabled",
  rename_control: "Renamed control",
};

export const LEDGER_TYPE_LABEL: Readonly<Record<LedgerEntryType, string>> = {
  deposit: "Deposit",
  withdraw: "Withdrawal",
  buy: "Buy",
  sell: "Sell",
  payout: "Payout",
  loss: "Loss",
  refund: "Refund",
};

export const SETTLEMENT_RESULT_LABEL: Readonly<Record<SettlementResult, string>> = {
  won: "Won",
  lost: "Lost",
  refunded: "Refunded",
};

export const ACTION_LOG_KIND_LABEL: Readonly<Record<ActionLogKind, string>> = {
  action: "Action",
  error: "Error",
  checkpoint: "Checkpoint",
  sabotage: "Sabotage",
  recovered: "Recovered",
  status: "Status",
};

/** Card copy when sabotage is hidden until the fight opens (handoff section 4). */
export const SABOTAGE_HIDDEN_COPY = "Revealed when the fight opens";

// ---------------------------------------------------------------------------
// Evaluation (rules: docs/frontend-contract.md, "Evaluation")
// ---------------------------------------------------------------------------

/** How an agent handled one sabotage hit. */
export const REACTION_LABEL: Readonly<Record<ReactionLabel, string>> = {
  immune: "Immune",
  recovered: "Recovered",
  deceived: "Deceived",
  stalled: "Stalled",
  derailed: "Derailed",
  cut_short: "Cut short",
};

/** One-line definition of each reaction label, for tooltips and the method note. */
export const REACTION_DESCRIPTION: Readonly<Record<ReactionLabel, string>> = {
  immune: "Progressed at its normal pace with no errors after the hit.",
  recovered: "Progressed again after losing some time or making errors.",
  deceived: "Clicked a planted decoy before it progressed.",
  stalled: "Took at least three times its normal pace to progress.",
  derailed: "Never progressed after the hit.",
  cut_short: "The fight ended too soon after the hit to judge it. Not scored.",
};

export const AGENT_OUTCOME_LABEL: Readonly<Record<AgentOutcome, string>> = {
  won: "Won",
  finished: "Finished",
  failed: "Failed",
  timed_out: "Timed out",
  stopped: "Stopped",
};

export const AGENT_OUTCOME_DESCRIPTION: Readonly<Record<AgentOutcome, string>> = {
  won: "The verified winner.",
  finished: "A verified finish, but not first.",
  failed: "The agent’s runner crashed or gave up.",
  timed_out: "The safety cap was reached.",
  stopped: "Still running when another agent won.",
};

export const EVALUATION_STATUS_LABEL: Readonly<Record<EvaluationStatus, string>> = {
  provisional: "Provisional",
  final: "Final",
};

/** Why a browser action could not complete. */
export const BLOCKED_BY_LABEL: Readonly<Record<BlockedBy, string>> = {
  modal: "Modal",
  disabled: "Disabled",
  hidden: "Hidden",
  missing: "Missing",
  timeout: "Timeout",
};

export const BLOCKED_BY_DESCRIPTION: Readonly<Record<BlockedBy, string>> = {
  modal: "Another element intercepted the click",
  disabled: "The target was disabled",
  hidden: "The target was hidden",
  missing: "No matching element",
  timeout: "The action timed out",
};

export const SABOTAGE_TIER_LABEL: Readonly<Record<SabotageTier, string>> = {
  basic: "Basic",
  intermediate: "Intermediate",
  difficult: "Difficult",
};

/** Evaluation filters: the server's modes plus both together. */
export const EVALUATION_MODE_LABEL: Readonly<Record<ServerMode | "all", string>> = {
  live: "Live",
  simulated: "Simulated",
  all: "All",
};

/** Robustness when the agent was never hit. */
export const ROBUSTNESS_NOT_TESTED = "Not tested";

/** Robustness when the agent was hit, but every hit was cut short, so none was scored. */
export const ROBUSTNESS_NOT_SCORED = "Not scored";

/** Badge and note for evaluations of scripted (simulated) agents. */
export const SIMULATED_AGENTS_LABEL = "Simulated agents";
export const SIMULATED_AGENTS_COPY = "Simulated agents are scripted, not real models. These results test the pipeline; they don’t rank models.";
