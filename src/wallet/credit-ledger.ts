import type {
  LedgerEntryType,
  Side,
  WalletMethodId,
} from "../api/dto.js";
import { DomainError } from "../domain/errors.js";

const PRECISION = 1_000_000;

function round(value: number): number {
  return Math.round(value * PRECISION) / PRECISION;
}

/** Descriptive fields attached to a ledger entry. */
export type LedgerMemo = {
  type: LedgerEntryType;
  raceId?: string;
  racerId?: string;
  side?: Side;
  quantity?: number;
  /** Execution price, or average price for settlement entries. */
  price?: number;
  method?: WalletMethodId;
  /** Entry timestamp. Defaults to Date.now(). */
  at?: number;
};

export type CreditLedgerEntry = {
  id: string;
  at: number;
  userId: string;
  type: LedgerEntryType;
  /** Signed change to the available balance. Loss entries are 0. */
  amount: number;
  balanceAfter: number;
  raceId?: string;
  racerId?: string;
  side?: Side;
  quantity?: number;
  price?: number;
  method?: WalletMethodId;
};

/**
 * One virtual-credit wallet per user, shared by every market. Amounts are
 * unsigned inputs; the stored entry carries the signed balance change.
 */
export interface CreditLedger {
  balance(userId: string): number;
  /** Adds credits. Throws DomainError `invalid` for non-finite or negative amounts. */
  credit(userId: string, amount: number, memo: LedgerMemo): CreditLedgerEntry;
  /** Removes credits. Throws DomainError `insufficient_balance` when short. */
  debit(userId: string, amount: number, memo: LedgerMemo): CreditLedgerEntry;
  /** Appends a zero-amount entry, e.g. a settlement `loss`. */
  record(userId: string, memo: LedgerMemo): CreditLedgerEntry;
  /** Oldest first. */
  entries(userId: string): CreditLedgerEntry[];
  allUserIds(): string[];
}

export class InMemoryCreditLedger implements CreditLedger {
  private readonly balances = new Map<string, number>();
  private readonly ledger = new Map<string, CreditLedgerEntry[]>();

  balance(userId: string): number {
    return this.balances.get(userId) ?? 0;
  }

  credit(userId: string, amount: number, memo: LedgerMemo): CreditLedgerEntry {
    const value = this.assertAmount(amount);
    return this.append(userId, value, memo);
  }

  debit(userId: string, amount: number, memo: LedgerMemo): CreditLedgerEntry {
    const value = this.assertAmount(amount);
    if (this.balance(userId) < value) {
      throw new DomainError("insufficient_balance", "insufficient virtual credits");
    }
    return this.append(userId, -value, memo);
  }

  record(userId: string, memo: LedgerMemo): CreditLedgerEntry {
    return this.append(userId, 0, memo);
  }

  entries(userId: string): CreditLedgerEntry[] {
    return (this.ledger.get(userId) ?? []).map((entry) => ({ ...entry }));
  }

  allUserIds(): string[] {
    return [...this.ledger.keys()];
  }

  private append(
    userId: string,
    signedAmount: number,
    memo: LedgerMemo,
  ): CreditLedgerEntry {
    if (typeof userId !== "string" || userId.length === 0) {
      throw new DomainError("invalid", "userId is required");
    }
    const balanceAfter = round(this.balance(userId) + signedAmount);
    const entry: CreditLedgerEntry = {
      id: crypto.randomUUID(),
      at: memo.at ?? Date.now(),
      userId,
      type: memo.type,
      amount: signedAmount === 0 ? 0 : signedAmount,
      balanceAfter,
    };
    if (memo.raceId !== undefined) entry.raceId = memo.raceId;
    if (memo.racerId !== undefined) entry.racerId = memo.racerId;
    if (memo.side !== undefined) entry.side = memo.side;
    if (memo.quantity !== undefined) entry.quantity = memo.quantity;
    if (memo.price !== undefined) entry.price = memo.price;
    if (memo.method !== undefined) entry.method = memo.method;

    this.balances.set(userId, balanceAfter);
    const entries = this.ledger.get(userId) ?? [];
    entries.push(entry);
    this.ledger.set(userId, entries);
    return { ...entry };
  }

  private assertAmount(amount: number): number {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new DomainError("invalid", "amount must be a finite, non-negative number");
    }
    return round(amount);
  }
}
