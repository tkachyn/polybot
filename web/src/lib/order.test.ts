import { describe, expect, it } from "vitest";
import { quoteTrade, sharesForBudget, slippageLimit } from "@pricing";
import { validateTransfer } from "../features/wallet/transfer";
import {
  AMOUNT_MESSAGES,
  SLIPPAGE,
  buildConfirmLabel,
  formatCentsFine,
  logOddsOf,
  maxAmount,
  minAmountForOneShare,
  parseAmount,
  priceMovedMessage,
  quoteOrder,
  readAmount,
  sidePrice,
  slipPricing,
  type SlipPricing,
} from "./order";

/** An even four-way market: every YES at 25¢, depth 1000. */
const EVEN: SlipPricing = { logOdds: Math.log(1 / 3), depth: 1_000 };

describe("quoteOrder", () => {
  it("quotes exactly what the market maker fills", () => {
    const q = quoteOrder({ price: 0.25, pricing: EVEN, side: "yes", amount: 50, balance: 1_000 });
    const shares = sharesForBudget(EVEN.logOdds, "yes", 50, EVEN.depth);
    const fill = quoteTrade(EVEN.logOdds, "yes", "buy", shares, EVEN.depth);
    expect(q.error).toBeNull();
    expect(q.shares).toBe(shares);
    expect(q.cost).toBe(fill.total);
    expect(q.avgPrice).toBe(fill.averagePrice);
    expect(q.payoutIfCorrect).toBe(shares);
    expect(q.profit).toBeCloseTo(shares - fill.total, 6);
  });

  it("pays for its own price impact: the average is above the price, and the amount is never exceeded", () => {
    for (const amount of [0.5, 25, 100, 999.97]) {
      const q = quoteOrder({ price: 0.25, pricing: EVEN, side: "yes", amount, balance: 1_000 });
      expect(q.avgPrice).toBeGreaterThan(0.25);
      expect(q.cost).toBeLessThanOrEqual(amount);
      expect(quoteTrade(EVEN.logOdds, "yes", "buy", q.shares + 1, EVEN.depth).total).toBeGreaterThan(amount);
    }
    // $999.97 at 25¢ buys far fewer than the 3,999 shares the old slip promised.
    expect(quoteOrder({ price: 0.25, pricing: EVEN, side: "yes", amount: 999.97, balance: 1_000 }).shares).toBeLessThan(2_600);
  });

  it("quotes NO as the basket of the other three", () => {
    const q = quoteOrder({ price: 0.75, pricing: EVEN, side: "no", amount: 75, balance: 1_000 });
    expect(q.avgPrice).toBeGreaterThan(0.75);
    expect(q.cost).toBe(quoteTrade(EVEN.logOdds, "no", "buy", q.shares, EVEN.depth).total);
  });

  it("allows slippage on the average but never more than the balance covers", () => {
    const q = quoteOrder({ price: 0.25, pricing: EVEN, side: "yes", amount: 100, balance: 1_000 });
    expect(q.limitPrice).toBe(slippageLimit("buy", q.avgPrice));
    expect(q.limitPrice).toBeCloseTo(q.avgPrice * (1 + SLIPPAGE), 5);
    expect(q.maxCost).toBeLessThanOrEqual(1_000);

    const max = quoteOrder({ price: 0.25, pricing: EVEN, side: "yes", amount: 1_000, balance: 1_000 });
    expect(max.limitPrice).toBeGreaterThanOrEqual(max.avgPrice);
    expect(max.shares * max.limitPrice).toBeLessThanOrEqual(1_000 + max.shares * 1e-6);
  });
});

