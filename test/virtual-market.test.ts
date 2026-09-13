import assert from "node:assert/strict";
import test from "node:test";
import { VirtualPredictionMarket } from "../src/prediction/virtual-market.js";

const racers = ["racer-1", "racer-2", "racer-3", "racer-4"] as const;

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

test("starts with four equal 0.25 prices", () => {
  const market = new VirtualPredictionMarket(racers);
  assert.deepEqual(market.pricesSnapshot(), {
    "racer-1": 0.25,
    "racer-2": 0.25,
    "racer-3": 0.25,
    "racer-4": 0.25,
  });
});

test("lists distinct traders in first-trade order", () => {
  const market = new VirtualPredictionMarket(racers);
  market.fund("user-1", 10);
  market.fund("user-2", 10);
  market.buy("user-1", "racer-1", 1);
  market.buy("user-2", "racer-2", 1);
  market.buy("user-1", "racer-3", 1);
  assert.deepEqual(market.traderUserIds(), ["user-1", "user-2"]);
});

test("buying shares fills along the curve and shifts normalized prices", () => {
  const market = new VirtualPredictionMarket(racers);
  market.fund("spectator-1", 10);

  // 10 shares at depth 1000: 1000·ln(0.75 + 0.25·e^0.01), rounded up.
  const receipt = market.buy("spectator-1", "racer-1", 10);
  assert.equal(receipt.total, 2.509391);
  assert.equal(receipt.price, 0.25094);
  assert.equal(market.balance("spectator-1"), 7.490609);

  const prices = market.pricesSnapshot();
  assert.ok(prices["racer-1"] > receipt.price, "the new price is above the average paid");
  assert.equal(prices["racer-2"], prices["racer-3"]);
  assert.ok(prices["racer-2"] < 0.25);
  assert.equal(round(Object.values(prices).reduce((sum, price) => sum + price, 0)), 1);
});

test("sells along the curve below the current price", () => {
  const market = new VirtualPredictionMarket(racers);
  market.fund("spectator-1", 10);
  market.buy("spectator-1", "racer-1", 2);
  const price = market.sidePrice("racer-1");
  const quote = market.quote("racer-1", "yes", "sell", 1);

  const receipt = market.sell("spectator-1", "racer-1", 1);
  assert.equal(receipt.total, quote.total);
  assert.equal(receipt.price, quote.averagePrice);
  assert.ok(receipt.price < price);
  assert.equal(market.position("spectator-1", "racer-1").quantity, 1);
});

test("freezes trading and resolves winning positions", () => {
  const market = new VirtualPredictionMarket(racers);
  market.fund("spectator-1", 10);
  const bought = market.buy("spectator-1", "racer-1", 2);
  market.freeze();

  assert.throws(() => market.buy("spectator-1", "racer-2", 1), /frozen/);
  const payouts = market.resolve("racer-1");
  assert.deepEqual(payouts, [{
    userId: "spectator-1",
    racerId: "racer-1",
    quantity: 2,
    payout: 2,
  }]);
  assert.equal(market.balance("spectator-1"), round(10 - bought.total + 2));
  assert.equal(market.status, "resolved");
});

test("rejects invalid balances and positions", () => {
  const market = new VirtualPredictionMarket(racers);
  assert.throws(() => market.fund("spectator-1", -1), /non-negative/);
  assert.throws(() => market.buy("spectator-1", "racer-1", 1), /insufficient/);
  assert.throws(() => market.sell("spectator-1", "racer-1", 1), /insufficient position/);
});
