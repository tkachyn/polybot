import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApi } from "../src/api/server.js";
import { createFactory, raceInput } from "./api-fixtures.js";

function build(options: Partial<Parameters<typeof buildApi>[0]> = {}) {
  const { factory } = createFactory();
  return buildApi({ coordinatorFactory: factory, enableTicker: false, startingBalance: 500, ...options });
}

test("health reports demo readiness without creating a session", async () => {
  const app = build({ mode: "simulated", demoMode: true });
  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    { ok: response.json().ok, mode: response.json().mode, demoMode: response.json().demoMode },
    { ok: true, mode: "simulated", demoMode: true },
  );
  await app.close();
});

test("operator races enable checkpoint-one sabotage by default", async () => {
  const app = build();
  const response = await app.inject({
    method: "POST",
    url: "/races",
    payload: raceInput("race-default"),
  });

  assert.equal(response.statusCode, 201);
  assert.equal(app.registry.get("race-default").sabotage?.plan.checkpoint, 1);
  assert.equal(app.registry.get("race-default").sabotage?.armed, true);
  await app.close();
});

test("meta, users and wallet transfers", async () => {
  const app = build({ mode: "simulated" });
  const meta = await app.inject({ method: "GET", url: "/api/meta" });
  assert.equal(meta.statusCode, 200);
  assert.equal(meta.json().mode, "simulated");
  assert.equal(meta.json().demoMode, false);
  assert.equal(meta.json().startingBalance, 500);
  assert.equal(meta.json().showSabotageUpfront, true);
  assert.equal(typeof meta.json().serverTime, "number");

  const anonymous = await app.inject({ method: "POST", url: "/api/users" });
  assert.equal(anonymous.statusCode, 201);
  const generated = anonymous.json().account;
  assert.match(generated.userId, /^[A-Za-z0-9_-]{6,64}$/);
  assert.equal(generated.displayName, `Trader ${generated.userId.slice(-4).toUpperCase()}`);
  assert.equal(generated.balance, 500);

  const created = await app.inject({ method: "POST", url: "/api/users", payload: { userId: "alice-01" } });
  assert.equal(created.statusCode, 201);
  const again = await app.inject({ method: "POST", url: "/api/users", payload: { userId: "alice-01" } });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().account.balance, 500);
  assert.equal(again.json().account.lifetime.deposited, 500);

  const bad = await app.inject({ method: "POST", url: "/api/users", payload: { userId: "bad" } });
  assert.deepEqual([bad.statusCode, bad.json().code], [400, "invalid"]);
  const missing = await app.inject({ method: "GET", url: "/api/users/nobody-1" });
  assert.deepEqual([missing.statusCode, missing.json().code], [404, "not_found"]);

  const deposit = await app.inject({
    method: "POST", url: "/api/users/alice-01/deposit", payload: { amount: 100, method: "virtual" },
  });
  assert.equal(deposit.statusCode, 200);
  assert.equal(deposit.json().account.balance, 600);
  assert.deepEqual(
    [deposit.json().entry.type, deposit.json().entry.amount, deposit.json().entry.method],
    ["deposit", 100, "virtual"],
  );
  for (const payload of [
    { amount: 100_001, method: "virtual" },
    { amount: 0, method: "virtual" },
    { amount: 10, method: "card" },
    { amount: "10", method: "virtual" },
  ]) {
    const rejected = await app.inject({ method: "POST", url: "/api/users/alice-01/deposit", payload });
    assert.deepEqual([rejected.statusCode, rejected.json().code], [400, "invalid"], JSON.stringify(payload));
  }
  const overdrawn = await app.inject({
    method: "POST", url: "/api/users/alice-01/withdraw", payload: { amount: 1_000, method: "virtual" },
  });
  assert.deepEqual([overdrawn.statusCode, overdrawn.json().code], [400, "insufficient_balance"]);
  const withdrawn = await app.inject({
    method: "POST", url: "/api/users/alice-01/withdraw", payload: { amount: 50, method: "virtual" },
  });
  assert.equal(withdrawn.json().account.balance, 550);
  assert.equal(withdrawn.json().entry.amount, -50);

  const malformed = await app.inject({
    method: "POST", url: "/api/users", headers: { "content-type": "application/json" }, payload: "{",
  });
  assert.deepEqual([malformed.statusCode, malformed.json().code], [400, "invalid"]);
  const unknownRoute = await app.inject({ method: "GET", url: "/api/nope" });
  assert.deepEqual([unknownRoute.statusCode, unknownRoute.json().code], [404, "not_found"]);
  await app.close();
});

