import { describe, expect, it } from "vitest";
import { buildConfirmLabel, maxAmount, minAmountForOneShare, parseAmount, quoteOrder, round6, sidePrice, validateOrder } from "./order";

describe("quoteOrder", () => {
  it("computes shares, cost, payout and profit", () => {
    const q = quoteOrder({ price: 0.27, amount: 50, balance: 1000 });
    expect(q.shares).toBe(185);
    expect(q.cost).toBe(49.95);
    expect(q.payoutIfCorrect).toBe(185);
    expect(q.profit).toBe(135.05);
    expect(q.error).toBeNull();
  });

  it("absorbs binary error when flooring", () => {
    expect(quoteOrder({ price: 0.1, amount: 0.7, balance: 10 }).shares).toBe(7);
    expect(quoteOrder({ price: 0.3, amount: 0.9, balance: 10 }).shares).toBe(3);
    expect(quoteOrder({ price: 0.07, amount: 0.21, balance: 10 }).shares).toBe(3);
  });

  it("rounds cost to 6 decimals", () => {
    const q = quoteOrder({ price: 0.333333, amount: 100, balance: 1000 });
    expect(q.shares).toBe(300);
    expect(q.cost).toBe(round6(300 * 0.333333));
    expect(q.cost).toBe(99.9999);
  });

  it("returns zero shares for untradable input", () => {
    expect(quoteOrder({ price: 0, amount: 50, balance: 100 }).shares).toBe(0);
    expect(quoteOrder({ price: 1, amount: 50, balance: 100 }).shares).toBe(0);
    expect(quoteOrder({ price: 0.5, amount: Number.NaN, balance: 100 }).amount).toBe(0);
  });
});

describe("validation", () => {
  it("checks amount first", () => {
    expect(quoteOrder({ price: 0.27, amount: 0, balance: 100 }).error).toEqual({
      code: "amount",
      message: "Enter an amount greater than $0.",
    });
    expect(quoteOrder({ price: 0.27, amount: Number.NaN, balance: 100 }).error?.code).toBe("amount");
  });

  it("rejects untradable prices", () => {
    expect(quoteOrder({ price: 1, amount: 10, balance: 100 }).error?.code).toBe("price");
    expect(quoteOrder({ price: 0, amount: 10, balance: 100 }).error?.message).toBe("This outcome can’t be traded at the moment.");
  });

  it("rejects amounts below one share", () => {
    expect(quoteOrder({ price: 0.27, amount: 0.1, balance: 100 }).error).toEqual({
      code: "shares",
      message: "Too small for 1 share at 27¢. Enter at least $0.27.",
    });
  });

  it("rejects orders above the balance", () => {
    expect(quoteOrder({ price: 0.27, amount: 50, balance: 10 }).error).toEqual({
      code: "balance",
      message: "Insufficient balance. This order costs $49.95 and you have $10.00 available.",
    });
  });

  it("allows spending exactly the balance", () => {
    expect(quoteOrder({ price: 0.27, amount: 49.95, balance: 49.95 }).error).toBeNull();
    expect(validateOrder({ price: 0.5, amount: 1, shares: 2, cost: 1 }, 1)).toBeNull();
  });
});

describe("helpers", () => {
  it("max is the whole balance", () => {
    expect(maxAmount(123.456789)).toBe(123.456789);
    expect(maxAmount(-4)).toBe(0);
    expect(maxAmount(Number.NaN)).toBe(0);
    const q = quoteOrder({ price: 0.27, amount: maxAmount(100), balance: 100 });
    expect(q.shares).toBe(370);
    expect(q.error).toBeNull();
  });

  it("finds the minimum amount for one share", () => {
    expect(minAmountForOneShare(0.27)).toBe(0.27);
    expect(minAmountForOneShare(0.004)).toBe(0.01);
    expect(minAmountForOneShare(0.555)).toBe(0.56);
  });

  it("parses amount input", () => {
    expect(parseAmount("$1,234.50")).toBe(1234.5);
    expect(parseAmount(" 50 ")).toBe(50);
    expect(parseAmount("12.")).toBe(12);
    expect(parseAmount("")).toBeNaN();
    expect(parseAmount("abc")).toBeNaN();
  });

  it("reads a side price", () => {
    expect(sidePrice({ yes: 0.27, no: 0.73 }, "yes")).toBe(0.27);
    expect(sidePrice({ yes: 0.27, no: 0.73 }, "no")).toBe(0.73);
  });
});

describe("buildConfirmLabel", () => {
  it("names the exact order", () => {
    expect(buildConfirmLabel({ side: "yes", agentName: "GPT-5.2", price: 0.27, shares: 185, cost: 49.95 })).toBe(
      "Buy 185 YES · GPT-5.2 at 27¢ — $49.95",
    );
    expect(
      buildConfirmLabel({ action: "sell", side: "no", agentName: "Claude Opus 4.6", price: 0.73, shares: 1234, cost: 900.82 }),
    ).toBe("Sell 1,234 NO · Claude Opus 4.6 at 73¢ — $900.82");
  });
});
