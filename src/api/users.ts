import { randomBytes } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { CreditLedger, CreditLedgerEntry } from "../wallet/credit-ledger.js";
import type { EnsureUserRequest, WalletMethodId } from "./dto.js";

export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
export const TRANSFER_MAX = 100_000;
export const DISPLAY_NAME_MAX = 40;

export type UserRecord = {
  userId: string;
  displayName: string;
  createdAt: number;
  /** Internal market-liquidity bot, excluded from judge standings. */
  automated: boolean;
};

export type UserChangeListener = (userIds: string[]) => void;

function invalid(message: string): never {
  throw new DomainError("invalid", message);
}

export function generateUserId(): string {
  return `u_${randomBytes(9).toString("base64url")}`;
}

export function defaultDisplayName(userId: string): string {
  return `Trader ${userId.slice(-4).toUpperCase()}`;
}

/** Spectator accounts. Balances live in the shared credit ledger. */
export class UserDirectory {
  private readonly users = new Map<string, UserRecord>();
  private readonly listeners = new Set<UserChangeListener>();

  constructor(
    private readonly ledger: CreditLedger,
    private readonly options: { startingBalance: number },
  ) {
    if (!Number.isFinite(options.startingBalance) || options.startingBalance < 0) {
      invalid("startingBalance must be a non-negative number");
    }
  }

  get startingBalance(): number {
    return this.options.startingBalance;
  }

  /**
   * Returns the user, creating it (with the starting balance credited as a
   * `deposit`) when it does not exist yet.
   */
  ensure(
    request: EnsureUserRequest = {},
    now = Date.now(),
    options: { automated?: boolean } = {},
  ): { user: UserRecord; created: boolean } {
    const { userId, displayName } = request ?? {};
    if (userId !== undefined && (typeof userId !== "string" || !USER_ID_PATTERN.test(userId))) {
      invalid("userId must match ^[A-Za-z0-9_-]{6,64}$");
    }
    const name = normalizeDisplayName(displayName);

    if (name !== undefined && !options.automated) {
      const duplicate = [...this.users.values()].find(
        (candidate) => candidate.userId !== userId && !candidate.automated &&
          candidate.displayName.localeCompare(name, undefined, { sensitivity: "accent" }) === 0,
      );
      if (duplicate) {
        throw new DomainError("conflict", "That judge name is already in use");
      }
    }

    const existing = userId === undefined ? undefined : this.users.get(userId);
    if (existing) {
      if (name !== undefined && name !== existing.displayName) {
        existing.displayName = name;
        this.emit([existing.userId]);
      }
      return { user: { ...existing }, created: false };
    }

    let id = userId ?? generateUserId();
    while (userId === undefined && this.users.has(id)) id = generateUserId();
    const user: UserRecord = {
      userId: id,
      displayName: name ?? defaultDisplayName(id),
      createdAt: now,
      automated: options.automated ?? false,
    };
    this.users.set(id, user);
    if (this.options.startingBalance > 0) {
      this.ledger.credit(id, this.options.startingBalance, {
        type: "deposit",
        method: "virtual",
        at: now,
      });
    }
    this.emit([id]);
    return { user: { ...user }, created: true };
  }

  has(userId: string): boolean {
    return this.users.has(userId);
  }

  /** Throws DomainError `not_found` for an unknown user. */
  get(userId: string): UserRecord {
    const user = this.users.get(userId);
    if (!user) throw new DomainError("not_found", `user ${String(userId)} was not found`);
    return { ...user };
  }

  list(): UserRecord[] {
    return [...this.users.values()].map((user) => ({ ...user }));
  }

  deposit(
    userId: string,
    amount: number,
    method: WalletMethodId,
    now = Date.now(),
  ): CreditLedgerEntry {
    this.get(userId);
    const value = assertTransfer(amount, method);
    const entry = this.ledger.credit(userId, value, { type: "deposit", method, at: now });
    this.emit([userId]);
    return entry;
  }

  withdraw(
    userId: string,
    amount: number,
    method: WalletMethodId,
    now = Date.now(),
  ): CreditLedgerEntry {
    this.get(userId);
    const value = assertTransfer(amount, method);
    // The ledger rejects a withdrawal above the balance (insufficient_balance).
    const entry = this.ledger.debit(userId, value, { type: "withdraw", method, at: now });
    this.emit([userId]);
    return entry;
  }

  /** Balance changes made outside any race (deposits, withdrawals, sign-ups). */
  subscribe(listener: UserChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(userIds: string[]): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(userIds);
      } catch {
        // A failing subscriber must not break the wallet.
      }
    }
  }
}

function normalizeDisplayName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") invalid("displayName must be a string");
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return undefined;
  if (flat.length > DISPLAY_NAME_MAX) {
    invalid(`displayName must be at most ${DISPLAY_NAME_MAX} characters`);
  }
  return flat;
}

function assertTransfer(amount: unknown, method: unknown): number {
  if (method !== "virtual") invalid("method must be virtual");
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    invalid("amount must be a finite number greater than 0");
  }
  if (amount > TRANSFER_MAX) invalid(`amount must be at most ${TRANSFER_MAX}`);
  return amount;
}
