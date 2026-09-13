import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AGENT_ROSTER } from "../src/application/fight-metadata.js";
import { presentFightSummary } from "../src/api/presenters.js";
import { RaceRegistry, RESOLVED_RETENTION_MS, type CoordinatorChange } from "../src/api/race-registry.js";
import { DomainError } from "../src/domain/errors.js";
import { createFactory, raceInput, winRace } from "./api-fixtures.js";

function isCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof DomainError, `expected DomainError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

test("numbers fights sequentially over a shared ledger", async () => {
  const { factory } = createFactory();
  const registry = new RaceRegistry(factory, { fightNumberStart: 401, startingBalance: 50 });
  const changes: string[] = [];
  registry.subscribe((raceId, change: CoordinatorChange) => changes.push(`${raceId}:${change.kind}`));

  await registry.create(raceInput("race-a"), 1_000);
  await registry.create(raceInput("race-b", { title: "Custom title" }), 2_000);
  assert.equal(registry.get("race-a").fight.number, 401);
  assert.equal(registry.get("race-b").fight.number, 402);
  assert.equal(registry.get("race-b").fight.title, "Custom title");
  assert.equal(registry.get("race-b").fight.createdAt, 2_000);
  assert.ok(changes.includes("race-a:created"));
  assert.ok(changes.includes("race-a:fight"));

  registry.users.ensure({ userId: "alice-01" }, 1_000);
  const { total } = registry.get("race-a").placeOrder(
    { userId: "alice-01", racerId: "racer-1", side: "yes", action: "buy", quantity: 10 },
    1_500,
  );
  assert.equal(registry.ledger.balance("alice-01"), Math.round((50 - total) * 1e6) / 1e6);

  await assert.rejects(registry.create(raceInput("race-a")), isCode("conflict"));
  assert.throws(() => registry.get("missing"), isCode("not_found"));
  await registry.shutdown();
});

test("validates operator fields with DomainError invalid", async () => {
  const { factory } = createFactory();
  const registry = new RaceRegistry(factory);
  const duplicateKeys = DEFAULT_AGENT_ROSTER.map((agent) => ({ ...agent, key: "same" }));
  const cases = [
    { title: "x".repeat(91) },
    { checkpointLabels: ["one", "two"] },
    { agents: DEFAULT_AGENT_ROSTER.slice(0, 3).map((agent) => ({ ...agent })) },
    { agents: duplicateKeys },
    { sabotage: { checkpoint: 1, summary: "Modal" } },
    { obstaclesEnabled: true, sabotage: { checkpoint: 4, summary: "Modal" } },
    { obstaclesEnabled: true, sabotage: { checkpoint: 1, summary: "x".repeat(71) } },
    { obstaclesEnabled: true, sabotage: { checkpoint: 1, summary: "ok", detail: "x".repeat(281) } },
    { checkpointCount: 0 },
    { startsAt: Number.NaN },
  ];
  for (const overrides of cases) {
    await assert.rejects(registry.create(raceInput("race-x", overrides), 1_000), isCode("invalid"));
  }
  assert.equal(registry.list().length, 0);
  await registry.create(raceInput("race-ok"), 1_000);
  assert.equal(registry.get("race-ok").fight.number, 1);
});

test("a failed immediate start removes the fight and frees its number", async () => {
  const { factory } = createFactory({ failRaceIds: new Set(["race-bad"]) });
  const registry = new RaceRegistry(factory);
  const changes: string[] = [];
  registry.subscribe((raceId, change) => changes.push(`${raceId}:${change.kind}`));
  await assert.rejects(registry.create(raceInput("race-bad"), 1_000), /browser session failed/);
  assert.equal(registry.list().length, 0);
  assert.ok(changes.includes("race-bad:removed"));
  await registry.create(raceInput("race-good"), 2_000);
  assert.equal(registry.get("race-good").fight.number, 1);
});

test("tickAll starts a scheduled fight exactly once", async () => {
  const { factory, prepareCalls } = createFactory();
  const registry = new RaceRegistry(factory);
  const snapshot = await registry.create(
    raceInput("race-s", { obstaclesEnabled: true, startsAt: 10_000 }),
    1_000,
  );
  const race = registry.get("race-s");
  assert.equal(snapshot.race.status, "starting");
  assert.equal(race.sabotage?.armed, true);
  assert.equal(race.fight.startsAt, 10_000);
  assert.equal(race.market.status, "open");
  assert.equal(registry.scheduledStart("race-s"), 10_000);
  assert.equal(prepareCalls.length, 0);

  await registry.tickAll(5_000);
  assert.equal(race.engine.race.status, "starting");

  await Promise.all([registry.tickAll(10_000), registry.tickAll(10_001)]);
  assert.equal(race.engine.race.status, "running");
  assert.equal(race.engine.race.startedAt, 10_000);
  assert.equal(prepareCalls.length, 4);
  assert.equal(registry.scheduledStart("race-s"), null);

  await registry.tickAll(20_000);
  assert.equal(prepareCalls.length, 4);
});

test("a held start prepares the racers first and starts them when the hold ends", async () => {
  const { factory, prepareCalls } = createFactory();
  const registry = new RaceRegistry(factory, {
    startHoldMs: 9_500,
    clock: () => 3_000,
    startTimer: () => () => undefined,
  });
  const snapshot = await registry.create(raceInput("race-h"), 1_000);
  const race = registry.get("race-h");
  // Browsers and agents are ready, nothing runs, and the start is published.
  assert.equal(snapshot.race.status, "starting");
  assert.equal(prepareCalls.length, 4);
  assert.equal(race.fight.startsAt, 12_500);
  assert.equal(registry.scheduledStart("race-h"), 12_500);
  // Its market stays closed until the start, so it opens as the intro ends.
  assert.equal(race.market.status, "pending");
  registry.users.ensure({ userId: "early-01" }, 3_000);
  assert.throws(
    () => race.placeOrder({ userId: "early-01", racerId: "racer-1", side: "yes", action: "buy", quantity: 1 }, 3_000),
    isCode("market_closed"),
  );

  await registry.tickAll(12_000);
  assert.equal(race.engine.race.status, "starting");
  assert.equal(race.market.status, "pending");

  await registry.tickAll(12_500);
  assert.equal(race.engine.race.status, "running");
  assert.equal(race.engine.race.startedAt, 12_500);
  assert.equal(race.market.status, "open");
  assert.equal(prepareCalls.length, 4);
  assert.equal(registry.scheduledStart("race-h"), null);
});

function manualStartTimers() {
  const timers: Array<{ start: () => Promise<void>; delayMs: number; cancelled: boolean }> = [];
  const startTimer = (start: () => Promise<void>, delayMs: number) => {
    const timer = { start, delayMs, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  return { timers, startTimer };
}

test("a held start runs at its exact start time, not on the next tick", async () => {
  const { factory } = createFactory();
  const { timers, startTimer } = manualStartTimers();
  let now = 3_000;
  const registry = new RaceRegistry(factory, { startHoldMs: 9_400, clock: () => now, startTimer });
  await registry.create(raceInput("race-t"), 1_000);
  const race = registry.get("race-t");
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.delayMs, 9_400);
  assert.equal(race.market.status, "pending");

  // Even a millisecond early, the agents and the market start at the published start.
  now = 12_399;
  await timers[0]!.start();
  assert.equal(race.engine.race.status, "running");
  assert.equal(race.engine.race.startedAt, 12_400);
  assert.equal(race.market.status, "open");
  assert.equal(registry.scheduledStart("race-t"), null);
});

test("the ticker still starts a held fight and cancels its timer", async () => {
  const { factory } = createFactory();
  const { timers, startTimer } = manualStartTimers();
  const registry = new RaceRegistry(factory, { startHoldMs: 9_400, clock: () => 3_000, startTimer });
  await registry.create(raceInput("race-k"), 1_000);
  const race = registry.get("race-k");

  await registry.tickAll(12_400);
  assert.equal(race.engine.race.status, "running");
  assert.equal(race.market.status, "open");
  assert.equal(timers[0]!.cancelled, true);

  await registry.create(raceInput("race-z"), 20_000);
  await registry.shutdown();
  assert.equal(timers[1]!.cancelled, true);
});

test("a scheduled fight keeps pre-fight trading", async () => {
  const { factory } = createFactory();
  const registry = new RaceRegistry(factory, { startHoldMs: 9_400, clock: () => 3_000, startTimer: () => () => undefined });
  await registry.create(raceInput("race-p", { startsAt: 60_000 }), 1_000);
  assert.equal(registry.get("race-p").market.status, "open");
});

test("a failed scheduled start leaves the fight voided and refunded", async () => {
  const { factory } = createFactory({ failRaceIds: new Set(["race-f"]) });
  const registry = new RaceRegistry(factory, { startingBalance: 100 });
  await registry.create(raceInput("race-f", { startsAt: 10_000 }), 1_000);
  registry.users.ensure({ userId: "alice-01" }, 1_000);
  const race = registry.get("race-f");
  const { total } = race.placeOrder(
    { userId: "alice-01", racerId: "racer-2", side: "yes", action: "buy", quantity: 8 },
    2_000,
  );
  assert.equal(registry.ledger.balance("alice-01"), Math.round((100 - total) * 1e6) / 1e6);

  await registry.tickAll(10_000);
  assert.equal(race.engine.race.status, "timed_out");
  assert.equal(race.market.status, "unresolved");
  assert.equal(registry.ledger.balance("alice-01"), 100);
  assert.equal(registry.list().length, 1);
  const summary = presentFightSummary(race, { now: 10_000, showSabotageUpfront: true });
  assert.equal(summary.status, "resolved");
  assert.equal(summary.voided, true);
});

test("prune keeps the newest resolved fights and archives the rest", async () => {
  const { factory } = createFactory();
  const registry = new RaceRegistry(factory);
  for (const [index, raceId] of ["race-1", "race-2", "race-3"].entries()) {
    await registry.create(raceInput(raceId), 1_000 * (index + 1));
    await winRace(registry.get(raceId), "racer-1", 50_000 + index * 1_000);
  }
  await registry.create(raceInput("race-live"), 60_000);

  registry.prune(1);
  assert.deepEqual(registry.list().map((race) => race.raceId), ["race-3", "race-live"]);
  assert.equal(registry.fightInfo("race-1")?.number, 1);
  assert.equal(registry.fightInfo("race-1")?.agents[0].key, "gpt");
  assert.equal(registry.archivedLeaderboard().length, 2);
});

test("finished fights and replays remain available through the retention window", async () => {
  const { factory } = createFactory();
  const registry = new RaceRegistry(factory);
  await registry.create(raceInput("race-retained"), 1_000);
  await winRace(registry.get("race-retained"), "racer-1", 50_000);
  await registry.replays.put("race-retained", "racer-1", {
    playlist: "#EXTM3U\n#EXT-X-ENDLIST\n",
    files: [],
  });

  await registry.pruneResolved(50_000 + RESOLVED_RETENTION_MS - 1);
  assert.ok(registry.find("race-retained"));
  assert.equal(await registry.replays.playlist("race-retained", "racer-1"), "#EXTM3U\n#EXT-X-ENDLIST\n");

  await registry.pruneResolved(50_000 + RESOLVED_RETENTION_MS);
  assert.equal(registry.find("race-retained"), undefined);
  assert.equal(await registry.replays.playlist("race-retained", "racer-1"), null);
  await registry.shutdown();
});