describe("validation", () => {
  it("reads amounts the way the wallet does", () => {
    for (const input of ["1e9", "abc", "12.3.4"]) {
      const slip = quoteOrder({ price: 0.25, pricing: EVEN, side: "yes", amount: parseAmount(input), balance: 100 });
      expect(slip.error).toEqual({ code: "amount", message: AMOUNT_MESSAGES.malformed });
      expect(validateTransfer("deposit", input, 100).error).toBe(AMOUNT_MESSAGES.malformed);
      expect(readAmount(input).error).toBe(AMOUNT_MESSAGES.malformed);
    }
    expect(quoteOrder({ price: 0.25, pricing: EVEN, side: "yes", amount: 0, balance: 100 }).error?.message).toBe(
      AMOUNT_MESSAGES.notPositive,
    );
    expect(readAmount("-5").error).toBe(AMOUNT_MESSAGES.notPositive);
    expect(readAmount(" ").error).toBe(AMOUNT_MESSAGES.empty);
  });

  it("caps the amount at the balance without quoting absurd figures", () => {
    const q = quoteOrder({ price: 0.25, pricing: EVEN, side: "yes", amount: parseAmount("99999999999999999999"), balance: 1_000 });
    expect(q.error).toEqual({ code: "balance", message: "Insufficient balance: you have $1,000.00 available." });
    expect(q.shares).toBe(0);
    expect(q.cost).toBe(0);
    expect(quoteOrder({ price: 0.25, pricing: EVEN, side: "yes", amount: 49.95, balance: 49.95 }).error).toBeNull();
  });

  it("rejects untradable prices and amounts below one share", () => {
    expect(quoteOrder({ price: 1, pricing: EVEN, side: "yes", amount: 10, balance: 100 }).error?.code).toBe("price");
    expect(quoteOrder({ price: 0.25, pricing: EVEN, side: "yes", amount: 0.1, balance: 100 }).error).toEqual({
      code: "shares",
      message: "Too small for 1 share at 25¢. Enter at least $0.26.",
    });
    expect(minAmountForOneShare(EVEN, "yes")).toBe(0.26);
    expect(quoteOrder({ price: 0.25, pricing: EVEN, side: "yes", amount: 0.26, balance: 100 }).shares).toBe(1);
  });
});

describe("helpers", () => {
  it("max is the whole balance", () => {
    expect(maxAmount(123.456789)).toBe(123.456789);
    expect(maxAmount(-4)).toBe(0);
    expect(maxAmount(Number.NaN)).toBe(0);
  });

  it("parses amount input", () => {
    expect(parseAmount("$1,234.50")).toBe(1234.5);
    expect(parseAmount(" 50 ")).toBe(50);
    expect(parseAmount("12.")).toBe(12);
    expect(parseAmount("")).toBeNaN();
    expect(parseAmount("abc")).toBeNaN();
  });

  it("takes pricing from the fight, falling back to the price", () => {
    const agent = { racerId: "racer-2", yes: 0.4 };
    expect(slipPricing({ pricing: { depth: 500, logOdds: { "racer-2": 0.7 } } }, agent)).toEqual({ logOdds: 0.7, depth: 500 });
    expect(slipPricing({ pricing: { depth: 500, logOdds: { "racer-2": 0.7 } } }, agent, 1.2).logOdds).toBe(1.2);
    expect(slipPricing({ pricing: { depth: 500, logOdds: {} } }, agent).logOdds).toBeCloseTo(logOddsOf(0.4), 12);
  });

  it("reads a side price", () => {
    expect(sidePrice({ yes: 0.27, no: 0.73 }, "yes")).toBe(0.27);
    expect(sidePrice({ yes: 0.27, no: 0.73 }, "no")).toBe(0.73);
  });

  it("describes a price move precisely enough to see it", () => {
    expect(formatCentsFine(0.2435)).toBe("24.4¢");
    expect(priceMovedMessage({ price: 0.2481, averagePrice: 0.2512, limitPrice: 0.2489, quantity: 212 })).toBe(
      "Price moved to 24.8¢: 212 shares now average 25.1¢, over your 24.9¢ limit.",
    );
    expect(priceMovedMessage({ price: 0.61, averagePrice: 0.58, limitPrice: 0.59, quantity: 40 }, "sell")).toContain("under your 59.0¢ limit");
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
