import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/domain/errors.js";
import {
  MAX_ORDER_QUANTITY,
  ceilMicro,
  quoteTrade,
  sharesForBudget,
  slippageLimit,
  type PricingSide,
} from "../src/prediction/lmsr.js";
import { VirtualPredictionMarket } from "../src/prediction/virtual-market.js";
import { Rng } from "../src/simulation/rng.js";
import { InMemoryCreditLedger } from "../src/wallet/credit-ledger.js";

const racers = ["racer-1", "racer-2", "racer-3", "racer-4"];
const sides: PricingSide[] = ["yes", "no"];

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Funding stays below 1e9 so balances keep exact micro-credits in a double. */
function funded(credits = 1e8): VirtualPredictionMarket {
  const market = new VirtualPredictionMarket(racers, { raceId: "race-p" });
  for (const userId of ["alice", "bob"]) market.fund(userId, credits);
  return market;
}

/** Moves the book away from 25/25/25/25. */
function skew(market: VirtualPredictionMarket): void {
  market.adjustConfidence("racer-1", 35);
  market.buy("bob", "racer-2", 2_500);
  market.buy("bob", "racer-3", 800, "no");
}

function assertNormalized(market: VirtualPredictionMarket): void {
  const prices = Object.values(market.pricesSnapshot());
  assert.equal(round6(prices.reduce((total, price) => total + price, 0)), 1);
  for (const price of prices) assert.ok(price >= 1e-6 && price <= 1 - 1e-6, `${price} is inside (0, 1)`);
}

test("a buy pays the integral of the price along its own impact", () => {
  const market = funded();
  const receipt = market.buy("alice", "racer-1", 1_000);
  // b·ln(1 − p + p·e^(n/b)) with b = 1000, p = 0.25 and n = 1000.
  assert.equal(receipt.total, ceilMicro(1_000 * Math.log(0.75 + 0.25 * Math.E)));
  const after = market.sidePrice("racer-1");
  assert.equal(after, round6(Math.E / (3 + Math.E)));
  assert.ok(receipt.price > 0.25 && receipt.price < after, "the average sits between the old and new price");
});

test("buying then selling straight back never profits, YES or NO, small or huge", () => {
  for (const skewed of [false, true]) {
    for (const side of sides) {
      for (const quantity of [1, 7, 300, 1_000, 5_337, 100_000, MAX_ORDER_QUANTITY]) {
        const market = funded();
        if (skewed) skew(market);
        const before = market.balance("alice");
        market.buy("alice", "racer-2", quantity, side);
        market.sell("alice", "racer-2", quantity, side);
        const net = market.balance("alice") - before;
        const label = `${side} × ${quantity}${skewed ? " (skewed)" : ""}`;
        assert.ok(net <= 0, `${label} made ${net}`);
        assert.ok(net > -1e-5, `${label} lost more than rounding: ${net}`);
      }
    }
  }
});

test("no sequence of one trader's orders makes money once it is all sold", () => {
  const rng = new Rng("pricing-cycles");
  const market = funded();
  skew(market);
  const start = market.balance("alice");
  let orders = 0;
  for (let index = 0; index < 300; index += 1) {
    const racerId = rng.pick(racers);
    const side = rng.pick(sides);
    const held = market.position("alice", racerId, side).quantity;
    if (held > 0 && rng.chance(0.4)) market.sell("alice", racerId, rng.int(1, held), side);
    else market.buy("alice", racerId, rng.int(1, 3_000), side);
    orders += 1;
  }
  for (const position of market.positionsFor("alice")) {
    market.sell("alice", position.racerId, position.quantity, position.side);
    orders += 1;
  }
  const net = market.balance("alice") - start;
  assert.ok(net <= 0, `the cycle made ${net}`);
  assert.ok(net > -2e-6 * orders - 1e-6, `only rounding is lost: ${net}`);
});

test("prices stay normalized through trades, signals, a collapse and extreme books", () => {
  const rng = new Rng("pricing-normal");
  const market = funded();
  for (let index = 0; index < 200; index += 1) {
    const racerId = rng.pick(racers);
    if (index === 120) market.collapse("racer-4");
    if (index % 17 === 0) market.adjustConfidence(racerId, rng.range(-40, 50));
    const side = rng.pick(sides);
    market.buy(rng.chance(0.5) ? "alice" : "bob", racerId, rng.int(1, 20_000), side);
    assertNormalized(market);
  }
  market.buy("alice", "racer-1", 60_000);
  assertNormalized(market);
  assert.ok(market.sidePrice("racer-2") > 0, "a long shot never reads as settled");
});

test("the quote computed from pricing() is exactly the fill", () => {
  const rng = new Rng("pricing-quotes");
  const market = funded();
  skew(market);
  for (let index = 0; index < 120; index += 1) {
    const racerId = rng.pick(racers);
    const side = rng.pick(sides);
    const { depth, logOdds } = market.pricing();
    const budget = round6(rng.range(0.5, 5_000));
    const shares = sharesForBudget(logOdds[racerId], side, budget, depth);
    if (shares === 0) continue;
    const quoted = quoteTrade(logOdds[racerId], side, "buy", shares, depth);
    assert.ok(quoted.total <= budget, "a budget quote never overspends");
    assert.ok(quoteTrade(logOdds[racerId], side, "buy", shares + 1, depth).total > budget, "one more share would");
    const fill = market.buy("alice", racerId, shares, side, { limitPrice: quoted.averagePrice });
    assert.equal(fill.total, quoted.total);
    assert.equal(fill.price, quoted.averagePrice);

    const back = rng.int(1, shares);
    const after = market.pricing();
    const sellQuote = quoteTrade(after.logOdds[racerId], side, "sell", back, after.depth);
    const sold = market.sell("alice", racerId, back, side, { limitPrice: sellQuote.averagePrice });
    assert.equal(sold.total, sellQuote.total);
    assert.equal(sold.price, sellQuote.averagePrice);
  }
});

