import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/domain/errors.js";
import { VirtualPredictionMarket } from "../src/prediction/virtual-market.js";
import { InMemoryCreditLedger } from "../src/wallet/credit-ledger.js";

const racers = ["racer-1", "racer-2", "racer-3", "racer-4"] as const;

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sum(prices: Record<string, number>): number {
  return Object.values(prices).reduce((total, price) => total + price, 0);
}

function assertDomainError(fn: () => unknown, code: string, message?: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof DomainError, "expected a DomainError");
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

function fundedMarket(ledger = new InMemoryCreditLedger()) {
  const market = new VirtualPredictionMarket(racers, { ledger, raceId: "race-9" });
  market.fund("alice", 100);
  market.fund("bob", 100);
  return { market, ledger };
}

test("fund deposits virtual credits through the ledger", () => {
  const ledger = new InMemoryCreditLedger();
  const market = new VirtualPredictionMarket(racers, { ledger });
  market.fund("alice", 25, 1_000);
  assert.equal(market.balance("alice"), 25);
  assert.equal(ledger.balance("alice"), 25);
  const [entry] = ledger.entries("alice");
  assert.equal(entry.type, "deposit");
  assert.equal(entry.method, "virtual");
  assert.equal(entry.at, 1_000);
});

test("receipts carry the action and side; YES is the default side", () => {
  const { market } = fundedMarket();
  const receipt = market.buy("alice", "racer-1", 10);
  assert.deepEqual(receipt, {
    userId: "alice",
    racerId: "racer-1",
    action: "buy",
    side: "yes",
    quantity: 10,
    price: 0.25,
    total: 2.5,
  });
  const sold = market.sell("alice", "racer-1", 4);
  assert.equal(sold.action, "sell");
  assert.equal(sold.side, "yes");
});

test("NO is priced at 1 - YES and buys a basket of the other racers", () => {
  const { market } = fundedMarket();
  assert.equal(market.sidePrice("racer-1", "no"), 0.75);

  const receipt = market.buy("bob", "racer-1", 10, "no");
  assert.equal(receipt.price, 0.75);
  assert.equal(receipt.total, 7.5);
  assert.equal(market.balance("bob"), 92.5);

  const prices = market.pricesSnapshot();
  assert.equal(prices["racer-1"], round(100 / 430));
  assert.equal(prices["racer-2"], round(110 / 430));
  assert.equal(prices["racer-3"], round(110 / 430));
  assert.equal(round(sum(prices)), 1);
  assert.equal(sum(prices), 1);
  assert.equal(market.sidePrice("racer-1", "no"), round(1 - prices["racer-1"]));
  assert.deepEqual(market.position("bob", "racer-1", "no"), {
    userId: "bob",
    racerId: "racer-1",
    side: "no",
    quantity: 10,
    averagePrice: 0.75,
  });
  assert.equal(market.position("bob", "racer-1").quantity, 0);
});

test("selling NO removes basket demand and restores prices", () => {
  const { market } = fundedMarket();
  market.buy("bob", "racer-1", 10, "no");
  const price = market.sidePrice("racer-1", "no");
  const receipt = market.sell("bob", "racer-1", 10, "no");
  assert.equal(receipt.price, price);
  assert.equal(receipt.total, round(price * 10));
  assert.deepEqual(market.pricesSnapshot(), {
    "racer-1": 0.25,
    "racer-2": 0.25,
    "racer-3": 0.25,
    "racer-4": 0.25,
  });
  assert.equal(market.position("bob", "racer-1", "no").quantity, 0);
  assert.equal(market.balance("bob"), round(100 - 7.5 + receipt.total));
});

