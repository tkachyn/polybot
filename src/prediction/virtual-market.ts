import type {
  OrderAction,
  SettlementResult,
  Side,
} from "../api/dto.js";
import { DomainError } from "../domain/errors.js";
import {
  InMemoryCreditLedger,
  type CreditLedger,
} from "../wallet/credit-ledger.js";
import {
  MAX_ORDER_QUANTITY,
  ceilMicro,
  floorMicro,
  quoteTrade,
  type TradeQuote,
} from "./lmsr.js";

export type MarketStatus = "open" | "frozen" | "resolved" | "unresolved";

export type PredictionPosition = {
  userId: string;
  racerId: string;
  side: Side;
  quantity: number;
  /** costBasis / quantity, rounded up to 6 decimals like a receipt's average. */
  averagePrice: number;
  /** Credits paid for the shares still held. A sell releases it pro rata. */
  costBasis: number;
};

export type TradeReceipt = {
  userId: string;
  racerId: string;
  /** buy or sell. */
  action: OrderAction;
  /** The outcome traded: YES on the racer, or NO on the racer. */
  side: Side;
  quantity: number;
  /** Average fill price: total / quantity. */
  price: number;
  total: number;
};

export type TradeOptions = {
  /**
   * Worst acceptable average fill price. Buys fail with `price_moved` above
   * it; sells fail below it.
   */
  limitPrice?: number;
  /** Timestamp recorded on the ledger entry. */
  now?: number;
};

/** What a client needs to quote an order exactly as the market will fill it. */
export type MarketPricing = {
  /** LMSR depth b, in shares. */
  depth: number;
  /** YES log-odds per racer, ln(p / (1 − p)), unrounded. */
  logOdds: Record<string, number>;
};

/** Legacy resolution line. Use settlementLines() for side-aware detail. */
export type ResolutionPayout = {
  userId: string;
  racerId: string;
  quantity: number;
  payout: number;
};

export type SettlementLine = {
  userId: string;
  racerId: string;
  side: Side;
  quantity: number;
  averagePrice: number;
  /** Credits paid for the shares settled. */
  costBasis: number;
  /** 1 or 0; null for an unresolved (void) market. */
  settlementPrice: number | null;
  /** Credits paid: payout for winners, refund for void markets, 0 for losers. */
  payout: number;
  result: SettlementResult;
};

export type RacerTradeStats = {
  racerId: string;
  yesBuyCost: number;
  yesSellProceeds: number;
  yesPayout: number;
  noBuyCost: number;
  noSellProceeds: number;
  noPayout: number;
};

export type MarketStats = {
  /** Buy and sell notional. */
  volume: number;
  /** Distinct users that traded. */
  traders: number;
  trades: number;
  /** Total void refunds. */
  refunded: number;
  /** Keyed by racerId. */
  racers: Record<string, RacerTradeStats>;
  /** Current YES prices. Resolution does not move prices, so after
   * settlement these are the last prices at resolution. */
  lastPrices: Record<string, number>;
};

export type MarketQuote = {
  racerId: string;
  yes: number;
  no: number;
};

const PRECISION = 1_000_000;
const FLOOR_RATIO = 0.02;
const PRICE_TOLERANCE = 1e-9;
/** Published prices stay inside (0, 1) so an open outcome never reads as settled. */
const MIN_PRICE = 1 / PRECISION;

/** Default LMSR depth: the net shares that move one racer's log-odds by 1. */
export const DEFAULT_MARKET_DEPTH = 1_000;

function round(value: number): number {
  return Math.round(value * PRECISION) / PRECISION;
}

function logSumExp(values: readonly number[]): number {
  const top = Math.max(...values);
  return top + Math.log(values.reduce((sum, value) => sum + Math.exp(value - top), 0));
}

/**
 * A logarithmic market scoring rule market maker (src/prediction/lmsr.ts)
 * over four outcomes. Each racer's weight is its prior (the base liquidity
 * plus race confidence signals) times e^(q/b), where q is the net YES shares
 * the market has sold on it; prices are the normalised weights. With no
 * trades the prices are exactly the prior weights, normalised.
 */
export class VirtualPredictionMarket {
  readonly racerIds: readonly string[];
  /** L: every racer's starting prior weight. Confidence signals are multiples of it. */
  readonly baseLiquidity: number;
  /** b: LMSR depth in shares. Larger is deeper: an order moves the price less. */
  readonly depth: number;
  readonly raceId?: string;
  status: MarketStatus = "open";
  winnerRacerId?: string;

