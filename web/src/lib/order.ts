/**
 * Bet-slip math. Orders fill through the market maker in
 * src/prediction/lmsr.ts (the `@pricing` alias), and the slip quotes with the
 * same functions from the same inputs (FightDetail.pricing), so its shares,
 * cost and average are the fill's unless the price moves first. For an
 * amount A the slip buys the most whole shares that A pays for:
 *
 *   shares          = sharesForBudget(ℓ, side, A, b)
 *   cost            = quoteTrade(ℓ, side, "buy", shares, b).total
 *   avgPrice        = cost / shares   (above the price: the order moves it)
 *   payoutIfCorrect = shares × 1.00
 *   profit          = payoutIfCorrect − cost
 *
 * where ℓ is the racer's YES log-odds and b the market depth. The order goes
 * out with limitPrice = avgPrice plus SLIPPAGE, capped so it never costs
 * more than the balance.
 */
import type { FightAgentDetail, FightDetail, OrderAction, Side } from "@contract";
import { SLIPPAGE, floorMicro, quoteTrade, sharesForBudget, slippageLimit } from "@pricing";
import { formatCents, formatMoney, formatShares, isFiniteNumber, roundTo } from "./format";

export { SLIPPAGE };

/** Quick-amount chips. "Max" is separate: see {@link maxAmount}. */
export const QUICK_AMOUNTS = [25, 50, 100] as const;

/** One wording for amount fields everywhere (bet slip and wallet). */
export const AMOUNT_MESSAGES = {
  empty: "Enter an amount.",
  malformed: "Enter a valid amount, e.g. 100 or 25.50.",
  notPositive: "Enter an amount greater than $0.",
} as const;

/** Rounds to 6 decimal places, matching the server's money precision. */
export function round6(value: number): number {
  return roundTo(value, 6);
}

/**
 * Parses an amount field: accepts "$1,234.50", " 50 ", "12.". Returns NaN
 * for empty or malformed input (including "1e9") so validation reports it.
 */