test("a limit allows slippage on the average price and reports where the price went", () => {
  const market = funded();
  const start = market.pricing();
  const quote = quoteTrade(start.logOdds["racer-1"], "yes", "buy", 400, start.depth);
  market.buy("bob", "racer-1", 20);
  const filled = market.buy("alice", "racer-1", 400, "yes", {
    limitPrice: slippageLimit("buy", quote.averagePrice),
  });
  assert.ok(filled.price > quote.averagePrice, "the price moved against the order");
  assert.ok(filled.price <= slippageLimit("buy", quote.averagePrice), "but within tolerance");

  const next = market.pricing();
  const again = quoteTrade(next.logOdds["racer-1"], "yes", "buy", 400, next.depth);
  market.buy("bob", "racer-1", 1_500);
  assert.throws(
    () => market.buy("alice", "racer-1", 400, "yes", { limitPrice: slippageLimit("buy", again.averagePrice) }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "price_moved");
      assert.equal(error.details?.price, market.sidePrice("racer-1"));
      assert.equal(error.details?.logOdds, market.pricing().logOdds["racer-1"]);
      assert.equal(error.details?.averagePrice, market.quote("racer-1", "yes", "buy", 400).averagePrice);
      assert.equal(error.details?.quantity, 400);
      assert.match(error.message, /^price moved to 0\.\d+/);
      return true;
    },
  );

  const held = market.position("alice", "racer-1").quantity;
  const sellQuote = market.quote("racer-1", "yes", "sell", held);
  market.buy("bob", "racer-1", 2_000, "no");
  assert.throws(
    () => market.sell("alice", "racer-1", held, "yes", { limitPrice: slippageLimit("sell", sellQuote.averagePrice) }),
    /price moved/,
  );
});

test("positions are marked at what selling them returns, so a fresh buy shows no profit", () => {
  const market = funded();
  const buy = market.buy("alice", "racer-4", 5_337);
  const value = market.liquidationValue("racer-4", "yes", 5_337);
  assert.ok(value <= buy.total && value > buy.total - 1e-5, `${value} vs ${buy.total}`);
  assert.ok(value < 5_337 * market.sidePrice("racer-4"), "below quantity × the marginal price");
  assert.equal(market.sell("alice", "racer-4", 5_337).total, value);
});

test("a void refunds exactly what open positions cost", () => {
  const ledger = new InMemoryCreditLedger();
  const market = new VirtualPredictionMarket(racers, { ledger, raceId: "race-v" });
  market.fund("alice", 1_000);
  market.fund("bob", 1_000);
  const yes = market.buy("alice", "racer-1", 300);
  const no = market.buy("alice", "racer-2", 120, "no");
  const bobBuy = market.buy("bob", "racer-1", 500, "no");
  const bobSell = market.sell("bob", "racer-1", 200, "no");

  const lines = market.markUnresolved(9_000);
  assert.equal(market.balance("alice"), 1_000, "a buy-and-hold trader is made whole");
  assert.deepEqual(lines.map((line) => [line.userId, line.payout]), [
    ["alice", yes.total],
    ["alice", no.total],
    ["bob", lines[2].payout],
  ]);
  assert.ok(Math.abs(lines[2].payout - (bobBuy.total * 300) / 500) < 1e-6, "the remainder refunds its share");
  assert.equal(market.balance("bob"), round6(1_000 - bobBuy.total + bobSell.total + lines[2].payout));
  assert.equal(market.stats().refunded, round6(yes.total + no.total + lines[2].payout));
});

test("settlement pays a credit per winning share, and a full set never beats its cost", () => {
  const market = funded(1e6);
  let paid = 0;
  for (const racerId of racers) paid += market.buy("alice", racerId, 250).total;
  assert.ok(paid >= 250 && paid < 250 + 1e-5, `a full set of YES costs its payout: ${paid}`);
  market.freeze();
  market.resolve("racer-3");
  assert.equal(market.balance("alice"), round6(1e6 - paid + 250));
});

test("a collapsed racer drops to the floor and NO on it earns a bounded amount", () => {
  const market = funded();
  market.buy("bob", "racer-3", 3_000);
  market.collapse("racer-3");
  assert.equal(market.sidePrice("racer-3"), round6(2 / 302));
  const no = market.buy("alice", "racer-3", 1_000_000, "no");
  assert.ok(no.total > 1_000_000 - 7, `the sure thing is worth under 7 credits: ${1_000_000 - no.total}`);
});

test("orders are whole shares up to the maximum", () => {
  const market = funded();
  assert.throws(
    () => market.buy("alice", "racer-1", MAX_ORDER_QUANTITY + 1),
    (error: unknown) => error instanceof DomainError && error.code === "invalid",
  );
});