  private readonly ledger: CreditLedger;
  private readonly positions = new Map<string, PredictionPosition>();
  /** q: net YES shares sold per racer. A NO share is one YES short (plus a constant). */
  private readonly outstanding = new Map<string, number>();
  private readonly signals = new Map<string, number>();
  /** Collapsed racers, with the log prior their weight was pinned to. */
  private readonly collapsed = new Map<string, number>();
  private readonly traderIds = new Set<string>();
  private readonly racerStats = new Map<string, RacerTradeStats>();
  private settlement: SettlementLine[] = [];
  private volume = 0;
  private tradeCount = 0;
  private refunded = 0;
  /** YES log-odds per racer: the exact state orders are priced from. */
  private odds: Record<string, number> = {};
  private prices: Record<string, number> = {};

  constructor(
    racerIds: readonly string[],
    options: {
      baseLiquidity?: number;
      depth?: number;
      ledger?: CreditLedger;
      raceId?: string;
    } = {},
  ) {
    if (racerIds.length !== 4 || new Set(racerIds).size !== 4) {
      throw new DomainError("invalid", "A prediction market requires four unique racers");
    }
    this.baseLiquidity = options.baseLiquidity ?? 100;
    if (!Number.isFinite(this.baseLiquidity) || this.baseLiquidity <= 0) {
      throw new DomainError("invalid", "baseLiquidity must be a positive number");
    }
    this.depth = options.depth ?? DEFAULT_MARKET_DEPTH;
    if (!Number.isFinite(this.depth) || this.depth <= 0) {
      throw new DomainError("invalid", "depth must be a positive number");
    }
    this.ledger = options.ledger ?? new InMemoryCreditLedger();
    this.raceId = options.raceId;
    this.racerIds = [...racerIds];
    for (const racerId of racerIds) {
      this.outstanding.set(racerId, 0);
      this.signals.set(racerId, 0);
      this.racerStats.set(racerId, {
        racerId,
        yesBuyCost: 0,
        yesSellProceeds: 0,
        yesPayout: 0,
        noBuyCost: 0,
        noSellProceeds: 0,
        noPayout: 0,
      });
    }
    this.reprice();
  }

