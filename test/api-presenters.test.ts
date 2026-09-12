import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateResolutionAt,
  presentAccount,
  presentFightDetail,
  presentFightSummary,
  presentLeaderboard,
  presentMyFight,
  presentPortfolio,
  racerEtaMs,
  round,
  type AccountSources,
  type LeaderboardRecord,
} from "../src/api/presenters.js";
import { RaceRegistry } from "../src/api/race-registry.js";
import { createFactory, raceInput, winRace } from "./api-fixtures.js";

const DAY = 86_400_000;

function sourcesOf(registry: RaceRegistry): AccountSources {
  return {
    ledger: registry.ledger,
    coordinators: registry.list(),
    fightInfo: (raceId) => registry.fightInfo(raceId),
  };
}

test("racer ETA and estimated resolution follow the contract", () => {
  assert.equal(racerEtaMs({ status: "running", checkpoint: 1, startedAt: 1_000 }, 3, 5_000), 8_000);
  assert.equal(racerEtaMs({ status: "recovering", checkpoint: 2, startedAt: 1_000 }, 4, 5_000), 4_000);
  assert.equal(racerEtaMs({ status: "running", checkpoint: 3, startedAt: 1_000 }, 3, 5_000), 0);
  assert.equal(racerEtaMs({ status: "running", checkpoint: 0, startedAt: 1_000 }, 3, 5_000), null);
  assert.equal(racerEtaMs({ status: "finished", checkpoint: 3, startedAt: 1_000 }, 3, 5_000), null);
  assert.equal(racerEtaMs({ status: "ready", checkpoint: 0 }, 3, 5_000), null);

  assert.equal(estimateResolutionAt("live", [8_000, null, 2_000], 5_000, 100_000), 7_000);
  assert.equal(estimateResolutionAt("live", [8_000], 5_000, 6_000), 6_000);
  assert.equal(estimateResolutionAt("live", [null, null], 5_000, 6_000), null);
  assert.equal(estimateResolutionAt("upcoming", [0], 5_000, 6_000), null);
});

test("live fight summary derives ETA, change, checkpoints and run status", async () => {
  const { factory } = createFactory();
  const registry = new RaceRegistry(factory);
  await registry.create(raceInput("race-1"), 1_000);
  const race = registry.get("race-1");
  await race.recordCheckpoint("racer-1", 1, 3_000);
  for (let step = 1; step <= 3; step += 1) {
    race.recordAgentAction("racer-2", {
      kind: "action", text: "click Buy", step, maxSteps: 40, signature: "click#buy",
    }, 3_000 + step);
  }
  race.recordAgentAction("racer-3", { kind: "error", text: "click", step: 1, maxSteps: 40 }, 3_100);
  race.recordAgentAction("racer-3", { kind: "error", text: "type", step: 2, maxSteps: 40 }, 3_200);

  const options = { now: 5_000, showSabotageUpfront: true };
  const summary = presentFightSummary(race, options);
  assert.equal(summary.status, "live");
  assert.equal(summary.number, 1);
  assert.equal(summary.estimatedResolutionAt, 13_000);
  assert.equal(summary.closesAt, 301_000);
  assert.equal(summary.freezesAt, 181_000);
  assert.equal(summary.leaderCheckpoint, 1);
  assert.equal(summary.sabotage, null);
  assert.deepEqual(summary.agents.map((agent) => agent.runStatus), ["run", "warn", "warn", "run"]);
  assert.ok(summary.agents[0].change > 0);
  assert.equal(round(summary.agents[0].yes + summary.agents[0].no), 1);
  assert.equal(summary.agents[0].agent.key, "gpt");

  const detail = presentFightDetail(race, options);
  const leader = detail.agents[0];
  assert.equal(leader.etaMs, 8_000);
  assert.equal(detail.agents[1].etaMs, null);
  assert.equal(detail.agents[1].step, 3);
  assert.equal(detail.agents[1].maxSteps, 40);
  assert.equal(leader.progress, round(1 / 3));
  assert.deepEqual(leader.checkpoints.map((checkpoint) => checkpoint.state), ["cleared", "pending", "pending"]);
  assert.equal(leader.checkpoints[0].clearedAt, 3_000);
  assert.equal(leader.log.at(-1)?.kind, "checkpoint");
  assert.equal(leader.frame, null);
  assert.equal(detail.checkpoints[0].label, "Checkpoint 1");
});

