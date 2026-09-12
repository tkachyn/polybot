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

export type MarketStatus = "open" | "frozen" | "resolved" | "unresolved";

export type PredictionPosition = {
  userId: string;
  racerId: string;
  side: Side;
  quantity: number;
  averagePrice: number;
};

export type TradeReceipt = {
  userId: string;
  racerId: string;
  /** buy or sell. */
  action: OrderAction;
  /** The outcome traded: YES on the racer, or NO on the racer. */
  side: Side;
  quantity: number;
  price: number;
  total: number;
};

export type TradeOptions = {
  /**
   * Price guard. Buys fail with `price_moved` above it; sells fail below it.
   */
  limitPrice?: number;
  /** Timestamp recorded on the ledger entry. */
  now?: number;
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
  /** quantity * averagePrice. */
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

function round(value: number): number {
  return Math.round(value * PRECISION) / PRECISION;
}

export class VirtualPredictionMarket {
  readonly racerIds: readonly string[];
  /** L: every racer's starting weight. */
  readonly baseLiquidity: number;
  readonly raceId?: string;
  status: MarketStatus = "open";
  winnerRacerId?: string;

  private readonly ledger: CreditLedger;
  private readonly positions = new Map<string, PredictionPosition>();
  private readonly demand = new Map<string, number>();
  private readonly signals = new Map<string, number>();
  private readonly collapsed = new Set<string>();
  private readonly traderIds = new Set<string>();
  private readonly racerStats = new Map<string, RacerTradeStats>();
  private settlement: SettlementLine[] = [];
  private volume = 0;
  private tradeCount = 0;
  private refunded = 0;
  private prices: Record<string, number>;

  constructor(
    racerIds: readonly string[],
    options: {
      baseLiquidity?: number;
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
    this.ledger = options.ledger ?? new InMemoryCreditLedger();
    this.raceId = options.raceId;
    this.racerIds = [...racerIds];
    for (const racerId of racerIds) {
      this.demand.set(racerId, 0);
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
    this.prices = this.calculatePrices();
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

  pricesSnapshot(): Record<string, number> {
    return { ...this.prices };
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
    this.assertRacer(racerId);
    this.assertQuantity(quantity);
    this.assertSide(side);

    const price = this.sidePrice(racerId, side);
    this.assertLimit("buy", price, options.limitPrice);
    const total = round(price * quantity);
    this.ledger.debit(userId, total, {
      type: "buy",
      raceId: this.raceId,
      racerId,
      side,
      quantity,
      price,
      at: options.now,
    });

    const key = this.positionKey(userId, racerId, side);
    const previous = this.positions.get(key);
    const previousQuantity = previous?.quantity ?? 0;
    const nextQuantity = previousQuantity + quantity;
    const averagePrice = round(
      ((previous?.averagePrice ?? 0) * previousQuantity + price * quantity) /
        nextQuantity,
    );
    this.positions.set(key, {
      userId,
      racerId,
      side,
      quantity: nextQuantity,
      averagePrice,
    });
    for (const target of this.demandTargets(racerId, side)) {
      this.demand.set(target, (this.demand.get(target) ?? 0) + quantity);
    }
    this.prices = this.calculatePrices();
    this.recordTrade(userId, racerId, side, "buy", total);

    return { userId, racerId, action: "buy", side, quantity, price, total };
  }

  sell(
    userId: string,
    racerId: string,
    quantity: number,
    side: Side = "yes",
    options: TradeOptions = {},
  ): TradeReceipt {
    this.assertTradable();
    this.assertRacer(racerId);
    this.assertQuantity(quantity);
    this.assertSide(side);

    const key = this.positionKey(userId, racerId, side);
    const position = this.positions.get(key);
    if (!position || position.quantity < quantity) {
      throw new DomainError("insufficient_position", "insufficient position to sell");
    }

    const price = this.sidePrice(racerId, side);
    this.assertLimit("sell", price, options.limitPrice);
    const total = round(price * quantity);
    this.ledger.credit(userId, total, {
      type: "sell",
      raceId: this.raceId,
      racerId,
      side,
      quantity,
      price,
      at: options.now,
    });

    const remaining = position.quantity - quantity;
    if (remaining === 0) {
      this.positions.delete(key);
    } else {
      this.positions.set(key, { ...position, quantity: remaining });
    }
    for (const target of this.demandTargets(racerId, side)) {
      this.demand.set(target, Math.max(0, (this.demand.get(target) ?? 0) - quantity));
    }
    this.prices = this.calculatePrices();
    this.recordTrade(userId, racerId, side, "sell", total);

    return { userId, racerId, action: "sell", side, quantity, price, total };
  }

  /**
   * Deterministic confidence signal: shifts a racer's weight by deltaWeight.
   * Only applies while the market is open. Returns whether prices were
   * recalculated.
   */
  adjustConfidence(racerId: string, deltaWeight: number): boolean {
    this.assertRacer(racerId);
    if (!Number.isFinite(deltaWeight)) {
      throw new DomainError("invalid", "deltaWeight must be a finite number");
    }
    if (this.status !== "open" || this.collapsed.has(racerId) || deltaWeight === 0) {
      return false;
    }
    // Never let the signal carry the weight below the floor, so a later
    // positive signal is not swallowed by accumulated negative weight.
    const minimumSignal = this.floorWeight() - this.baseLiquidity - (this.demand.get(racerId) ?? 0);
    const next = Math.max(minimumSignal, (this.signals.get(racerId) ?? 0) + deltaWeight);
    this.signals.set(racerId, next);
    this.prices = this.calculatePrices();
    return true;
  }

  /** Pins a racer's weight to the floor (e.g. the racer failed). Open only. */
  collapse(racerId: string): boolean {
    this.assertRacer(racerId);
    if (this.status !== "open" || this.collapsed.has(racerId)) {
      return false;
    }
    this.collapsed.add(racerId);
    this.prices = this.calculatePrices();
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
        costBasis: round(position.quantity * position.averagePrice),
        settlementPrice: won ? 1 : 0,
        payout,
        result: won ? "won" : "lost",
      });
    }
    this.positions.clear();
    this.settlement = lines;
    return payouts;
  }

  /** Voids the market: refunds every open position at its average price. */
  markUnresolved(now?: number): SettlementLine[] {
    this.assertUnsettled();
    this.status = "unresolved";
    const lines: SettlementLine[] = [];
    for (const position of this.positions.values()) {
      const refund = round(position.quantity * position.averagePrice);
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

  private calculatePrices(): Record<string, number> {
    const floor = this.floorWeight();
    let demandSum = 0;
    let adjustmentSum = 0;
    const weights = this.racerIds.map((racerId) => {
      const demand = this.demand.get(racerId) ?? 0;
      const base = this.baseLiquidity + demand;
      const weight = this.collapsed.has(racerId)
        ? floor
        : Math.max(floor, base + (this.signals.get(racerId) ?? 0));
      demandSum += demand;
      adjustmentSum += weight - base;
      return weight;
    });
    // With no signals every adjustment is exactly 0, so this is the original
    // `racers * L + sum(demand)` total and prices stay bit-for-bit identical.
    const totalWeight = this.racerIds.length * this.baseLiquidity + demandSum + adjustmentSum;

    const rounded = this.racerIds.map(
      (racerId, index) => [racerId, round(weights[index] / totalWeight)] as const,
    );
    const difference = round(1 - rounded.reduce((sum, [, price]) => sum + price, 0));
    const last = rounded[rounded.length - 1];
    rounded[rounded.length - 1] = [last[0], round(last[1] + difference)];
    return Object.fromEntries(rounded);
  }

  private floorWeight(): number {
    return FLOOR_RATIO * this.baseLiquidity;
  }

  /** YES adds demand to the racer; NO is a basket of the other three. */
  private demandTargets(racerId: string, side: Side): string[] {
    return side === "yes"
      ? [racerId]
      : this.racerIds.filter((candidate) => candidate !== racerId);
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

  private assertLimit(action: OrderAction, price: number, limitPrice?: number): void {
    if (limitPrice === undefined) return;
    if (typeof limitPrice !== "number" || !Number.isFinite(limitPrice) ||
      limitPrice < 0 || limitPrice > 1) {
      throw new DomainError("invalid", "limitPrice must be a number from 0 to 1");
    }
    if (action === "buy" && price > limitPrice + PRICE_TOLERANCE) {
      throw new DomainError(
        "price_moved",
        `price moved: ${price} is above the limit ${limitPrice}`,
      );
    }
    if (action === "sell" && price < limitPrice - PRICE_TOLERANCE) {
      throw new DomainError(
        "price_moved",
        `price moved: ${price} is below the limit ${limitPrice}`,
      );
    }
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
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new DomainError("invalid", "quantity must be a positive integer");
    }
  }

  private positionKey(userId: string, racerId: string, side: Side): string {
    return `${userId}\u0000${racerId}\u0000${side}`;
  }
}
