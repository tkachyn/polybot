import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/domain/errors.js";
import { priceFromLogOdds } from "../src/prediction/lmsr.js";
import { VirtualPredictionMarket } from "../src/prediction/virtual-market.js";
import { InMemoryCreditLedger } from "../src/wallet/credit-ledger.js";

const racers = ["racer-1", "racer-2", "racer-3", "racer-4"] as const;
const EVEN = { "racer-1": 0.25, "racer-2": 0.25, "racer-3": 0.25, "racer-4": 0.25 };

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
  const quote = market.quote("racer-1", "yes", "buy", 10);
  const receipt = market.buy("alice", "racer-1", 10);
  assert.deepEqual(receipt, {
    userId: "alice",
    racerId: "racer-1",
    action: "buy",
    side: "yes",
    quantity: 10,
    price: quote.averagePrice,
    total: quote.total,
  });
  const sold = market.sell("alice", "racer-1", 4);
  assert.equal(sold.action, "sell");
  assert.equal(sold.side, "yes");
});

test("NO is priced at 1 - YES and buys a basket of the other racers", () => {
  const { market } = fundedMarket();
  assert.equal(market.sidePrice("racer-1", "no"), 0.75);

  const receipt = market.buy("bob", "racer-1", 10, "no");
  assert.ok(receipt.price > 0.75 && receipt.price < market.sidePrice("racer-1", "no"));
  assert.equal(market.balance("bob"), round(100 - receipt.total));

  const prices = market.pricesSnapshot();
  assert.ok(prices["racer-1"] < 0.25, "NO on racer-1 drops its YES price");
  assert.equal(prices["racer-2"], prices["racer-3"]);
  // The last racer absorbs the rounding that keeps the sum at exactly 1.
  assert.ok(Math.abs(prices["racer-4"] - prices["racer-3"]) < 2e-6);
  assert.equal(round(sum(prices)), 1);
  assert.equal(prices["racer-1"], round(priceFromLogOdds(market.pricing().logOdds["racer-1"])));
  assert.equal(market.sidePrice("racer-1", "no"), round(1 - prices["racer-1"]));
  assert.deepEqual(market.position("bob", "racer-1", "no"), {
    userId: "bob",
    racerId: "racer-1",
    side: "no",
    quantity: 10,
    averagePrice: receipt.price,
    costBasis: receipt.total,
  });
  assert.equal(market.position("bob", "racer-1").quantity, 0);
});