  fund(userId: string, credits: number, now?: number): void {
    if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) {
      throw new DomainError("invalid", "credits must be a non-negative number");
    }
    this.ledger.credit(userId, credits, { type: "deposit", method: "virtual", at: now });
  }

  balance(userId: string): number {
    return this.ledger.balance(userId);
  }

  /** Published YES prices: 6 decimals, summing to exactly 1. */
  pricesSnapshot(): Record<string, number> {
    return { ...this.prices };
  }

  /** The exact inputs orders are priced from (see src/prediction/lmsr.ts). */
  pricing(): MarketPricing {
    return { depth: this.depth, logOdds: { ...this.odds } };
  }

  /** Current price of one side of a racer's outcome. NO is 1 - YES. */
  sidePrice(racerId: string, side: Side = "yes"): number {
    this.assertRacer(racerId);
    this.assertSide(side);
    const yes = this.prices[racerId];
    return side === "yes" ? yes : round(1 - yes);
  }

  quotes(): MarketQuote[] {
    return this.racerIds.map((racerId) => ({
      racerId,
      yes: this.prices[racerId],
      no: round(1 - this.prices[racerId]),
    }));
  }

  /** What this order would cost or return right now. Never trades. */
  quote(racerId: string, side: Side, action: OrderAction, quantity: number): TradeQuote {
    this.assertRacer(racerId);
    this.assertSide(side);
    this.assertQuantity(quantity);
    return quoteTrade(this.odds[racerId], side, action, quantity, this.depth);
  }

  /** Credits that selling `quantity` shares now would return: the honest mark. */
  liquidationValue(racerId: string, side: Side, quantity: number): number {
    if (quantity <= 0) return 0;
    return this.quote(racerId, side, "sell", quantity).total;
  }

  position(userId: string, racerId: string, side: Side = "yes"): PredictionPosition {
    this.assertRacer(racerId);
    this.assertSide(side);
    const position = this.positions.get(this.positionKey(userId, racerId, side));
    return {
      userId,
      racerId,
      side,
      quantity: position?.quantity ?? 0,
      averagePrice: position?.averagePrice ?? 0,
      costBasis: position?.costBasis ?? 0,
    };
  }

  positionsFor(userId: string): PredictionPosition[] {
    return [...this.positions.values()]
      .filter((position) => position.userId === userId)
      .map((position) => ({ ...position }));
  }

  allPositions(): PredictionPosition[] {
    return [...this.positions.values()].map((position) => ({ ...position }));
  }

  buy(
    userId: string,
    racerId: string,
    quantity: number,
    side: Side = "yes",
    options: TradeOptions = {},
  ): TradeReceipt {
    this.assertTradable();
    const quote = this.quote(racerId, side, "buy", quantity);
    this.assertLimit(racerId, side, "buy", quote, options.limitPrice);
    this.ledger.debit(userId, quote.total, {
      type: "buy",
      raceId: this.raceId,
      racerId,
      side,
      quantity,
      price: quote.averagePrice,
      at: options.now,
    });

    const key = this.positionKey(userId, racerId, side);
    const previous = this.positions.get(key);
    const nextQuantity = (previous?.quantity ?? 0) + quantity;
    const costBasis = (previous?.costBasis ?? 0) + quote.total;
    this.positions.set(key, {
      userId,
      racerId,
      side,
      quantity: nextQuantity,
      // Rounded like a receipt's average, so one fill reads the same in both.
      averagePrice: ceilMicro(costBasis / nextQuantity),
      costBasis,
    });
    this.move(racerId, side === "yes" ? quantity : -quantity);
    this.recordTrade(userId, racerId, side, "buy", quote.total);

    return { userId, racerId, action: "buy", side, quantity, price: quote.averagePrice, total: quote.total };
  }

  sell(
    userId: string,
    racerId: string,
    quantity: number,
    side: Side = "yes",
    options: TradeOptions = {},
  ): TradeReceipt {
    this.assertTradable();
    const quote = this.quote(racerId, side, "sell", quantity);
    const key = this.positionKey(userId, racerId, side);
    const position = this.positions.get(key);
    if (!position || position.quantity < quantity) {
      throw new DomainError("insufficient_position", "insufficient position to sell");
    }
    this.assertLimit(racerId, side, "sell", quote, options.limitPrice);
    this.ledger.credit(userId, quote.total, {
      type: "sell",
      raceId: this.raceId,
      racerId,
      side,
      quantity,
      price: quote.averagePrice,
      at: options.now,
    });

    const remaining = position.quantity - quantity;
    if (remaining === 0) {
      this.positions.delete(key);
    } else {
      // Average cost: the remainder keeps its average price.
      this.positions.set(key, {
        ...position,
        quantity: remaining,
        costBasis: (position.costBasis * remaining) / position.quantity,
      });
    }
    this.move(racerId, side === "yes" ? -quantity : quantity);
    this.recordTrade(userId, racerId, side, "sell", quote.total);

    return { userId, racerId, action: "sell", side, quantity, price: quote.averagePrice, total: quote.total };
  }

  /**
   * Deterministic confidence signal: shifts a racer's prior weight by
   * deltaWeight. Only applies while the market is open. Returns whether
   * prices were recalculated.
   */
  adjustConfidence(racerId: string, deltaWeight: number): boolean {
    this.assertRacer(racerId);
    if (!Number.isFinite(deltaWeight)) {
      throw new DomainError("invalid", "deltaWeight must be a finite number");
    }
    if (this.status !== "open" || this.collapsed.has(racerId) || deltaWeight === 0) {
      return false;
    }
    // Never let the signal carry the prior below the floor, so a later
    // positive signal is not swallowed by accumulated negative weight.
    const minimumSignal = this.floorWeight() - this.baseLiquidity;
    const next = Math.max(minimumSignal, (this.signals.get(racerId) ?? 0) + deltaWeight);
    this.signals.set(racerId, next);
    this.reprice();
    return true;
  }

  /**
   * Drops a racer to the floor (e.g. the racer failed): its weight becomes
   * 2% of the others' average, unless it is already lower. Later trades still
   * move it along the curve. Open only.
   */
  collapse(racerId: string): boolean {
    this.assertRacer(racerId);
    if (this.status !== "open" || this.collapsed.has(racerId)) {
      return false;
    }
    const others = this.racerIds.filter((candidate) => candidate !== racerId);
    const floor = Math.log(this.floorWeight() / (others.length * this.baseLiquidity)) +
      logSumExp(others.map((candidate) => this.logWeight(candidate)));
    const pinned = Math.min(this.logWeight(racerId), floor);
    this.collapsed.set(racerId, pinned - (this.outstanding.get(racerId) ?? 0) / this.depth);
    this.reprice();
    return true;
  }

  isCollapsed(racerId: string): boolean {
    return this.collapsed.has(racerId);
  }

  signalsSnapshot(): Record<string, number> {
    return Object.fromEntries(this.signals);
  }

  stats(): MarketStats {
    return {
      volume: this.volume,
      traders: this.traderIds.size,
      trades: this.tradeCount,
      refunded: this.refunded,
      racers: Object.fromEntries(
        [...this.racerStats.entries()].map(([racerId, stats]) => [racerId, { ...stats }]),
      ),
      lastPrices: this.pricesSnapshot(),
    };
  }

  /** Distinct spectators that have traded, in first-trade order. */
  traderUserIds(): string[] {
    return [...this.traderIds];
  }

  /** Side-aware lines produced by resolve() or markUnresolved(). */
  settlementLines(): SettlementLine[] {
    return this.settlement.map((line) => ({ ...line }));
  }

  freeze(): void {
    if (this.status === "open") {
      this.status = "frozen";
    }
  }

  /**
   * Pays 1 per share to YES holders of the winner and to NO holders of every
   * other racer. Losing positions get a zero-amount `loss` ledger entry.
   */
  resolve(winnerRacerId: string, now?: number): ResolutionPayout[] {
    this.assertUnsettled();
    this.assertRacer(winnerRacerId);
    this.status = "resolved";
    this.winnerRacerId = winnerRacerId;

    const payouts: ResolutionPayout[] = [];
    const lines: SettlementLine[] = [];
    for (const position of this.positions.values()) {
      const won = position.side === "yes"
        ? position.racerId === winnerRacerId
        : position.racerId !== winnerRacerId;
      const payout = won ? position.quantity : 0;
      const memo = {
        raceId: this.raceId,
        racerId: position.racerId,
        side: position.side,
        quantity: position.quantity,
        price: position.averagePrice,
        at: now,
      };
      if (payout > 0) {
        this.ledger.credit(position.userId, payout, { type: "payout", ...memo });
        const stats = this.statsFor(position.racerId);
        if (position.side === "yes") {
          stats.yesPayout = round(stats.yesPayout + payout);
        } else {
          stats.noPayout = round(stats.noPayout + payout);
        }
      } else {
        this.ledger.record(position.userId, { type: "loss", ...memo });
      }
      payouts.push({
        userId: position.userId,
        racerId: position.racerId,
        quantity: position.quantity,
        payout,
      });
      lines.push({
        userId: position.userId,
        racerId: position.racerId,
        side: position.side,
        quantity: position.quantity,
        averagePrice: position.averagePrice,
        costBasis: round(position.costBasis),
        settlementPrice: won ? 1 : 0,
        payout,
        result: won ? "won" : "lost",
      });
    }
    this.positions.clear();
    this.settlement = lines;
    return payouts;
  }

  /** Voids the market: refunds every open position what was paid for it. */
  markUnresolved(now?: number): SettlementLine[] {
    this.assertUnsettled();
    this.status = "unresolved";
    const lines: SettlementLine[] = [];
    for (const position of this.positions.values()) {
      const refund = floorMicro(position.costBasis);
      this.ledger.credit(position.userId, refund, {
        type: "refund",
        raceId: this.raceId,
        racerId: position.racerId,
        side: position.side,
        quantity: position.quantity,
        price: position.averagePrice,
        at: now,
      });
      this.refunded = round(this.refunded + refund);
      lines.push({
        userId: position.userId,
        racerId: position.racerId,
        side: position.side,
        quantity: position.quantity,
        averagePrice: position.averagePrice,
        costBasis: refund,
        settlementPrice: null,
        payout: refund,
        result: "refunded",
      });
    }
    this.positions.clear();
    this.settlement = lines;
    return lines.map((line) => ({ ...line }));
  }

  /** Log of a racer's weight: its log prior plus q/b. */
  private logWeight(racerId: string): number {
    const shares = (this.outstanding.get(racerId) ?? 0) / this.depth;
    const pinned = this.collapsed.get(racerId);
    if (pinned !== undefined) return pinned + shares;
    const prior = Math.max(this.floorWeight(), this.baseLiquidity + (this.signals.get(racerId) ?? 0));
    return Math.log(prior) + shares;
  }

  private move(racerId: string, yesShares: number): void {
    this.outstanding.set(racerId, (this.outstanding.get(racerId) ?? 0) + yesShares);
    this.reprice();
  }

  private reprice(): void {
    const logs = this.racerIds.map((racerId) => this.logWeight(racerId));
    const total = logSumExp(logs);
    this.odds = Object.fromEntries(this.racerIds.map((racerId, index) => [
      racerId,
      logs[index] - logSumExp(logs.filter((_, other) => other !== index)),
    ]));
    const rounded = logs.map((log) =>
      Math.min(1 - MIN_PRICE, Math.max(MIN_PRICE, round(Math.exp(log - total)))));
    const difference = round(1 - rounded.reduce((sum, price) => sum + price, 0));
    // The last racer absorbs the rounding difference unless that would push it
    // out of (0, 1); then the largest price does.
    let target = rounded.length - 1;
    const adjusted = rounded[target] + difference;
    if (adjusted < MIN_PRICE || adjusted > 1 - MIN_PRICE) {
      target = rounded.indexOf(Math.max(...rounded));
    }
    rounded[target] = round(rounded[target] + difference);
    this.prices = Object.fromEntries(this.racerIds.map((racerId, index) => [racerId, rounded[index]]));
  }

  private floorWeight(): number {
    return FLOOR_RATIO * this.baseLiquidity;
  }

  private recordTrade(
    userId: string,
    racerId: string,
    side: Side,
    action: OrderAction,
    total: number,
  ): void {
    this.traderIds.add(userId);
    this.tradeCount += 1;
    this.volume = round(this.volume + total);
    const stats = this.statsFor(racerId);
    if (side === "yes") {
      if (action === "buy") stats.yesBuyCost = round(stats.yesBuyCost + total);
      else stats.yesSellProceeds = round(stats.yesSellProceeds + total);
    } else if (action === "buy") {
      stats.noBuyCost = round(stats.noBuyCost + total);
    } else {
      stats.noSellProceeds = round(stats.noSellProceeds + total);
    }
  }

  private statsFor(racerId: string): RacerTradeStats {
    const stats = this.racerStats.get(racerId);
    if (!stats) throw new DomainError("not_found", `unknown racer: ${racerId}`);
    return stats;
  }

  /** The limit guards the average fill price, so a slip can allow for slippage. */
  private assertLimit(
    racerId: string,
    side: Side,
    action: OrderAction,
    quote: TradeQuote,
    limitPrice?: number,
  ): void {
    if (limitPrice === undefined) return;
    if (typeof limitPrice !== "number" || !Number.isFinite(limitPrice) ||
      limitPrice < 0 || limitPrice > 1) {
      throw new DomainError("invalid", "limitPrice must be a number from 0 to 1");
    }
    const average = quote.total / quote.quantity;
    const buy = action === "buy";
    if (buy ? average <= limitPrice + PRICE_TOLERANCE : average >= limitPrice - PRICE_TOLERANCE) return;
    const price = this.sidePrice(racerId, side);
    throw new DomainError(
      "price_moved",
      `price moved to ${price}: ${quote.quantity} shares would ${buy ? "cost" : "return"} an average of ` +
        `${quote.averagePrice}, ${buy ? "above" : "below"} the limit ${limitPrice}`,
      {
        racerId,
        side,
        action,
        quantity: quote.quantity,
        price,
        averagePrice: quote.averagePrice,
        limitPrice,
        logOdds: this.odds[racerId],
      },
    );
  }

  private assertTradable(): void {
    if (this.status !== "open") {
      throw new DomainError("market_closed", `market is ${this.status}`);
    }
  }

  private assertUnsettled(): void {
    if (this.status === "resolved" || this.status === "unresolved") {
      throw new DomainError("conflict", "market is already resolved");
    }
  }

  private assertRacer(racerId: string): void {
    if (!this.racerIds.includes(racerId)) {
      throw new DomainError("not_found", `unknown racer: ${racerId}`);
    }
  }

  private assertSide(side: Side): void {
    if (side !== "yes" && side !== "no") {
      throw new DomainError("invalid", "side must be yes or no");
    }
  }

  private assertQuantity(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_ORDER_QUANTITY) {
      throw new DomainError(
        "invalid",
        `quantity must be a whole number of shares from 1 to ${MAX_ORDER_QUANTITY}`,
      );
    }
  }

  private positionKey(userId: string, racerId: string, side: Side): string {
    return `${userId} ${racerId} ${side}`;
  }
}
