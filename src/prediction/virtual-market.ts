export type MarketStatus = "open" | "frozen" | "resolved" | "unresolved";

export type PredictionPosition = {
  userId: string;
  racerId: string;
  quantity: number;
  averagePrice: number;
};

export type TradeReceipt = {
  userId: string;
  racerId: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  total: number;
};

export type ResolutionPayout = {
  userId: string;
  racerId: string;
  quantity: number;
  payout: number;
};

const PRECISION = 1_000_000;

function round(value: number): number {
  return Math.round(value * PRECISION) / PRECISION;
}

export class VirtualPredictionMarket {
  readonly racerIds: readonly string[];
  status: MarketStatus = "open";
  winnerRacerId?: string;

  private readonly balances = new Map<string, number>();
  private readonly positions = new Map<string, PredictionPosition>();
  private readonly demand = new Map<string, number>();
  private readonly baseLiquidity: number;
  private prices: Record<string, number>;

  constructor(
    racerIds: readonly string[],
    options: { baseLiquidity?: number } = {},
  ) {
    if (racerIds.length !== 4 || new Set(racerIds).size !== 4) {
      throw new Error("A prediction market requires four unique racers");
    }
    this.baseLiquidity = options.baseLiquidity ?? 100;
    if (!Number.isFinite(this.baseLiquidity) || this.baseLiquidity <= 0) {
      throw new Error("baseLiquidity must be a positive number");
    }
    this.racerIds = [...racerIds];
    for (const racerId of racerIds) {
      this.demand.set(racerId, 0);
    }
    this.prices = this.calculatePrices();
  }

  fund(userId: string, credits: number): void {
    if (!Number.isFinite(credits) || credits < 0) {
      throw new Error("credits must be a non-negative number");
    }
    this.balances.set(userId, round((this.balances.get(userId) ?? 0) + credits));
  }

  balance(userId: string): number {
    return this.balances.get(userId) ?? 0;
  }

  pricesSnapshot(): Record<string, number> {
    return { ...this.prices };
  }

  position(userId: string, racerId: string): PredictionPosition {
    this.assertRacer(racerId);
    return {
      userId,
      racerId,
      quantity: this.positions.get(this.positionKey(userId, racerId))?.quantity ?? 0,
      averagePrice: this.positions.get(this.positionKey(userId, racerId))?.averagePrice ?? 0,
    };
  }

  buy(userId: string, racerId: string, quantity: number): TradeReceipt {
    this.assertTradable();
    this.assertRacer(racerId);
    this.assertQuantity(quantity);

    const price = this.prices[racerId];
    const total = round(price * quantity);
    const balance = this.balance(userId);
    if (balance < total) {
      throw new Error("insufficient virtual credits");
    }

    this.balances.set(userId, round(balance - total));
    const key = this.positionKey(userId, racerId);
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
      quantity: nextQuantity,
      averagePrice,
    });
    this.demand.set(racerId, (this.demand.get(racerId) ?? 0) + quantity);
    this.prices = this.calculatePrices();

    return { userId, racerId, side: "buy", quantity, price, total };
  }

  sell(userId: string, racerId: string, quantity: number): TradeReceipt {
    this.assertTradable();
    this.assertRacer(racerId);
    this.assertQuantity(quantity);

    const key = this.positionKey(userId, racerId);
    const position = this.positions.get(key);
    if (!position || position.quantity < quantity) {
      throw new Error("insufficient position to sell");
    }

    const price = this.prices[racerId];
    const total = round(price * quantity);
    const remaining = position.quantity - quantity;
    if (remaining === 0) {
      this.positions.delete(key);
    } else {
      this.positions.set(key, { ...position, quantity: remaining });
    }
    this.balances.set(userId, round(this.balance(userId) + total));
    this.demand.set(racerId, Math.max(0, (this.demand.get(racerId) ?? 0) - quantity));
    this.prices = this.calculatePrices();

    return { userId, racerId, side: "sell", quantity, price, total };
  }

  freeze(): void {
    if (this.status === "open") {
      this.status = "frozen";
    }
  }

  resolve(winnerRacerId: string): ResolutionPayout[] {
    if (this.status === "resolved" || this.status === "unresolved") {
      throw new Error("market is already resolved");
    }
    this.assertRacer(winnerRacerId);
    this.status = "resolved";
    this.winnerRacerId = winnerRacerId;

    const payouts: ResolutionPayout[] = [];
    for (const position of this.positions.values()) {
      const payout = position.racerId === winnerRacerId ? position.quantity : 0;
      if (payout > 0) {
        this.balances.set(
          position.userId,
          round(this.balance(position.userId) + payout),
        );
      }
      payouts.push({
        userId: position.userId,
        racerId: position.racerId,
        quantity: position.quantity,
        payout,
      });
    }
    this.positions.clear();
    return payouts;
  }

  markUnresolved(): void {
    if (this.status === "resolved" || this.status === "unresolved") {
      throw new Error("market is already resolved");
    }
    this.status = "unresolved";
    for (const position of this.positions.values()) {
      this.balances.set(
        position.userId,
        round(this.balance(position.userId) + position.quantity * position.averagePrice),
      );
    }
    this.positions.clear();
  }

  private calculatePrices(): Record<string, number> {
    const totalDemand = this.racerIds.length * this.baseLiquidity +
      [...this.demand.values()].reduce((sum, value) => sum + value, 0);

    const raw = this.racerIds.map((racerId) => ({
      racerId,
      price: (this.baseLiquidity + (this.demand.get(racerId) ?? 0)) / totalDemand,
    }));
    const rounded = raw.map(({ racerId, price }) => [racerId, round(price)] as const);
    const difference = round(1 - rounded.reduce((sum, [, price]) => sum + price, 0));
    const last = rounded[rounded.length - 1];
    rounded[rounded.length - 1] = [last[0], round(last[1] + difference)];
    return Object.fromEntries(rounded);
  }

  private assertTradable(): void {
    if (this.status !== "open") {
      throw new Error(`market is ${this.status}`);
    }
  }

  private assertRacer(racerId: string): void {
    if (!this.racerIds.includes(racerId)) {
      throw new Error(`unknown racer: ${racerId}`);
    }
  }

  private assertQuantity(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error("quantity must be a positive integer");
    }
  }

  private positionKey(userId: string, racerId: string): string {
    return `${userId}:${racerId}`;
  }
}