test("demo mode locks equal bankrolls and ranks judges in one fight", async () => {
  const app = build({ demoMode: true, startingBalance: 100 });
  await app.inject({ method: "POST", url: "/races", payload: { ...raceInput("race-demo"), obstaclesEnabled: false } });
  for (const [userId, displayName] of [["judge-01", "Ada"], ["judge-02", "Grace"]]) {
    const created = await app.inject({ method: "POST", url: "/api/users", payload: { userId, displayName } });
    assert.equal(created.json().account.balance, 100);
  }
  const duplicateName = await app.inject({
    method: "POST", url: "/api/users", payload: { userId: "judge-03", displayName: "ada" },
  });
  assert.deepEqual([duplicateName.statusCode, duplicateName.json().code], [409, "conflict"]);
  app.registry.users.ensure({ userId: "market-bot", displayName: "Bot" }, Date.now(), { automated: true });

  const locked = await app.inject({
    method: "POST", url: "/api/users/judge-01/deposit", payload: { amount: 10, method: "virtual" },
  });
  assert.deepEqual([locked.statusCode, locked.json().code], [400, "invalid"]);

  await app.inject({
    method: "POST", url: "/api/fights/race-demo/orders",
    payload: { userId: "judge-01", racerId: "racer-1", side: "yes", action: "buy", quantity: 8 },
  });
  await app.inject({
    method: "POST", url: "/api/fights/race-demo/orders",
    payload: { userId: "market-bot", racerId: "racer-3", side: "yes", action: "buy", quantity: 2 },
  });
  await app.inject({
    method: "POST", url: "/api/fights/race-demo/orders",
    payload: { userId: "judge-02", racerId: "racer-2", side: "yes", action: "buy", quantity: 4 },
  });

  const board = await app.inject({ method: "GET", url: "/api/fights/race-demo/traders" });
  assert.equal(board.statusCode, 200);
  assert.equal(board.json().raceId, "race-demo");
  assert.deepEqual(board.json().rows.map((row: { displayName: string }) => row.displayName).sort(), ["Ada", "Grace"]);
  assert.deepEqual(board.json().rows.map((row: { rank: number }) => row.rank), [1, 2]);
  await app.close();
});

