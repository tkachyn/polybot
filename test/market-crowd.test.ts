import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MarketCrowd, brandPrior } from "../src/prediction/market-crowd.js";
import { RaceRegistry } from "../src/api/race-registry.js";
import type { RaceCoordinator } from "../src/application/race-coordinator.js";
import { createFactory, raceInput } from "./api-fixtures.js";

/**
 * A coordinator with no I/O: the crowd only needs the market, the engine's
 * racer states and placeOrder, all of which are real here.
 */
async function registryWithRace(now: number): Promise<{ registry: RaceRegistry; raceId: string }> {
  const { factory } = createFactory();
  const registry = new RaceRegistry(factory, { startingBalance: 1_000 });
  const raceId = "crowd-test";
  await registry.create(raceInput(raceId), now);
  return { registry, raceId };
}

/** Runs the crowd for `rounds` ticks, one second apart. */
function run(crowd: MarketCrowd, from: number, rounds: number): void {
  for (let i = 0; i < rounds; i += 1) crowd.tick(from + i * 1_000);
}

describe("market crowd", () => {
  it("brand priors lift favoured vendors and leave unknown ones alone", () => {
    assert.ok(brandPrior("claude") > brandPrior("grok"), "claude carries more standing than grok");
    assert.ok(brandPrior("gpt") > brandPrior("deepseek"), "gpt carries more standing than deepseek");
    assert.equal(brandPrior("some-new-model"), 1, "an unknown vendor is neither helped nor punished");
    assert.equal(brandPrior(undefined), 1);
  });

  it("moves price and volume on an otherwise idle market", async () => {
    const now = 1_700_000_000_000;
    const { registry, raceId } = await registryWithRace(now);
    const race = registry.get(raceId) as RaceCoordinator;
    const before = race.market.pricesSnapshot();
    const openingVolume = race.market.stats().volume;

    const crowd = new MarketCrowd(registry, { seed: "crowd-test", size: 8 });
    crowd.prepare(now); // Drive it by hand; no timers in the test.
    run(crowd, now, 40);

    const after = race.market.pricesSnapshot();
    const stats = race.market.stats();

    assert.ok(stats.volume > openingVolume, "the crowd traded");
    assert.ok(stats.traders > 0, "the market has traders");
    const moved = race.market.racerIds.filter((id) => Math.abs(after[id] - before[id]) > 0.001);
    assert.ok(moved.length > 0, "prices moved without any checkpoint");
    await registry.shutdown();
  });

  it("keeps prices moving round to round instead of settling on one answer", async () => {
    const now = 1_700_000_000_000;
    const { registry, raceId } = await registryWithRace(now);
    const race = registry.get(raceId) as RaceCoordinator;

    const crowd = new MarketCrowd(registry, { seed: "wiggle", size: 10 });
    crowd.prepare(now);

    const leadPrices: number[] = [];
    const leadId = race.market.racerIds[0];
    for (let i = 0; i < 30; i += 1) {
      crowd.tick(now + i * 1_000);
      leadPrices.push(race.market.pricesSnapshot()[leadId]);
    }

    // A crowd that converged would repeat the same price; an imperfect one
    // keeps nudging it both ways.
    const distinct = new Set(leadPrices.map((price) => price.toFixed(3)));
    assert.ok(distinct.size > 3, `expected a moving price, saw ${distinct.size} distinct values`);

    let ups = 0;
    let downs = 0;
    for (let i = 1; i < leadPrices.length; i += 1) {
      if (leadPrices[i] > leadPrices[i - 1]) ups += 1;
      if (leadPrices[i] < leadPrices[i - 1]) downs += 1;
    }
    assert.ok(ups > 0 && downs > 0, `expected two-way flow, saw ${ups} up and ${downs} down`);
    await registry.shutdown();
  });

  it("every trader is flagged automated, so judge standings ignore them", async () => {
    const now = 1_700_000_000_000;
    const { registry } = await registryWithRace(now);
    const crowd = new MarketCrowd(registry, { seed: "flags", size: 6 });
    crowd.prepare(now);

    assert.equal(crowd.traders.length, 6);
    for (const trader of crowd.traders) {
      const user = registry.users.get(trader.userId);
      assert.ok(user, `${trader.userId} is registered`);
      assert.equal(user.automated, true, `${trader.userId} is flagged automated`);
    }
    await registry.shutdown();
  });

  it("traders differ from one another, so they do not act in lockstep", async () => {
    const now = 1_700_000_000_000;
    const { registry } = await registryWithRace(now);
    const crowd = new MarketCrowd(registry, { seed: "spread", size: 12 });
    crowd.prepare(now);

    const skills = new Set(crowd.traders.map((t) => t.skill.toFixed(3)));
    const delays = new Set(crowd.traders.map((t) => t.reactionMs.toFixed(0)));
    const cadences = new Set(crowd.traders.map((t) => t.cadenceMs.toFixed(0)));
    assert.ok(skills.size > 1, "skill varies");
    assert.ok(delays.size > 1, "reaction delay varies");
    assert.ok(cadences.size > 1, "cadence varies");
    // Nobody is a perfect forecaster, and nobody is instant.
    assert.ok(crowd.traders.every((t) => t.skill < 1 && t.reactionMs > 0));
    await registry.shutdown();
  });
});
