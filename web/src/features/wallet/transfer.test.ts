import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "@contract";
import {
  amountInputValue,
  floorCents,
  inputMatches,
  maxWithdrawable,
  parseTransferTab,
  transferLabel,
  validateTransfer,
  walletActivity,
} from "./transfer";

function entry(id: string, type: LedgerEntry["type"], at: number): LedgerEntry {
  return {
    id,
    at,
    type,
    amount: type === "withdraw" ? -10 : 10,
    balanceAfter: 100,
    raceId: null,
    fightNumber: null,
    fightTitle: null,
    racerId: null,
    agent: null,
    side: null,
    quantity: null,
    price: null,
    method: type === "deposit" || type === "withdraw" ? "virtual" : null,
  };
}

describe("parseTransferTab", () => {
  it("defaults to deposit", () => {
    expect(parseTransferTab(null)).toBe("deposit");
    expect(parseTransferTab("nonsense")).toBe("deposit");
    expect(parseTransferTab("withdraw")).toBe("withdraw");
  });
});

describe("floorCents / maxWithdrawable", () => {
  it("never rounds up past the balance", () => {
    expect(floorCents(123.456789)).toBe(123.45);
    expect(floorCents(0.009)).toBe(0);
    expect(floorCents(50)).toBe(50);
    expect(floorCents(0.29)).toBe(0.29);
    expect(floorCents(-3)).toBe(0);
  });
  it("caps at the per-request limit", () => {
    expect(maxWithdrawable(250_000)).toBe(100_000);
    expect(maxWithdrawable(null)).toBe(0);
  });
});

describe("validateTransfer", () => {
  it("rejects empty, malformed and non-positive amounts", () => {
    expect(validateTransfer("deposit", "", 0).error).toMatch(/Enter an amount/);
    expect(validateTransfer("deposit", "abc", 0).error).toMatch(/valid amount/);
    expect(validateTransfer("deposit", "0", 0).error).toMatch(/greater than \$0/);
    expect(validateTransfer("deposit", "-5", 0).error).toMatch(/greater than \$0/);
    expect(validateTransfer("deposit", "0.001", 0).error).toMatch(/greater than \$0/);
  });
  it("enforces the 100,000 cap", () => {
    expect(validateTransfer("deposit", "100000", 0).error).toBeNull();
    expect(validateTransfer("deposit", "100,000.01", 0).error).toMatch(/\$100,000\.00 per transfer/);
  });
  it("limits withdrawals to the balance", () => {
    expect(validateTransfer("withdraw", "50", 49.999).error).toMatch(/at most \$49\.99/);
    expect(validateTransfer("withdraw", "49.99", 49.999).error).toBeNull();
    expect(validateTransfer("withdraw", "5", 0).error).toMatch(/no available balance/);
    expect(validateTransfer("withdraw", "5", null).error).toBeNull();
    expect(validateTransfer("deposit", "500", 0).error).toBeNull();
  });
  it("rounds to cents", () => {
    expect(validateTransfer("deposit", "$1,234.567", 0).amount).toBe(1234.57);
  });
});

describe("labels and chips", () => {
  it("labels the CTA with the exact amount", () => {
    expect(transferLabel("deposit", validateTransfer("deposit", "100", 0))).toBe("Deposit $100.00");
    expect(transferLabel("withdraw", validateTransfer("withdraw", "50", 80))).toBe("Withdraw $50.00");
    expect(transferLabel("withdraw", validateTransfer("withdraw", "", 80))).toBe("Withdraw");
  });
  it("formats and matches chip amounts", () => {
    expect(amountInputValue(25)).toBe("25");
    expect(amountInputValue(123.4)).toBe("123.40");
    expect(inputMatches("$25.00", 25)).toBe(true);
    expect(inputMatches("25.5", 25)).toBe(false);
  });
});

describe("walletActivity", () => {
  it("keeps transfers only, dedupes by id and sorts newest first", () => {
    const history = [entry("b", "buy", 5), entry("d1", "deposit", 1), entry("w1", "withdraw", 3)];
    const extra = [entry("w1", "withdraw", 3), entry("d2", "deposit", 9)];
    expect(walletActivity(history, extra).map((e) => e.id)).toEqual(["d2", "w1", "d1"]);
    expect(walletActivity(null)).toEqual([]);
  });
});