test("fights, orders, frames, my-fight and leaderboard", async () => {
  const app = build();
  const now = Date.now();
  const create = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/races", payload });
  assert.equal((await create({ ...raceInput("race-done"), obstaclesEnabled: false })).statusCode, 201);
  assert.equal((await create({ ...raceInput("race-live"), obstaclesEnabled: false })).statusCode, 201);
  assert.equal((await create({
    ...raceInput("race-up"),
    obstaclesEnabled: true,
    startsAt: now + 60_000,
    title: "Upcoming fight",
    sabotage: { checkpoint: 2, summary: "A modal blocks checkout" },
  })).statusCode, 201);
  for (const checkpoint of [1, 2, 3]) {
    await app.inject({ method: "POST", url: "/races/race-done/checkpoints", payload: { racerId: "racer-2", checkpoint } });
  }
  await app.inject({ method: "POST", url: "/races/race-done/finish", payload: { racerId: "racer-2" } });
  await app.inject({ method: "POST", url: "/api/users", payload: { userId: "alice-01" } });

  const list = await app.inject({ method: "GET", url: "/api/fights" });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(
    list.json().fights.map((fight: { raceId: string; status: string }) => [fight.raceId, fight.status]),
    [["race-live", "live"], ["race-up", "upcoming"], ["race-done", "resolved"]],
  );
  const upcoming = await app.inject({ method: "GET", url: "/api/fights?status=upcoming" });
  assert.deepEqual(upcoming.json().fights.map((fight: { number: number }) => fight.number), [3]);
  const badStatus = await app.inject({ method: "GET", url: "/api/fights?status=bogus" });
  assert.deepEqual([badStatus.statusCode, badStatus.json().code], [400, "invalid"]);

  const detail = await app.inject({ method: "GET", url: "/api/fights/race-up" });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().fight.title, "Upcoming fight");
  assert.equal(detail.json().fight.sabotage.summary, "A modal blocks checkout");
  assert.equal(detail.json().fight.checkpoints.length, 3);
  assert.deepEqual(detail.json().fight.agents[0].browserView, {
    status: "pending",
    viewerUrl: null,
  });
  assert.ok(detail.json().priceHistory.length >= 1);
  const unknown = await app.inject({ method: "GET", url: "/api/fights/missing" });
  assert.deepEqual([unknown.statusCode, unknown.json().code], [404, "not_found"]);

  const order = (payload: Record<string, unknown>, raceId = "race-live") =>
    app.inject({ method: "POST", url: `/api/fights/${raceId}/orders`, payload });
  const base = { userId: "alice-01", racerId: "racer-2", side: "no", action: "buy", quantity: 5 };
  const bought = await order({ ...base, clientOrderId: "o-1" });
  assert.equal(bought.statusCode, 200);
  assert.equal(bought.json().receipt.price, 0.75);
  assert.equal(bought.json().receipt.payoutIfWin, 5);
  assert.equal(bought.json().quotes.length, 4);
  assert.equal(bought.json().account.held, 3.75);
  const repeated = await order({ ...base, clientOrderId: "o-1" });
  assert.equal(repeated.json().receipt.orderId, bought.json().receipt.orderId);

  const expectCode = async (payload: Record<string, unknown>, status: number, code: string, raceId?: string) => {
    const response = await order(payload, raceId);
    assert.deepEqual([response.statusCode, response.json().code], [status, code], JSON.stringify(payload));
  };
  await expectCode({ ...base, limitPrice: 0.1 }, 400, "price_moved");
  await expectCode({ ...base, action: "sell", quantity: 99 }, 400, "insufficient_position");
  await expectCode({ ...base, racerId: "racer-9" }, 404, "not_found");
  await expectCode({ ...base, userId: "nobody-1" }, 404, "not_found");
  await expectCode({ ...base, quantity: 1.5 }, 400, "invalid");
  await expectCode({ ...base, side: "maybe" }, 400, "invalid");
  await expectCode({ ...base, quantity: 100_000 }, 400, "insufficient_balance");
  await expectCode(base, 400, "market_closed", "race-done");

  const mine = await app.inject({ method: "GET", url: "/api/fights/race-live/me?userId=alice-01" });
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.json().open.length, 1);
  assert.equal(mine.json().totals.cost, 3.75);
  assert.equal(mine.json().totals.returnPct, null);
  const noUser = await app.inject({ method: "GET", url: "/api/fights/race-live/me" });
  assert.equal(noUser.statusCode, 400);

  const portfolio = await app.inject({ method: "GET", url: "/api/users/alice-01/portfolio" });
  assert.equal(portfolio.json().positions[0].side, "no");
  assert.equal(portfolio.json().history[0].type, "buy");
  assert.equal(portfolio.json().history[0].fightNumber, 2);
  assert.equal(portfolio.json().history[0].agent.key, "claude");

  const noFrame = await app.inject({ method: "GET", url: "/api/fights/race-live/agents/racer-1/frame" });
  assert.deepEqual([noFrame.statusCode, noFrame.json().code], [404, "not_found"]);
  app.registry.get("race-live").recordAgentFrame("racer-1", { contentType: "image/svg+xml", body: "<svg/>" });
  const frame = await app.inject({ method: "GET", url: "/api/fights/race-live/agents/racer-1/frame?seq=1" });
  assert.equal(frame.statusCode, 200);
  assert.equal(frame.headers["content-type"], "image/svg+xml");
  assert.equal(frame.headers["cache-control"], "no-store");
  assert.equal(frame.body, "<svg/>");
  const liveDetail = await app.inject({ method: "GET", url: "/api/fights/race-live" });
  assert.equal(liveDetail.json().fight.agents[0].frame.seq, 1);
  assert.equal(liveDetail.json().fight.agents[0].frame.body, undefined);

  const board = await app.inject({ method: "GET", url: "/api/leaderboard" });
  assert.equal(board.statusCode, 200);
  assert.equal(board.json().rows.length, 4);
  assert.equal(board.json().rows[0].agent.key, "claude");
  assert.equal(board.json().rows[0].wins, 1);
  await app.close();
});