test("selling NO back restores prices and never returns more than it cost", () => {
  const { market } = fundedMarket();
  const bought = market.buy("bob", "racer-1", 10, "no");
  const quote = market.quote("racer-1", "no", "sell", 10);
  const receipt = market.sell("bob", "racer-1", 10, "no");
  assert.equal(receipt.total, quote.total);
  assert.ok(receipt.total <= bought.total);
  assert.deepEqual(market.pricesSnapshot(), EVEN);
  assert.equal(market.position("bob", "racer-1", "no").quantity, 0);
  assert.equal(market.balance("bob"), round(100 - bought.total + receipt.total));
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

test("selling keeps the average price and releases cost pro rata", () => {
  const { market } = fundedMarket();
  const first = market.buy("alice", "racer-1", 10);
  market.buy("bob", "racer-1", 30);
  const second = market.buy("alice", "racer-1", 10);
  const before = market.position("alice", "racer-1");
  assert.ok(Math.abs(before.costBasis - (first.total + second.total)) < 1e-9);
  assert.ok(Math.abs(before.averagePrice - (first.total + second.total) / 20) < 1e-6);
  market.sell("alice", "racer-1", 15);
  const after = market.position("alice", "racer-1");
  assert.equal(after.quantity, 5);
  assert.equal(after.averagePrice, before.averagePrice);
  assert.ok(Math.abs(after.costBasis - before.costBasis / 4) < 1e-9);
});

test("limit prices guard the average fill price", () => {
  const { market } = fundedMarket();
  assertDomainError(
    () => market.buy("alice", "racer-1", 1, "yes", { limitPrice: 0.25 }),
    "price_moved",
  );
  assert.equal(market.balance("alice"), 100);
  assert.equal(market.position("alice", "racer-1").quantity, 0);

  market.buy("alice", "racer-1", 1, "yes", { limitPrice: market.quote("racer-1", "yes", "buy", 1).averagePrice });
  market.buy("alice", "racer-1", 1, "no", { limitPrice: market.quote("racer-1", "no", "buy", 1).averagePrice });

  const sell = market.quote("racer-1", "yes", "sell", 1);
  assertDomainError(
    () => market.sell("alice", "racer-1", 1, "yes", { limitPrice: sell.averagePrice + 0.01 }),
    "price_moved",
  );
  market.sell("alice", "racer-1", 1, "yes", { limitPrice: sell.averagePrice });
  assertDomainError(() => market.buy("alice", "racer-1", 1, "yes", { limitPrice: 1.5 }), "invalid");
  assertDomainError(() => market.buy("alice", "racer-1", 1, "yes", { limitPrice: Number.NaN }), "invalid");
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
  assert.deepEqual(market.pricesSnapshot(), EVEN);
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

test("collapse drops a racer to the floor while open", () => {
  const { market } = fundedMarket();
  assert.equal(market.collapse("racer-2"), true);
  assert.equal(market.isCollapsed("racer-2"), true);
  const prices = market.pricesSnapshot();
  assert.equal(prices["racer-2"], round(2 / 302));
  assert.equal(prices["racer-1"], round(100 / 302));
  assert.equal(round(sum(prices)), 1);

  assert.equal(market.collapse("racer-2"), false);
  assert.equal(market.adjustConfidence("racer-2", 35), false);
  // Trades still price along the curve, so the floor is never free to buy.
  const bought = market.buy("alice", "racer-2", 10);
  assert.ok(bought.price > round(2 / 302));
  assert.ok(market.pricesSnapshot()["racer-2"] < 0.007);
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
  assert.equal(quotes[0].yes, market.pricesSnapshot()["racer-1"]);
  assert.ok(quotes[0].yes > 0.25);
});

test("resolution pays YES on the winner and NO on every loser", () => {
  const { market, ledger } = fundedMarket();
  const alice = market.buy("alice", "racer-1", 10);
  const bob = market.buy("bob", "racer-1", 10, "no");
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
  assert.equal(market.balance("bob"), round(100 - bob.total + 10));
  assert.equal(market.balance("alice"), round(100 - alice.total));
  assert.deepEqual(market.allPositions(), []);

  const lines = market.settlementLines();
  assert.deepEqual(lines[0], {
    userId: "alice",
    racerId: "racer-1",
    side: "yes",
    quantity: 10,
    averagePrice: alice.price,
    costBasis: alice.total,
    settlementPrice: 0,
    payout: 0,
    result: "lost",
  });
  assert.deepEqual(lines[1], {
    userId: "bob",
    racerId: "racer-1",
    side: "no",
    quantity: 10,
    averagePrice: bob.price,
    costBasis: bob.total,
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
  assert.equal(bobPayout?.price, bob.price);
  assert.equal(bobPayout?.at, 5_000);
  const aliceLoss = ledger.entries("alice").at(-1);
  assert.equal(aliceLoss?.type, "loss");
  assert.equal(aliceLoss?.amount, 0);
  assert.equal(aliceLoss?.price, alice.price);
  assert.equal(aliceLoss?.quantity, 10);
});

test("stats track volume, traders and per-racer flows", () => {
  const { market } = fundedMarket();
  const alice = market.buy("alice", "racer-1", 10);
  const bob = market.buy("bob", "racer-1", 10, "no");
  const sold = market.sell("alice", "racer-1", 4);
  market.resolve("racer-1");

  const stats = market.stats();
  assert.equal(stats.traders, 2);
  assert.equal(stats.trades, 3);
  assert.equal(stats.volume, round(alice.total + bob.total + sold.total));
  assert.deepEqual(stats.racers["racer-1"], {
    racerId: "racer-1",
    yesBuyCost: alice.total,
    yesSellProceeds: sold.total,
    yesPayout: 6,
    noBuyCost: bob.total,
    noSellProceeds: 0,
    noPayout: 0,
  });
  assert.equal(stats.racers["racer-2"].yesBuyCost, 0);
  assert.deepEqual(stats.lastPrices, market.pricesSnapshot());
  assert.equal(stats.refunded, 0);
});

test("an unresolved market refunds every position what it cost", () => {
  const { market, ledger } = fundedMarket();
  const alice = market.buy("alice", "racer-1", 10);
  const bob = market.buy("bob", "racer-3", 4, "no");

  const lines = market.markUnresolved(7_000);
  assert.equal(market.status, "unresolved");
  assert.equal(market.balance("alice"), 100);
  assert.equal(market.balance("bob"), 100);
  assert.deepEqual(lines.map((line) => [line.userId, line.side, line.payout, line.result]), [
    ["alice", "yes", alice.total, "refunded"],
    ["bob", "no", bob.total, "refunded"],
  ]);
  assert.equal(lines[0].settlementPrice, null);
  assert.deepEqual(market.settlementLines(), lines);
  assert.equal(market.stats().refunded, round(alice.total + bob.total));

  const refund = ledger.entries("bob").at(-1);
  assert.equal(refund?.type, "refund");
  assert.equal(refund?.raceId, "race-9");
  assert.equal(refund?.price, bob.price);
  assert.equal(refund?.at, 7_000);
});

test("markets on a shared ledger share one balance", () => {
  const ledger = new InMemoryCreditLedger();
  ledger.credit("alice", 10, { type: "deposit" });
  const first = new VirtualPredictionMarket(racers, { ledger, raceId: "race-a" });
  const second = new VirtualPredictionMarket(racers, { ledger, raceId: "race-b" });
  const a = first.buy("alice", "racer-1", 20);
  assert.equal(second.balance("alice"), round(10 - a.total));
  const b = second.buy("alice", "racer-2", 15);
  assert.equal(ledger.balance("alice"), round(10 - a.total - b.total));
  assertDomainError(() => first.buy("alice", "racer-3", 20), "insufficient_balance");
  assert.deepEqual(
    ledger.entries("alice").map((entry) => entry.raceId ?? null),
    [null, "race-a", "race-b"],
  );
});
