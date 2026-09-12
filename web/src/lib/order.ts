/**
 * Bet-slip math. The server fills whole shares at the current price of the
 * chosen side; these helpers mirror that so the slip can show the exact
 * order before it is sent.
 *
 *   shares          = floor(A / p + 1e-9)
 *   cost            = round6(shares * p)
 *   payoutIfCorrect = shares * 1.00
 *   profit          = payoutIfCorrect - cost
 *
 * where p is the price of the chosen side in (0, 1), A the amount in dollars
 * and B the available balance.
 */
import type { OrderAction, Side } from "@contract";
import { formatCents, formatMoney, formatShares, isFiniteNumber, roundTo } from "./format";

/** Quick-amount chips. "Max" is separate: see {@link maxAmount}. */
export const QUICK_AMOUNTS = [25, 50, 100] as const;

/** Rounds to 6 decimal places, matching the server's money precision. */
export function round6(value: number): number {
  return roundTo(value, 6);
}

export type OrderErrorCode = "amount" | "price" | "shares" | "balance";

export type OrderError = {
  code: OrderErrorCode;
  message: string;
};

export type OrderQuote = {
  /** Price of the chosen side, 0..1. */
  price: number;
  /** Amount entered, in dollars. */
  amount: number;
  shares: number;
  cost: number;
  payoutIfCorrect: number;
  profit: number;
  /** First validation failure, or null when the order can be placed. */
  error: OrderError | null;
};

export type QuoteInput = {
  price: number;
  amount: number;
  balance: number;
};

export function isTradablePrice(price: number): boolean {
  return Number.isFinite(price) && price > 0 && price < 1;
}

/** Smallest whole-cent amount that buys one share at `price`. */
export function minAmountForOneShare(price: number): number {
  if (!isTradablePrice(price)) return 0;
  return Math.ceil(roundTo(price * 100, 4) - 1e-9) / 100;
}

/** Shares, cost, payout and profit for an amount. Never throws. */
export function quoteOrder({ price, amount, balance }: QuoteInput): OrderQuote {
  const tradable = isTradablePrice(price);
  const validAmount = Number.isFinite(amount) && amount > 0;
  const shares = tradable && validAmount ? Math.floor(amount / price + 1e-9) : 0;
  const cost = tradable ? round6(shares * price) : 0;
  const payoutIfCorrect = shares * 1;
  const profit = round6(payoutIfCorrect - cost);
  const quote: OrderQuote = {
    price,
    amount: Number.isFinite(amount) ? amount : 0,
    shares,
    cost,
    payoutIfCorrect,
    profit,
    error: null,
  };
  quote.error = validateOrder(quote, balance);
  return quote;
}

/**
 * Validation, checked in this order:
 * 1. amount <= 0 (or not a number)
 * 2. price not tradable (outside (0, 1))
 * 3. shares < 1
 * 4. cost > balance
 */
export function validateOrder(quote: Pick<OrderQuote, "price" | "amount" | "shares" | "cost">, balance: number): OrderError | null {
  if (!Number.isFinite(quote.amount) || quote.amount <= 0) {
    return { code: "amount", message: "Enter an amount greater than $0." };
  }
  if (!isTradablePrice(quote.price)) {
    return { code: "price", message: "This outcome can’t be traded at the moment." };
  }
  if (quote.shares < 1) {
    return {
      code: "shares",
      message: `Too small for 1 share at ${formatCents(quote.price)}. Enter at least ${formatMoney(minAmountForOneShare(quote.price))}.`,
    };
  }
  const available = isFiniteNumber(balance) ? round6(Math.max(0, balance)) : 0;
  if (round6(quote.cost) > available) {
    return {
      code: "balance",
      message: `Insufficient balance. This order costs ${formatMoney(quote.cost)} and you have ${formatMoney(available)} available.`,
    };
  }
  return null;
}

/** "Max" chip: the whole available balance. */
export function maxAmount(balance: number): number {
  return isFiniteNumber(balance) ? round6(Math.max(0, balance)) : 0;
}

/**
 * Parses the amount field: accepts "$1,234.50", " 50 ", "12.". Returns NaN
 * for empty or malformed input so validation reports it.
 */
export function parseAmount(input: string): number {
  const cleaned = input.replace(/[\s$,]/g, "");
  if (!cleaned || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return Number.NaN;
  return Number(cleaned);
}

export type ConfirmLabelInput = {
  action?: OrderAction;
  side: Side;
  agentName: string;
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