test("operator /races routes keep message mapping and add codes", async () => {
  const app = build();
  const missing = await app.inject({ method: "GET", url: "/races/missing" });
  assert.deepEqual([missing.statusCode, missing.json().code], [404, "not_found"]);
  await app.inject({ method: "POST", url: "/races", payload: { ...raceInput("race-1"), obstaclesEnabled: false } });
  const duplicate = await app.inject({ method: "POST", url: "/races", payload: { ...raceInput("race-1"), obstaclesEnabled: false } });
  assert.deepEqual([duplicate.statusCode, duplicate.json().code], [409, "conflict"]);
  const noId = await app.inject({ method: "POST", url: "/races", payload: { ...raceInput("x"), obstaclesEnabled: false, raceId: undefined } });
  assert.deepEqual([noId.statusCode, noId.json().code, noId.json().error], [400, "invalid", "raceId is required"]);
  const longTitle = await app.inject({ method: "POST", url: "/races", payload: { ...raceInput("race-2"), obstaclesEnabled: false, title: "x".repeat(91) } });
  assert.deepEqual([longTitle.statusCode, longTitle.json().code], [400, "invalid"]);
  const noObstacles = await app.inject({
    method: "POST", url: "/races", payload: {
      ...raceInput("race-3"),
      obstaclesEnabled: false,
      sabotage: { checkpoint: 1, summary: "Modal" },
    },
  });
  assert.deepEqual([noObstacles.statusCode, noObstacles.json().code], [400, "invalid"]);
  const badCheckpoint = await app.inject({
    method: "POST", url: "/races/race-1/checkpoints", payload: { racerId: "racer-1", checkpoint: 3 },
  });
  assert.deepEqual([badCheckpoint.statusCode, badCheckpoint.json().code], [400, "invalid"]);
  await app.close();
});

test("serves the SPA with a fallback outside /api and /races", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-dist-"));
  try {
    await writeFile(join(dir, "index.html"), "<!doctype html><title>spa-marker</title>");
    await writeFile(join(dir, "app.js"), "console.log('app');");
    const app = build({ webDist: dir });
    const html = { accept: "text/html,application/xhtml+xml" };
    const deepLink = await app.inject({ method: "GET", url: "/fights/race-9", headers: html });
    assert.equal(deepLink.statusCode, 200);
    assert.match(deepLink.body, /spa-marker/);
    const root = await app.inject({ method: "GET", url: "/", headers: html });
    assert.match(root.body, /spa-marker/);
    const asset = await app.inject({ method: "GET", url: "/app.js" });
    assert.equal(asset.statusCode, 200);
    const api = await app.inject({ method: "GET", url: "/api/nope", headers: html });
    assert.deepEqual([api.statusCode, api.json().code], [404, "not_found"]);
    const races = await app.inject({ method: "GET", url: "/races/a/b/c", headers: html });
    assert.equal(races.statusCode, 404);
    assert.equal(races.json().code, "not_found");
    const json = await app.inject({ method: "GET", url: "/not-a-page", headers: { accept: "application/json" } });
    assert.equal(json.statusCode, 404);
    await app.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("awaits onRegistryReady before ticking and stops it on close", async () => {
  const calls: string[] = [];
  const app = build({
    enableTicker: true,
    tickIntervalMs: 5,
    async onRegistryReady(registry) {
      calls.push("ready");
      await registry.create(raceInput("seeded"), 1_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      calls.push("seeded");
      return () => calls.push("stopped");
    },
  });
  await app.ready();
  assert.deepEqual(calls, ["ready", "seeded"]);
  assert.equal(app.registry.list().length, 1);
  await app.close();
  assert.deepEqual(calls, ["ready", "seeded", "stopped"]);
});
