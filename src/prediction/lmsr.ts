/**
 * Order pricing: a logarithmic market scoring rule (LMSR) market maker.
 *
 * The server fills every order with these functions and the web bet slip
 * quotes with them (through the `@pricing` alias), so a quote and its fill are
 * one computation. Keep this module free of imports: the web build bundles it.
 *
 * Every order pays the integral of the price along its own price impact. With
 * depth b (the net shares that move a racer's log-odds by one) and the traded
 * side's log-odds ℓ (YES: the racer's log-odds L; NO: −L, since NO is a basket
 * of the other three), n shares cost or return
 *
 *   buy    b·(softplus(ℓ + n/b) − softplus(ℓ))
 *   sell   b·(softplus(ℓ) − softplus(ℓ − n/b))       softplus(z) = ln(1 + e^z)
 *
 * which is b·ln(1 − p + p·e^(n/b)) for a buy at price p. Costs are differences
 * of one cost function, so they do not depend on the path: selling what you
 * just bought returns exactly what you paid, and no cycle of trades can
 * profit. Totals round to micro-credits in the house's favour (buys up, sells
 * down), which keeps that true after rounding. Log-odds, unlike prices, keep
 * full precision next to 0 and 1.
 */

export type PricingSide = "yes" | "no";
export type PricingAction = "buy" | "sell";

/** Largest order, in shares. Keeps costs far inside double precision. */
export const MAX_ORDER_QUANTITY = 10_000_000;

/** Slippage the slip accepts on the average fill price, as a fraction of it. */
export const SLIPPAGE = 0.05;

const MICRO = 1_000_000;
/** Float noise within a billionth of a credit of a micro boundary counts as on it. */
const BOUNDARY = 1e-3;

/** Rounds up to whole micro-credits: what a buyer pays. */
export function ceilMicro(value: number): number {
  return Math.ceil(value * MICRO - BOUNDARY) / MICRO + 0;
}

/** Rounds down to whole micro-credits: what a seller receives. */
export function floorMicro(value: number): number {
  return Math.floor(value * MICRO + BOUNDARY) / MICRO + 0;
}

/** ln(1 + e^z) without overflow or underflow. */
function softplus(z: number): number {
  return z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z));
}

/** ln(e^y − 1), the inverse of softplus, for y > 0. */
function softplusInverse(y: number): number {
  return y > 30 ? y + Math.log1p(-Math.exp(-y)) : Math.log(Math.expm1(y));
}

/** Probability from log-odds. */
export function priceFromLogOdds(logOdds: number): number {
  if (logOdds >= 0) return 1 / (1 + Math.exp(-logOdds));
  const odds = Math.exp(logOdds);
  return odds / (1 + odds);
}

function sideLogOdds(logOdds: number, side: PricingSide): number {
  return side === "yes" ? logOdds : -logOdds;
}

/** Unrounded credits paid (buy) or received (sell) for `quantity` shares. */
export function tradeValue(
  logOdds: number,
  side: PricingSide,
  action: PricingAction,
  quantity: number,
  depth: number,
): number {
  const own = sideLogOdds(logOdds, side);
  const shift = quantity / depth;
  return action === "buy"
    ? depth * (softplus(own + shift) - softplus(own))
    : depth * (softplus(own) - softplus(own - shift));
}

/** The racer's YES log-odds once the trade fills. YES buys and NO sells lift them. */
export function logOddsAfterTrade(
  logOdds: number,
  side: PricingSide,
  action: PricingAction,
  quantity: number,
  depth: number,
): number {
  const lifts = (side === "yes") === (action === "buy");
  return logOdds + (lifts ? 1 : -1) * (quantity / depth);
}

export type TradeQuote = {
  quantity: number;
  /** Credits paid (buy) or received (sell), rounded in the house's favour. */
  total: number;
  /** total / quantity, rounded the same way (never better than the fill). */
  averagePrice: number;
  /** Price of the traded side once the trade fills. */
  priceAfter: number;
};

/** Exactly what the server charges or pays for this order at these log-odds. */
export function quoteTrade(
  logOdds: number,
  side: PricingSide,
  action: PricingAction,
  quantity: number,
  depth: number,
): TradeQuote {
  const value = tradeValue(logOdds, side, action, quantity, depth);
  const buy = action === "buy";
  const total = buy ? ceilMicro(value) : floorMicro(Math.max(0, value));
  const average = quantity > 0 ? total / quantity : 0;
  const after = logOddsAfterTrade(logOdds, side, action, quantity, depth);
  return {
    quantity,
    total,
    averagePrice: buy ? ceilMicro(average) : floorMicro(average),
    priceAfter: priceFromLogOdds(sideLogOdds(after, side)),
  };
}

/** The most whole shares of `side` that `budget` credits buy, rounding included. */
export function sharesForBudget(logOdds: number, side: PricingSide, budget: number, depth: number): number {
  if (!(budget > 0) || !Number.isFinite(budget)) return 0;
  const own = sideLogOdds(logOdds, side);
  // Invert the buy cost: softplus(ℓ + n/b) = budget/b + softplus(ℓ).
  const shift = softplusInverse(budget / depth + softplus(own)) - own;
  let shares = Math.min(MAX_ORDER_QUANTITY, Math.max(0, Math.floor(depth * shift)));
  const affordable = (n: number) => quoteTrade(logOdds, side, "buy", n, depth).total <= budget + 1e-9;
  for (let step = 0; step < 4 && shares > 0 && !affordable(shares); step += 1) shares -= 1;
  for (let step = 0; step < 4 && shares < MAX_ORDER_QUANTITY && affordable(shares + 1); step += 1) shares += 1;
  return shares;
}

/**
 * The worst average price to accept for a quoted order: `slippage` above the
 * quote for a buy, below it for a sell. The server enforces it on the fill.
 */
export function slippageLimit(action: PricingAction, averagePrice: number, slippage = SLIPPAGE): number {
  return action === "buy"
    ? Math.min(1, ceilMicro(averagePrice * (1 + slippage)))
    : Math.max(0, floorMicro(averagePrice * (1 - slippage)));
}