export function parseAmount(input: string): number {
  const cleaned = input.replace(/[\s$,]/g, "");
  if (!cleaned || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return Number.NaN;
  return Number(cleaned);
}

/** Reads an amount field: the number, or the first thing wrong with it. */
export function readAmount(input: string): { amount: number; error: string | null } {
  if (input.trim() === "") return { amount: Number.NaN, error: AMOUNT_MESSAGES.empty };
  const amount = parseAmount(input);
  if (!Number.isFinite(amount)) return { amount: Number.NaN, error: AMOUNT_MESSAGES.malformed };
  if (amount <= 0) return { amount, error: AMOUNT_MESSAGES.notPositive };
  return { amount, error: null };
}

export type OrderErrorCode = "amount" | "price" | "shares" | "balance";

export type OrderError = {
  code: OrderErrorCode;
  message: string;
};

/** The market maker's inputs for one outcome (see FightDetail.pricing). */
export type SlipPricing = {
  /** The racer's YES log-odds. */
  logOdds: number;
  /** Market depth b, in shares. */
  depth: number;
};

export type OrderQuote = {
  /** Current price of the chosen side, 0..1. */
  price: number;
  /** Average fill price: cost / shares. */
  avgPrice: number;
  /** Amount entered, in dollars. */
  amount: number;
  shares: number;
  cost: number;
  payoutIfCorrect: number;
  profit: number;
  /** Worst average price the order accepts; sent as `limitPrice`. */
  limitPrice: number;
  /** What the order can cost at most if the price moves before it fills. */
  maxCost: number;
  /** First validation failure, or null when the order can be placed. */
  error: OrderError | null;
};

export type QuoteInput = {
  /** Current price of the chosen side (display precision). */
  price: number;
  pricing: SlipPricing;
  side: Side;
  /** Parsed amount; NaN when the field is empty or malformed. */
  amount: number;
  balance: number;
};

export function isTradablePrice(price: number): boolean {
  return Number.isFinite(price) && price > 0 && price < 1;
}

/** Log-odds from a price, for a fight that carries no pricing inputs. */
export function logOddsOf(price: number): number {
  const p = Math.min(1 - 1e-9, Math.max(1e-9, price));
  return Math.log(p / (1 - p));
}

/** The slip's pricing inputs for one outcome. `override` is fresher log-odds (a price_moved reply). */
export function slipPricing(
  fight: Pick<FightDetail, "pricing">,
  agent: Pick<FightAgentDetail, "racerId" | "yes">,
  override: number | null = null,
): SlipPricing {
  const pricing = fight.pricing as FightDetail["pricing"] | undefined;
  return {
    logOdds: override ?? pricing?.logOdds[agent.racerId] ?? logOddsOf(agent.yes),
    depth: pricing?.depth ?? 1_000,
  };
}

/** Smallest whole-cent amount that buys one share. */
export function minAmountForOneShare(pricing: SlipPricing, side: Side): number {
  const cost = quoteTrade(pricing.logOdds, side, "buy", 1, pricing.depth).total;
  return Math.ceil(roundTo(cost * 100, 4) - 1e-9) / 100;
}

/**
 * Validation, checked in this order: the amount (malformed, ≤ 0), the price
 * (outside (0, 1)), the balance (the amount may not exceed it), then at least
 * one whole share. Never throws; an invalid order quotes zero shares.
 */
export function quoteOrder({ price, pricing, side, amount, balance }: QuoteInput): OrderQuote {
  const available = isFiniteNumber(balance) ? round6(Math.max(0, balance)) : 0;
  const none: OrderQuote = {
    price,
    avgPrice: 0,
    amount: Number.isFinite(amount) ? amount : 0,
    shares: 0,
    cost: 0,
    payoutIfCorrect: 0,
    profit: 0,
    limitPrice: 0,
    maxCost: 0,
    error: null,
  };
  const fail = (code: OrderErrorCode, message: string): OrderQuote => ({ ...none, error: { code, message } });

  if (!Number.isFinite(amount)) return fail("amount", AMOUNT_MESSAGES.malformed);
  if (amount <= 0) return fail("amount", AMOUNT_MESSAGES.notPositive);
  if (!isTradablePrice(price)) return fail("price", "This outcome can’t be traded at the moment.");
  if (round6(amount) > available) {
    return fail("balance", `Insufficient balance: you have ${formatMoney(available)} available.`);
  }
  const shares = sharesForBudget(pricing.logOdds, side, amount, pricing.depth);
  if (shares < 1) {
    return fail(
      "shares",
      `Too small for 1 share at ${formatCents(price)}. Enter at least ${formatMoney(minAmountForOneShare(pricing, side))}.`,
    );
  }
  const fill = quoteTrade(pricing.logOdds, side, "buy", shares, pricing.depth);
  // Slippage on the average, but never past what the balance covers.
  const limitPrice = Math.max(
    fill.averagePrice,
    Math.min(slippageLimit("buy", fill.averagePrice), floorMicro(available / shares)),
  );
  return {
    price,
    avgPrice: fill.averagePrice,
    amount,
    shares,
    cost: fill.total,
    payoutIfCorrect: shares,
    profit: round6(shares - fill.total),
    limitPrice,
    maxCost: round6(Math.min(available, shares * limitPrice)),
    error: null,
  };
}

/** "Max" chip: the whole available balance. */
export function maxAmount(balance: number): number {
  return isFiniteNumber(balance) ? round6(Math.max(0, balance)) : 0;
}

export type ConfirmLabelInput = {
  action?: OrderAction;
  side: Side;
  agentName: string;
  /** Average fill price. */
  price: number;
  shares: number;
  cost: number;
};

/** Exact confirm-button label: "Buy 185 YES · GPT-5.2 at 27¢ — $49.95". */
export function buildConfirmLabel({ action = "buy", side, agentName, price, shares, cost }: ConfirmLabelInput): string {
  const verb = action === "buy" ? "Buy" : "Sell";
  return `${verb} ${formatShares(shares)} ${side.toUpperCase()} · ${agentName} at ${formatCents(price)} — ${formatMoney(cost)}`;
}

/** Price of one side from a quote-like object (`{ yes, no }`). */
export function sidePrice(quote: { yes: number; no: number }, side: Side): number {
  return side === "yes" ? quote.yes : quote.no;
}

/** A price to a tenth of a cent, "24.3¢", so a small move is visible. */
export function formatCentsFine(price: number): string {
  if (!Number.isFinite(price)) return "—";
  return `${roundTo(Math.min(1, Math.max(0, price)) * 100, 1).toFixed(1)}¢`;
}

export type PriceMove = { price: number; averagePrice: number; limitPrice: number; quantity: number };

/** "Price moved to 24.8¢: 212 shares now average 25.1¢, over your 24.9¢ limit." */
export function priceMovedMessage(move: PriceMove, action: OrderAction = "buy"): string {
  const past = action === "buy" ? "over" : "under";
  return `Price moved to ${formatCentsFine(move.price)}: ${formatShares(move.quantity)} shares now average ` +
    `${formatCentsFine(move.averagePrice)}, ${past} your ${formatCentsFine(move.limitPrice)} limit.`;
}
