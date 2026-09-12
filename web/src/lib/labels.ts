/**
 * Display copy for contract enums, so every screen uses the same words.
 */
import type {
  ActionLogKind,
  FightStatus,
  HazardType,
  LedgerEntryType,
  RunStatus,
  SabotageState,
  SettlementResult,
  Side,
} from "@contract";

/** Arena status band. */
export const RUN_STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
  run: "On task",
  warn: "Looping",
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
