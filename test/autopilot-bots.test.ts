import assert from "node:assert/strict";
import test from "node:test";
import { RaceRegistry } from "../src/api/race-registry.js";
import { SimulationAutopilot } from "../src/simulation/autopilot.js";
import { createFactory, raceInput } from "./api-fixtures.js";

test("simulated bots trade against a pumped price instead of chasing it", async () => {
  const now = 1_700_000_000_000;
  const { factory } = createFactory();
  const registry = new RaceRegistry(factory, { startingBalance: 1_000 });
  await registry.create(raceInput("race-pump"), now);
  const race = registry.get("race-pump");
  const autopilot = new SimulationAutopilot(registry, {
    seed: "pump",
    timeScale: 1,
    historyFights: 0,
    liveFights: 0,
    upcomingFights: 0,
  });
  for (let index = 0; index < 8; index += 1) {
    const userId = `bot-test-${index}`;
    registry.users.ensure({ userId }, now, { automated: true });
    registry.ledger.credit(userId, 5_000, { type: "deposit", at: now });
    autopilot.bots.push(userId);
  }
  registry.users.ensure({ userId: "pumper-01" }, now);
  registry.ledger.credit("pumper-01", 10_000, { type: "deposit", at: now });

  const pump = { userId: "pumper-01", racerId: "racer-4", side: "yes" as const, quantity: 3_000 };
  const bought = race.placeOrder({ ...pump, action: "buy" }, now);
  const pumped = race.market.pricesSnapshot()["racer-4"];
  for (let round = 0; round < 40; round += 1) autopilot.botTrade(race, now + 1_000 + round * 500);

  assert.ok(race.market.pricesSnapshot()["racer-4"] < pumped - 0.05, "the bots sold the pump down");
  const sold = race.placeOrder({ ...pump, action: "sell" }, now + 30_000);
  assert.ok(sold.total < bought.total, `dumping on the bots should lose: paid ${bought.total}, got ${sold.total}`);
  autopilot.stop();
  await registry.shutdown();
});
