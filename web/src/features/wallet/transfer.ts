/**
 * Wallet transfer rules. Mirrors the server's checks (src/api/users.ts):
 * amounts must be finite, > 0 and at most 100,000 per request, and a
 * withdrawal cannot exceed the available balance. The UI works in cents.
 */
import type { LedgerEntry } from "@contract";
import { formatMoney, isFiniteNumber, roundTo } from "../../lib/format";
import { AMOUNT_MESSAGES, QUICK_AMOUNTS, parseAmount, readAmount, round6 } from "../../lib/order";

export type TransferKind = "deposit" | "withdraw";

export const TRANSFER_KINDS: readonly TransferKind[] = ["deposit", "withdraw"];

/** Per-request cap enforced by the server. */
export const TRANSFER_MAX = 100_000;

/** Quick chips: the bet-slip amounts plus $500. Withdraw adds "Max". */
export const WALLET_QUICK_AMOUNTS: readonly number[] = [...QUICK_AMOUNTS, 500];

export const TRANSFER_VERB: Readonly<Record<TransferKind, string>> = {
  deposit: "Deposit",
  withdraw: "Withdraw",
};

export const TRANSFER_PAST: Readonly<Record<TransferKind, string>> = {
  deposit: "Deposited",
  withdraw: "Withdrew",
};

/** `?tab=` value to a tab. Anything other than "withdraw" reads as deposit. */
export function parseTransferTab(value: string | null | undefined): TransferKind {
  return value === "withdraw" ? "withdraw" : "deposit";
}

/** Floors to whole cents (the Max chip never asks for more than the balance). */
export function floorCents(value: number): number {
  if (!isFiniteNumber(value) || value <= 0) return 0;
  return Math.floor(round6(value) * 100 + 1e-6) / 100;
}

/** The most that can be withdrawn in one request, in whole cents. */
export function maxWithdrawable(balance: number | null | undefined): number {
  return Math.min(TRANSFER_MAX, floorCents(isFiniteNumber(balance) ? balance : 0));
}

export type TransferCheck = {
  /** Amount rounded to cents, or NaN when the input is not a number. */
  amount: number;
  /** First validation failure, or null when the transfer can be sent. */
  error: string | null;
};

/**
 * Validates the amount field. Checked in order: empty / malformed, <= 0,
 * over the per-request cap, and (withdraw only) over the available balance.
 * `balance` null means the account is not loaded yet: the balance check is skipped.
 */
export function validateTransfer(kind: TransferKind, input: string, balance: number | null): TransferCheck {
  // The bet slip reads amounts with the same function and wording.
  const read = readAmount(input);
  if (!Number.isFinite(read.amount)) return { amount: Number.NaN, error: read.error };
  const amount = roundTo(read.amount, 2);
  if (amount <= 0) return { amount, error: AMOUNT_MESSAGES.notPositive };
  if (amount > TRANSFER_MAX) return { amount, error: `The limit is ${formatMoney(TRANSFER_MAX)} per transfer.` };
  if (kind === "withdraw" && balance !== null && amount > round6(Math.max(0, balance))) {
    const max = maxWithdrawable(balance);
    return {
      amount,
      error: max > 0 ? `You can withdraw at most ${formatMoney(max)}.` : "You have no available balance to withdraw.",
    };
  }
  return { amount, error: null };
}

/** CTA label: "Deposit $100.00", or just the verb when the amount is invalid. */
export function transferLabel(kind: TransferKind, check: TransferCheck): string {
  return check.error ? TRANSFER_VERB[kind] : `${TRANSFER_VERB[kind]} ${formatMoney(check.amount)}`;
}

/** Input text for a chip amount: whole numbers stay whole, cents keep two decimals. */
export function amountInputValue(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

/** True when the input already holds `amount` (chip highlight). */
export function inputMatches(input: string, amount: number): boolean {
  const parsed = parseAmount(input);
  return Number.isFinite(parsed) && roundTo(parsed, 2) === roundTo(amount, 2);
}

/**
 * Wallet activity: deposit and withdraw entries from the portfolio history
 * plus entries returned by transfers that the stream has not delivered yet.
 * De-duplicated by id, newest first.
 */
export function walletActivity(history: readonly LedgerEntry[] | null | undefined, extra: readonly LedgerEntry[] = [], limit = 25): LedgerEntry[] {
  const byId = new Map<string, LedgerEntry>();
  for (const entry of [...extra, ...(history ?? [])]) {
    if (entry.type !== "deposit" && entry.type !== "withdraw") continue;
    byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, limit);
}