test("sabotage reveal rule and armed → fired → state", async () => {
  const { factory } = createFactory();
  const registry = new RaceRegistry(factory);
  await registry.create(raceInput("race-up", {
    obstaclesEnabled: true,
    startsAt: 10_000,
    sabotage: { checkpoint: 2, summary: "A modal blocks checkout", detail: "Full detail" },
  }), 1_000);
  const race = registry.get("race-up");

  const hidden = presentFightDetail(race, { now: 2_000, showSabotageUpfront: false });
  assert.equal(hidden.status, "upcoming");
  assert.deepEqual(
    [hidden.sabotage?.revealed, hidden.sabotage?.summary, hidden.sabotage?.detail, hidden.sabotage?.hazardType],
    [false, null, null, null],
  );
  assert.equal(hidden.sabotage?.checkpoint, 2);
  assert.equal(hidden.sabotage?.state, "armed");
  assert.equal(hidden.estimatedResolutionAt, null);
  assert.equal(hidden.closesAt, 310_000);
  assert.deepEqual(hidden.checkpoints.map((checkpoint) => checkpoint.isSabotage), [false, true, false]);

  const upfront = presentFightSummary(race, { now: 2_000, showSabotageUpfront: true });
  assert.equal(upfront.sabotage?.summary, "A modal blocks checkout");

  await registry.tickAll(10_000);
  await race.recordCheckpoint("racer-1", 1, 11_000);
  await race.recordCheckpoint("racer-1", 2, 12_000);
  const live = presentFightDetail(race, { now: 12_500, showSabotageUpfront: false });
  assert.equal(live.sabotage?.revealed, true);
  assert.equal(live.sabotage?.summary, "A modal blocks checkout");
  assert.equal(live.sabotage?.hazardType, "blocking_modal");
  assert.equal(live.sabotage?.state, "fired");
  assert.equal(live.sabotage?.firedAt, 12_000);
  assert.deepEqual(live.sabotage?.hitRacerIds, ["racer-1"]);
  assert.equal(live.agents[0].phase, "recovering");
  assert.equal(live.agents[0].runStatus, "bad");
  assert.equal(live.agents[0].sabotageHitAt, 12_000);
  assert.equal(live.agents[0].checkpoints[1].sabotageFired, true);
});

test("unfired sabotage expires when hazards freeze", async () => {
  const { factory } = createFactory();
  const registry = new RaceRegistry(factory);
  await registry.create(raceInput("race-e", { obstaclesEnabled: true }), 1_000);
  const race = registry.get("race-e");
  assert.equal(presentFightSummary(race, { now: 2_000, showSabotageUpfront: true }).sabotage?.state, "armed");
  await registry.tickAll(181_000);
  const summary = presentFightSummary(race, { now: 181_000, showSabotageUpfront: true });
  assert.equal(summary.raceStatus, "hazards_frozen");
  assert.equal(summary.status, "live");
  assert.equal(summary.sabotage?.state, "expired");
  assert.equal(summary.marketStatus, "frozen");
});