test("YES and NO positions on one racer are tracked separately", () => {
  const { market } = fundedMarket();
  market.buy("alice", "racer-2", 4);
  market.buy("alice", "racer-2", 6, "no");
  const positions = market.positionsFor("alice");
  assert.deepEqual(positions.map((position) => [position.racerId, position.side, position.quantity]), [
    ["racer-2", "yes", 4],
    ["racer-2", "no", 6],
  ]);
  assert.equal(market.allPositions().length, 2);
  assertDomainError(
    () => market.sell("alice", "racer-2", 5),
    "insufficient_position",
    /insufficient position to sell/,
  );
  assert.equal(market.positionsFor("bob").length, 0);
});

test("selling keeps the average price of the remaining position", () => {
  const { market } = fundedMarket();
  market.buy("alice", "racer-1", 10);
  market.buy("bob", "racer-1", 30);
  market.buy("alice", "racer-1", 10);
  const before = market.position("alice", "racer-1");
  assert.equal(before.averagePrice, round((0.25 * 10 + before.averagePrice * 20 - 0.25 * 10) / 20));
  market.sell("alice", "racer-1", 15);
  const after = market.position("alice", "racer-1");
  assert.equal(after.quantity, 5);
  assert.equal(after.averagePrice, before.averagePrice);
});

test("limit prices guard buys and sells", () => {
  const { market } = fundedMarket();
  assertDomainError(
    () => market.buy("alice", "racer-1", 1, "yes", { limitPrice: 0.24 }),
    "price_moved",
  );
  assert.equal(market.balance("alice"), 100);
  assert.equal(market.position("alice", "racer-1").quantity, 0);

  market.buy("alice", "racer-1", 1, "yes", { limitPrice: 0.25 - 1e-10 });
  market.buy("alice", "racer-1", 1, "no", { limitPrice: 0.75 });

  const yes = market.sidePrice("racer-1", "yes");
  assertDomainError(
    () => market.sell("alice", "racer-1", 1, "yes", { limitPrice: yes + 0.01 }),
    "price_moved",
  );
  market.sell("alice", "racer-1", 1, "yes", { limitPrice: yes });
  assertDomainError(
    () => market.buy("alice", "racer-1", 1, "yes", { limitPrice: 1.5 }),
    "invalid",
  );
  assertDomainError(
    () => market.buy("alice", "racer-1", 1, "yes", { limitPrice: Number.NaN }),
    "invalid",
  );
});

test("domain errors carry codes and keep their messages", () => {
  const market = new VirtualPredictionMarket(racers);
  assertDomainError(() => market.fund("alice", -1), "invalid", /non-negative/);
  assertDomainError(() => market.buy("alice", "racer-1", 1), "insufficient_balance", /insufficient/);
  assertDomainError(() => market.buy("alice", "racer-9", 1), "not_found");
  assertDomainError(() => market.buy("alice", "racer-1", 0), "invalid");
  assertDomainError(() => market.buy("alice", "racer-1", 1.5), "invalid");
  assertDomainError(
    () => market.buy("alice", "racer-1", 1, "maybe" as "yes"),
    "invalid",
  );
  market.freeze();
  assertDomainError(() => market.buy("alice", "racer-1", 1), "market_closed", /market is frozen/);
  market.resolve("racer-1");
  assertDomainError(() => market.resolve("racer-1"), "conflict");
  assertDomainError(() => market.markUnresolved(), "conflict");
  assertDomainError(() => new VirtualPredictionMarket(["a", "b"]), "invalid");
});

test("confidence signals move weights while open", () => {
  const market = new VirtualPredictionMarket(racers);
  assert.equal(market.adjustConfidence("racer-1", 35), true);
  const prices = market.pricesSnapshot();
  assert.equal(prices["racer-1"], round(135 / 435));
  assert.equal(prices["racer-2"], round(100 / 435));
  assert.equal(sum(prices), 1);

  assert.equal(market.adjustConfidence("racer-1", -35), true);
  assert.deepEqual(market.pricesSnapshot(), {
    "racer-1": 0.25,
    "racer-2": 0.25,
    "racer-3": 0.25,
    "racer-4": 0.25,
  });
  assert.equal(market.adjustConfidence("racer-1", 0), false);
  assert.throws(() => market.adjustConfidence("racer-1", Number.NaN), DomainError);

  market.freeze();
  assert.equal(market.adjustConfidence("racer-1", 35), false);
  assert.equal(market.pricesSnapshot()["racer-1"], 0.25);
});

