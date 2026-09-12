import assert from "node:assert/strict";
import test from "node:test";
import { VirtualPredictionMarket } from "../src/prediction/virtual-market.js";

const racers = ["racer-1", "racer-2", "racer-3", "racer-4"] as const;

test("starts with four equal 0.25 prices", () => {
  const market = new VirtualPredictionMarket(racers);
  assert.deepEqual(market.pricesSnapshot(), {
    "racer-1": 0.25,
    "racer-2": 0.25,
    "racer-3": 0.25,
    "racer-4": 0.25,
  });
});

test("buying shares shifts normalized prices", () => {
  const market = new VirtualPredictionMarket(racers);
  market.fund("spectator-1", 10);

  const receipt = market.buy("spectator-1", "racer-1", 10);
  assert.equal(receipt.price, 0.25);
  assert.equal(receipt.total, 2.5);
  assert.equal(market.balance("spectator-1"), 7.5);

  const prices = market.pricesSnapshot();
  assert.equal(prices["racer-1"], 0.268293);
  assert.equal(prices["racer-2"], 0.243902);
  assert.equal(Object.values(prices).reduce((sum, price) => sum + price, 0), 1);
});

test("sells positions at the current price", () => {
  const market = new VirtualPredictionMarket(racers);
  market.fund("spectator-1", 10);
  market.buy("spectator-1", "racer-1", 2);

  const receipt = market.sell("spectator-1", "racer-1", 1);
  assert.equal(receipt.price, 0.253731);
  assert.equal(receipt.total, 0.253731);
  assert.equal(market.position("spectator-1", "racer-1").quantity, 1);
});

test("freezes trading and resolves winning positions", () => {
  const market = new VirtualPredictionMarket(racers);
  market.fund("spectator-1", 10);
  market.buy("spectator-1", "racer-1", 2);
  market.freeze();

  assert.throws(() => market.buy("spectator-1", "racer-2", 1), /frozen/);
  const payouts = market.resolve("racer-1");
  assert.deepEqual(payouts, [{
    userId: "spectator-1",
    racerId: "racer-1",
    quantity: 2,
    payout: 2,
  }]);
  assert.equal(market.balance("spectator-1"), 11.5);
  assert.equal(market.status, "resolved");
});

test("rejects invalid balances and positions", () => {
  const market = new VirtualPredictionMarket(racers);
  assert.throws(() => market.fund("spectator-1", -1), /non-negative/);
  assert.throws(() => market.buy("spectator-1", "racer-1", 1), /insufficient/);
  assert.throws(() => market.sell("spectator-1", "racer-1", 1), /insufficient position/);
});