test("account lifetime realizedPnl, portfolio history and my-fight totals", async () => {
  const { factory } = createFactory();
  const registry = new RaceRegistry(factory, { startingBalance: 100 });
  await registry.create(raceInput("race-p"), 1_000);
  const race = registry.get("race-p");
  const { user } = registry.users.ensure({ userId: "alice-01" }, 1_000);
  const buy = race.placeOrder(
    { userId: "alice-01", racerId: "racer-1", side: "yes", action: "buy", quantity: 10 },
    2_000,
  );
  const sell = race.placeOrder(
    { userId: "alice-01", racerId: "racer-1", side: "yes", action: "sell", quantity: 4 },
    3_000,
  );

  const open = presentAccount(user, sourcesOf(registry));
  assert.equal(open.held, round(6 * buy.price));
  assert.equal(open.balance, round(100 - buy.total + sell.total));
  assert.equal(open.equity, round(open.balance + open.positionsValue));
  assert.equal(open.unrealizedPnl, round(open.positionsValue - open.held));
  assert.equal(open.lifetime.wagered, buy.total);
  assert.equal(open.lifetime.sold, sell.total);
  // Closed cost basis is the 4 sold shares: wagered - held.
  assert.equal(open.lifetime.realizedPnl, round(sell.total - (buy.total - open.held)));
  assert.equal(open.lifetime.fightsTraded, 1);

  await winRace(race, "racer-1", 9_000);
  const settled = presentAccount(user, sourcesOf(registry));
  assert.equal(settled.held, 0);
  assert.equal(settled.lifetime.won, 6);
  assert.equal(settled.lifetime.realizedPnl, round(sell.total + 6 - buy.total));
  assert.equal(settled.balance, round(100 + settled.lifetime.realizedPnl));

  const portfolio = presentPortfolio(user, sourcesOf(registry));
  assert.deepEqual(portfolio.history.map((entry) => entry.type), ["payout", "sell", "buy", "deposit"]);
  assert.equal(portfolio.history[0].fightNumber, 1);
  assert.equal(portfolio.history[0].agent?.key, "gpt");
  assert.equal(portfolio.history[3].method, "virtual");
  assert.equal(portfolio.history[3].raceId, null);

  const mine = presentMyFight(race, "alice-01", registry.ledger, 10_000);
  assert.equal(mine.open.length, 0);
  assert.equal(mine.settled[0].result, "won");
  assert.equal(mine.settled[0].settlementPrice, 1);
  assert.equal(mine.totals.cost, buy.total);
  assert.equal(mine.totals.payout, 6);
  assert.equal(mine.totals.net, round(sell.total + 6 - buy.total));
  assert.equal(mine.totals.returnPct, round(mine.totals.net / buy.total));
});

function record(
  raceId: string,
  finishedAt: number,
  winner: string,
  extras: Record<string, Partial<LeaderboardRecord["agents"][number]>> = {},
): LeaderboardRecord {
  return {
    raceId,
    finishedAt,
    agents: ["gpt", "claude", "gemini", "grok"].map((key, index) => ({
      racerId: `racer-${index + 1}`,
      agent: { key, name: key.toUpperCase(), provider: "simulated", model: "simulated" },
      won: key === winner,
      finishMs: null,
      hit: false,
      survived: false,
      yesBuyCost: 0,
      yesSellProceeds: 0,
      yesPayout: 0,
      ...extras[key],
    })),
  };
}

test("leaderboard ranks 30-day agents by win rate, then fights", () => {
  const now = 100 * DAY;
  const board = presentLeaderboard([
    record("a", now - DAY, "gpt", {
      gpt: { finishMs: 60_000, yesBuyCost: 10, yesPayout: 20 },
      claude: { hit: true, survived: true },
    }),
    record("b", now - 2 * DAY, "gpt", {
      gpt: { finishMs: 80_000 },
      gemini: { hit: true },
    }),
    record("c", now - 3 * DAY, "claude", { claude: { finishMs: 100_000, yesBuyCost: 5, yesSellProceeds: 1 } }),
    record("old", now - 40 * DAY, "grok", { grok: { finishMs: 1_000 } }),
  ], now);

  assert.equal(board.windowDays, 30);
  assert.equal(board.since, now - 30 * DAY);
  assert.deepEqual(board.rows.map((row) => [row.rank, row.agent.key]), [
    [1, "gpt"], [2, "claude"], [3, "gemini"], [4, "grok"],
  ]);
  const [gpt, claude, gemini, grok] = board.rows;
  assert.equal(gpt.fights, 3);
  assert.equal(gpt.wins, 2);
  assert.equal(gpt.winRate, round(2 / 3));
  assert.equal(gpt.avgFinishMs, 70_000);
  assert.equal(gpt.backerRoi, 1);
  assert.equal(claude.sabotageSurvival, 1);
  assert.equal(claude.backerRoi, -0.8);
  assert.equal(gemini.sabotageHits, 1);
  assert.equal(gemini.sabotageSurvival, 0);
  assert.equal(grok.wins, 0);
  assert.equal(grok.sabotageSurvival, null);
  assert.equal(grok.backerRoi, null);
  assert.equal(grok.avgFinishMs, null);
});