test("weights are floored at 2% of base liquidity", () => {
  const market = new VirtualPredictionMarket(racers);
  market.adjustConfidence("racer-1", -1_000);
  const floored = market.pricesSnapshot();
  assert.equal(floored["racer-1"], round(2 / 302));
  // Exact at 6dp; the float sum of 6dp values can differ in the last ulp.
  assert.equal(round(sum(floored)), 1);

  // The accumulated signal stops at the floor, so a later boost counts.
  market.adjustConfidence("racer-1", 35);
  assert.equal(market.pricesSnapshot()["racer-1"], round(37 / 337));
});

test("collapse pins a racer to the floor while open", () => {
  const { market } = fundedMarket();
  assert.equal(market.collapse("racer-2"), true);
  assert.equal(market.isCollapsed("racer-2"), true);
  const prices = market.pricesSnapshot();
  assert.equal(prices["racer-2"], round(2 / 302));
  assert.equal(prices["racer-1"], round(100 / 302));
  assert.equal(round(sum(prices)), 1);

  assert.equal(market.collapse("racer-2"), false);
  assert.equal(market.adjustConfidence("racer-2", 35), false);
  // Demand no longer lifts a collapsed racer: it stays pinned to the floor.
  market.buy("alice", "racer-2", 10);
  assert.equal(market.pricesSnapshot()["racer-2"], round(2 / 302));
  assert.equal(round(sum(market.pricesSnapshot())), 1);

  const frozen = new VirtualPredictionMarket(racers);
  frozen.freeze();
  assert.equal(frozen.collapse("racer-1"), false);
});

test("quotes list YES and NO per racer in order", () => {
  const { market } = fundedMarket();
  market.buy("alice", "racer-1", 10);
  const quotes = market.quotes();
  assert.deepEqual(quotes.map((quote) => quote.racerId), [...racers]);
  for (const quote of quotes) {
    assert.equal(quote.no, round(1 - quote.yes));
  }
  assert.equal(quotes[0].yes, 0.268293);
});

test("resolution pays YES on the winner and NO on every loser", () => {
  const { market, ledger } = fundedMarket();
  market.buy("alice", "racer-1", 10);
  const noPrice = market.sidePrice("racer-1", "no");
  assert.equal(noPrice, 0.731707);
  market.buy("bob", "racer-1", 10, "no");
  market.fund("carol", 10);
  market.buy("carol", "racer-2", 5, "no");

  const payouts = market.resolve("racer-2", 5_000);
  assert.deepEqual(payouts, [
    { userId: "alice", racerId: "racer-1", quantity: 10, payout: 0 },
    { userId: "bob", racerId: "racer-1", quantity: 10, payout: 10 },
    { userId: "carol", racerId: "racer-2", quantity: 5, payout: 0 },
  ]);
  assert.equal(market.status, "resolved");
  assert.equal(market.winnerRacerId, "racer-2");
  assert.equal(market.balance("bob"), round(100 - 7.31707 + 10));
  assert.equal(market.balance("alice"), 97.5);
  assert.deepEqual(market.allPositions(), []);

  const lines = market.settlementLines();
  assert.deepEqual(lines[0], {
    userId: "alice",
    racerId: "racer-1",
    side: "yes",
    quantity: 10,
    averagePrice: 0.25,
    costBasis: 2.5,
    settlementPrice: 0,
    payout: 0,
    result: "lost",
  });
  assert.deepEqual(lines[1], {
    userId: "bob",
    racerId: "racer-1",
    side: "no",
    quantity: 10,
    averagePrice: 0.731707,
    costBasis: 7.31707,
    settlementPrice: 1,
    payout: 10,
    result: "won",
  });
  assert.equal(lines[2].result, "lost");
  assert.equal(lines[2].side, "no");

  const bobPayout = ledger.entries("bob").at(-1);
  assert.equal(bobPayout?.type, "payout");
  assert.equal(bobPayout?.amount, 10);
  assert.equal(bobPayout?.raceId, "race-9");
  assert.equal(bobPayout?.side, "no");
  assert.equal(bobPayout?.price, 0.731707);
  assert.equal(bobPayout?.at, 5_000);
  const aliceLoss = ledger.entries("alice").at(-1);
  assert.equal(aliceLoss?.type, "loss");
  assert.equal(aliceLoss?.amount, 0);
  assert.equal(aliceLoss?.price, 0.25);
  assert.equal(aliceLoss?.quantity, 10);
});

