import assert from "node:assert/strict";
import test from "node:test";
import type {
  FightDetailResponse,
  FightListResponse,
  LeaderboardResponse,
  OrderResponse,
  PortfolioResponse,
} from "../src/api/dto.js";
import { buildApi } from "../src/api/server.js";
import {
  createSimulatedCoordinatorFactory,
  startSimulationAutopilot,
} from "../src/simulation/index.js";

const TIME_SCALE = 40;
const USER_ID = "sim-e2e-user";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("simulated mode runs fights end to end through the spectator API", { timeout: 60_000 }, async () => {
  const options = { seed: "e2e-seed", timeScale: TIME_SCALE };
  const app = buildApi({
    coordinatorFactory: createSimulatedCoordinatorFactory(options),
    mode: "simulated",
    fightNumberStart: 401,
    tickIntervalMs: 50,
    onRegistryReady: (registry) =>
      startSimulationAutopilot(registry, { ...options, historyFights: 2, liveFights: 2, upcomingFights: 2 }),
  });
  try {
    await app.ready();

    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json();
    assert.equal(meta.mode, "simulated");

    const list = (await app.inject({ method: "GET", url: "/api/fights" })).json() as FightListResponse;
    const live = list.fights.filter((fight) => fight.status === "live");
    const upcoming = list.fights.filter((fight) => fight.status === "upcoming");
    const resolved = list.fights.filter((fight) => fight.status === "resolved");
    assert.equal(live.length, 2, "two live fights");
    assert.equal(upcoming.length, 2, "two upcoming fights");
    assert.equal(resolved.length, 2, "two seeded history fights");
    const dayAgo = Date.now() - 3_600_000;
    for (const fight of resolved) {
      assert.ok(fight.finishedAt !== null && fight.finishedAt < dayAgo, "history is in the past");
      assert.ok(fight.volume > 0, "bots traded history fights");
      assert.ok(fight.number >= 401);
    }
    for (const fight of [...live, ...upcoming]) {
      assert.ok(fight.sabotage, "sabotage is revealed");
      assert.ok(fight.agents.every((agent) => agent.agent.provider === "simulated"));
    }
    assert.ok(upcoming.every((fight) => fight.startsAt !== null && fight.startsAt > Date.now()));

    const created = await app.inject({ method: "POST", url: "/api/users", payload: { userId: USER_ID } });
    assert.equal(created.statusCode, 201);

    const traded: string[] = [];
    for (const fight of live) {
      for (const [racerId, side] of [["racer-1", "yes"], ["racer-2", "no"]] as const) {
        const response = await app.inject({
          method: "POST",
          url: `/api/fights/${fight.raceId}/orders`,
          payload: { userId: USER_ID, racerId, side, action: "buy", quantity: 5 },
        });
        if (response.statusCode === 200) {
          const body = response.json() as OrderResponse;
          assert.equal(body.receipt.side, side);
          if (!traded.includes(fight.raceId)) traded.push(fight.raceId);
        } else {
          assert.equal(response.json().code, "market_closed", response.body);
        }
      }
    }
    assert.ok(traded.length > 0, "traded on a live fight");

    // Wait for a traded fight to resolve with a winner (not voided).
    let settled: FightDetailResponse | undefined;
    const deadline = Date.now() + 25_000;
    while (!settled && Date.now() < deadline) {
      for (const raceId of traded) {
        const detail = (await app.inject({ method: "GET", url: `/api/fights/${raceId}` })).json() as FightDetailResponse;
        if (detail.fight.status === "resolved" && !detail.fight.voided) settled = detail;
      }
      if (!settled) await delay(200);
    }
    assert.ok(settled, "a traded fight resolved within 25 s");
    const fight = settled.fight;
    assert.ok(fight.winnerRacerId);
    assert.equal(fight.marketStatus, "resolved");
    assert.ok(fight.sabotage && ["fired", "expired"].includes(fight.sabotage.state));
    if (fight.sabotage.state === "fired") {
      assert.ok(fight.sabotage.hitRacerIds.length > 0);
      assert.ok(fight.sabotage.firedAt !== null);
    }
    assert.ok(settled.priceHistory.length > 2, "price history moved");
    const winner = fight.agents.find((agent) => agent.racerId === fight.winnerRacerId);
    assert.ok(winner);
    assert.equal(winner.checkpoint, fight.checkpointCount);
    for (const agent of fight.agents) {
      assert.ok(agent.step > 0, `${agent.racerId} took steps`);
      assert.ok(agent.log.length > 0, `${agent.racerId} has a log`);
      assert.ok(agent.url?.includes(".arena.test/"));
      assert.ok(agent.frame && agent.frame.seq > 0, `${agent.racerId} has frames`);
    }
    const frame = await app.inject({
      method: "GET",
      url: `/api/fights/${fight.raceId}/agents/${fight.winnerRacerId}/frame`,
    });
    assert.equal(frame.statusCode, 200);
    assert.match(String(frame.headers["content-type"]), /image\/svg\+xml/);

    const portfolio = (await app.inject({
      method: "GET",
      url: `/api/users/${USER_ID}/portfolio`,
    })).json() as PortfolioResponse;
    const settlements = portfolio.history.filter((entry) =>
      entry.raceId === fight.raceId && (entry.type === "payout" || entry.type === "loss"));
    assert.equal(settlements.length, 2, "one settlement entry per position");
    for (const entry of settlements) {
      const won: boolean = entry.side === "yes"
        ? entry.racerId === fight.winnerRacerId
        : entry.racerId !== fight.winnerRacerId;
      assert.equal(entry.type, won ? "payout" : "loss");
      assert.equal(entry.amount, won ? 5 : 0);
      assert.equal(entry.fightNumber, fight.number);
    }
    assert.ok(portfolio.history.some((entry) => entry.type === "buy" && entry.raceId === fight.raceId));
    assert.ok(portfolio.positions.every((position) => position.raceId !== fight.raceId));

    const leaderboard = (await app.inject({ method: "GET", url: "/api/leaderboard" })).json() as LeaderboardResponse;
    assert.equal(leaderboard.rows.length, 4);
    assert.ok(leaderboard.rows.reduce((sum, row) => sum + row.wins, 0) >= 2, "history and live wins counted");
    assert.ok(leaderboard.rows.every((row) => row.fights >= 2));
  } finally {
    await app.close();
  }
});