test("stats track volume, traders and per-racer flows", () => {
  const { market } = fundedMarket();
  market.buy("alice", "racer-1", 10);
  market.buy("bob", "racer-1", 10, "no");
  market.sell("alice", "racer-1", 4);
  const sellTotal = round(market.stats().volume - 2.5 - 7.31707);
  market.resolve("racer-1");

  const stats = market.stats();
  assert.equal(stats.traders, 2);
  assert.equal(stats.trades, 3);
  assert.equal(stats.volume, round(2.5 + 7.31707 + sellTotal));
  assert.deepEqual(stats.racers["racer-1"], {
    racerId: "racer-1",
    yesBuyCost: 2.5,
    yesSellProceeds: sellTotal,
    yesPayout: 6,
    noBuyCost: 7.31707,
    noSellProceeds: 0,
    noPayout: 0,
  });
  assert.equal(stats.racers["racer-2"].yesBuyCost, 0);
  assert.deepEqual(stats.lastPrices, market.pricesSnapshot());
  assert.equal(stats.refunded, 0);
});

test("an unresolved market refunds every position at its average price", () => {
  const { market, ledger } = fundedMarket();
  market.buy("alice", "racer-1", 10);
  const noPrice = market.sidePrice("racer-3", "no");
  market.buy("bob", "racer-3", 4, "no");

  const lines = market.markUnresolved(7_000);
  assert.equal(market.status, "unresolved");
  assert.equal(market.balance("alice"), 100);
  assert.equal(market.balance("bob"), 100);
  assert.deepEqual(lines.map((line) => [line.userId, line.side, line.payout, line.result]), [
    ["alice", "yes", 2.5, "refunded"],
    ["bob", "no", round(4 * noPrice), "refunded"],
  ]);
  assert.equal(lines[0].settlementPrice, null);
  assert.deepEqual(market.settlementLines(), lines);
  assert.equal(market.stats().refunded, round(2.5 + 4 * noPrice));

  const refund = ledger.entries("bob").at(-1);
  assert.equal(refund?.type, "refund");
  assert.equal(refund?.raceId, "race-9");
  assert.equal(refund?.price, noPrice);
  assert.equal(refund?.at, 7_000);
});

test("markets on a shared ledger share one balance", () => {
  const ledger = new InMemoryCreditLedger();
  ledger.credit("alice", 10, { type: "deposit" });
  const first = new VirtualPredictionMarket(racers, { ledger, raceId: "race-a" });
  const second = new VirtualPredictionMarket(racers, { ledger, raceId: "race-b" });
  first.buy("alice", "racer-1", 20);
  assert.equal(second.balance("alice"), 5);
  second.buy("alice", "racer-2", 20);
  assert.equal(ledger.balance("alice"), 0);
  assertDomainError(() => first.buy("alice", "racer-3", 1), "insufficient_balance");
  assert.deepEqual(
    ledger.entries("alice").map((entry) => entry.raceId ?? null),
    [null, "race-a", "race-b"],
  );
});
