import assert from "node:assert/strict";
import test from "node:test";
import type {
  CompetitorAgentRunner,
  CompetitorContext,
  CompletionJudge,
  CourseVerifier,
  RacerSessionHandle,
  RacerSessionManager,
} from "../src/application/contracts.js";
import { normalizeFightMetadata } from "../src/application/fight-metadata.js";
import {
  RaceCoordinator,
  type RaceChange,
} from "../src/application/race-coordinator.js";
import { DEFAULT_MAX_STEPS } from "../src/application/race-telemetry.js";
import { DomainError } from "../src/domain/errors.js";
import { describeHazard } from "../src/domain/sabotage.js";
import type {
  DisruptionCommand,
  DisruptionResult,
  ObstacleProvider,
} from "../src/domain/types.js";
import { InMemoryRaceEventStore } from "../src/persistence/in-memory-event-store.js";
import { InMemoryCreditLedger } from "../src/wallet/credit-ledger.js";

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

const policy: DisruptionCommand = {
  hazardType: "blocking_modal",
  targetRole: "primary-action",
  durationMs: 4_000,
  intensity: 2,
};

class FakeSessions implements RacerSessionManager {
  released = false;
  /** Racers whose own session was released, in order. */
  releasedRacers: string[] = [];

  async create(racerId: string): Promise<RacerSessionHandle> {
    return { racerId, steelSessionId: `steel-${racerId}` };
  }

  async release(racerId: string): Promise<void> {
    this.releasedRacers.push(racerId);
  }

  async releaseAll(): Promise<void> {
    this.released = true;
  }
}

class FakeRunner implements CompetitorAgentRunner {
  running = new Map<string, CompetitorContext>();
  rejecters = new Map<string, (error: Error) => void>();

  constructor(private readonly prepareError?: Error) {}

  async prepare(): Promise<void> {
    if (this.prepareError) throw this.prepareError;
  }

  run(context: CompetitorContext): Promise<void> {
    this.running.set(context.racerId, context);
    return new Promise<void>((_resolve, reject) => {
      this.rejecters.set(context.racerId, reject);
    });
  }

  async stop(): Promise<void> {}
}

class FakeVerifier implements CourseVerifier {
  openings: string[] = [];
  /** False for a run the course does not serve; only then may the master judge decide. */
  covers = true;
  /** What the course's own state says about any checkpoint or finish. */
  verifies = true;

  coversRun(): boolean {
    return this.covers;
  }

  async verifyTargetOpening(input: { racerId: string }): Promise<boolean> {
    this.openings.push(input.racerId);
    return true;
  }

  async verifyCheckpoint(): Promise<boolean> {
    return this.verifies;
  }

  async verifyFinish(): Promise<boolean> {
    return this.verifies;
  }
}

class FakeObstacles implements ObstacleProvider {
  policyCalls: number[] = [];

  async getPolicy(_raceId: string, checkpoint: number): Promise<DisruptionCommand | null> {
    this.policyCalls.push(checkpoint);
    return policy;
  }

  async apply(): Promise<DisruptionResult> {
    return { applied: true };
  }
}

function setup(options: {
  obstacles?: ObstacleProvider;
  prepareError?: Error;
  fight?: Parameters<typeof normalizeFightMetadata>[0]["fight"];
  completionJudge?: CompletionJudge;
  /** The course does not serve the run, so the master judge reviews its pages. */
  offCourse?: boolean;
  /** A step budget the runner declares before the start. */
  maxSteps?: number;
} = {}) {
  const sessions = new FakeSessions();
  const runner = Object.assign(
    new FakeRunner(options.prepareError),
    options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps },
  );
  const verifier = new FakeVerifier();
  if (options.offCourse) verifier.covers = false;
  const events = new InMemoryRaceEventStore();
  const ledger = new InMemoryCreditLedger();
  const coordinator = new RaceCoordinator(
    {
      raceId: "race-1",
      courseId: "course-1",
      seed: "seed-1",
      checkpointCount: 3,
      task: "Buy the blue mug and check out",
      fight: { createdAt: 500, ...options.fight },
    },
    {
      sessionManager: sessions,
      agentRunner: runner,
      courseVerifier: verifier,
      completionJudge: options.completionJudge,
      eventStore: events,
      obstacleProvider: options.obstacles,
      ledger,
    },
  );
  ledger.credit("alice", 100, { type: "deposit", at: 0 });
  ledger.credit("bob", 100, { type: "deposit", at: 0 });
  return { coordinator, sessions, runner, verifier, events, ledger };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("fills fight metadata defaults and has no sabotage without a provider", () => {
  const { coordinator } = setup();
  const fight = coordinator.fight;
  assert.equal(fight.number, 1);
  assert.equal(fight.title, "Buy the blue mug and check out");
  assert.equal(fight.taskDetail, fight.task);
  assert.deepEqual(fight.checkpointLabels, ["Checkpoint 1", "Checkpoint 2", "Checkpoint 3"]);
  assert.deepEqual(fight.agents.map((agent) => agent.key), ["gpt", "claude", "gemini", "grok"]);
  assert.equal(fight.createdAt, 500);
  assert.equal(fight.startsAt, null);
  assert.equal(fight.sabotage, null);
  assert.equal(coordinator.sabotage, null);
  assert.deepEqual(coordinator.priceHistory(), [{
    t: 500,
    prices: { "racer-1": 0.25, "racer-2": 0.25, "racer-3": 0.25, "racer-4": 0.25 },
  }]);

  fight.title = "mutated";
  assert.notEqual(coordinator.fight.title, "mutated");
});

test("fight metadata overrides are validated", () => {
  const base = { courseId: "c", checkpointCount: 2, task: "t" };
  const invalid = (fight: object) =>
    assert.throws(
      () => normalizeFightMetadata({ ...base, fight }),
      (error: unknown) => error instanceof DomainError && error.code === "invalid",
    );
  invalid({ title: "x".repeat(91) });
  invalid({ checkpointLabels: ["one"] });
  invalid({ agents: [{ key: "a", name: "A", provider: "p" }] });
  invalid({ sabotage: { checkpoint: 3, summary: "s" } });
  invalid({ sabotage: { checkpoint: 1, summary: "s".repeat(71) } });
  invalid({ sabotage: { checkpoint: 1, summary: "s", policy: { ...policy, intensity: 9 } } });
  assert.equal(
    normalizeFightMetadata({ ...base, task: "y".repeat(120) }).title.length,
    90,
  );
});

test("a default sabotage arms at checkpoint 1 and describes the armed hazard", async () => {
  const obstacles = new FakeObstacles();
  const { coordinator } = setup({ obstacles });
  const before = coordinator.sabotage;
  assert.equal(before?.plan.checkpoint, 1);
  assert.equal(before?.plan.summary, "Sabotage armed at Checkpoint 1");
  assert.equal(before?.state, "armed");
  assert.equal(before?.armed, false);
  assert.equal(before?.policy, null);
  assert.equal(before?.tier, null);

  await coordinator.prepareAndStart(1_000);
  const after = coordinator.sabotage;
  assert.equal(after?.armed, true);
  assert.deepEqual(after?.policy, policy);
  assert.equal(after?.tier, "intermediate");
  assert.equal(after?.plan.summary, describeHazard(policy, "Checkpoint 1"));
  assert.equal(coordinator.fight.sabotage?.summary, after?.plan.summary);
  assert.deepEqual(obstacles.policyCalls, [1]);
  const plan = coordinator.engine.race.sabotagePlan;
  assert.equal(plan?.source, "fallback");
  assert.equal(plan?.trigger.checkpoint, 1);
  await coordinator.recordCheckpoint("racer-1", 1, 2_000);
  assert.deepEqual(
    coordinator.engine.events
      .filter((event) => event.racerId === "racer-1")
      .map((event) => event.type),
    ["racer_ready", "checkpoint_reached", "sabotage_triggered", "sabotage_applied"],
  );
  assert.equal(coordinator.engine.racers.get("racer-1")?.status, "recovering");
  await coordinator.recordRecovery("racer-1", 2_100);
  await coordinator.shutdown();
});

test("a course run never consults the master judge, and master claims are verified by the course", async () => {
  const judged: string[] = [];
  const { coordinator, runner, verifier } = setup({
    completionJudge: {
      async judgeCheckpoint(input) {
        judged.push(`checkpoint ${input.checkpoint}`);
        return true;
      },
      async judgeCompletion() {
        judged.push("completion");
        return true;
      },
    },
  });
  // Worker reports are stamped with the wall clock.
  await coordinator.prepareAndStart(Date.now());
  const context = runner.running.get("racer-1");
  assert.ok(context);
  // The worker gets neither the judge nor a page review.
  assert.equal(context.completionJudge, undefined);
  assert.equal(context.reviewProgress, undefined);

  // A claim the judge approved still needs the course to agree.
  verifier.verifies = false;
  assert.equal(await context.reportCheckpoint(1, "master"), false);
  assert.equal(await context.reportFinish("master"), false);
  assert.equal(coordinator.engine.racers.get("racer-1")?.checkpoint, 0);
  assert.equal(coordinator.engine.racers.get("racer-1")?.status, "running");

  verifier.verifies = true;
  assert.equal(await context.reportCheckpoint(1, "master"), true);
  assert.equal(coordinator.engine.racers.get("racer-1")?.checkpoint, 1);
  assert.deepEqual(judged, []);
  await coordinator.shutdown();
});

test("master review advances a worker that never emits checkpoint decisions", async () => {
  const checkpointClaims: number[] = [];
  const completionClaims: number[] = [];
  const { coordinator, runner } = setup({
    // The judge only reviews a run the course does not serve.
    offCourse: true,
    completionJudge: {
      async judgeCheckpoint(input) {
        checkpointClaims.push(input.checkpoint);
        return true;
      },
      async judgeCompletion() {
        completionClaims.push(1);
        return true;
      },
    },
  });
  await coordinator.prepareAndStart(1_000);
  const context = runner.running.get("racer-1");
  assert.ok(context?.reviewProgress);

  const observation = {
    url: "https://shop.test/checkout",
    title: "Checkout",
    bodyText: "Order confirmation",
    controls: [],
    at: 2_000,
    step: 1,
    maxSteps: 60,
  };
  const duplicateReviews = await Promise.all([
    context!.reviewProgress!(observation),
    context!.reviewProgress!(observation),
  ]);
  assert.deepEqual(duplicateReviews, [false, false]);
  assert.equal(await context!.reviewProgress!({ ...observation, at: 2_001, step: 2 }), false);
  assert.equal(await context!.reviewProgress!({ ...observation, at: 2_002, step: 3 }), true);

  assert.deepEqual(checkpointClaims, [1, 2, 3]);
  assert.equal(completionClaims.length, 1);
  assert.equal(coordinator.engine.racers.get("racer-1")?.status, "finished");
  await coordinator.shutdown();
});

test("the master judges an unchanged page once, and asks again when it changes or fails", async () => {
  const judged: string[] = [];
  let failNext = false;
  const { coordinator, runner } = setup({
    offCourse: true,
    completionJudge: {
      async judgeCheckpoint(input) {
        judged.push(input.observation.bodyText);
        if (failNext) {
          failNext = false;
          throw new Error("judge unavailable");
        }
        return false;
      },
      async judgeCompletion() {
        return false;
      },
    },
  });
  await coordinator.prepareAndStart(1_000);
  const review = runner.running.get("racer-1")?.reviewProgress;
  assert.ok(review);
  const page = {
    url: "https://shop.test/search",
    title: "Search",
    bodyText: "8 results",
    controls: [],
    at: 2_000,
    step: 1,
    maxSteps: 40,
  };

  // Every step reviews the page; only the first review reaches the judge.
  for (let step = 1; step <= 4; step += 1) {
    assert.equal(await review({ ...page, at: 2_000 + step, step }), false);
  }
  assert.deepEqual(judged, ["8 results"]);

  // A changed page is judged, and a review the judge could not answer is
  // asked again on the next step, then remembered.
  failNext = true;
  for (let step = 5; step <= 7; step += 1) {
    await review({ ...page, bodyText: "Cart (1)", at: 2_000 + step, step });
  }
  assert.deepEqual(judged, ["8 results", "Cart (1)", "Cart (1)"]);
  await coordinator.shutdown();
});

test("an operator plan keeps its summary and fixed policy", async () => {
  const fixed: DisruptionCommand = { ...policy, hazardType: "insert_decoy", intensity: 3 };
  const obstacles = new FakeObstacles();
  const { coordinator } = setup({
    obstacles,
    fight: {
      checkpointLabels: ["Cart", "Shipping", "Pay"],
      sabotage: { checkpoint: 2, summary: "Decoy at shipping", policy: fixed },
    },
  });
  assert.deepEqual(await coordinator.arm(900), fixed);
  assert.equal(coordinator.sabotage?.plan.summary, "Decoy at shipping");
  assert.equal(coordinator.sabotage?.checkpointLabel, "Shipping");
  assert.equal(coordinator.sabotage?.armedAt, 900);
  assert.equal(coordinator.sabotage?.tier, "difficult");
  const plan = coordinator.engine.race.sabotagePlan;
  assert.equal(plan?.source, "operator");
  assert.equal(plan?.trigger.checkpoint, 2);
  assert.deepEqual(obstacles.policyCalls, []);
});

test("an obstacle provider with armRace chooses the race-wide plan", async () => {
  const chosen: DisruptionCommand = { ...policy, intensity: 1 };
  const triggers: number[] = [];
  const obstacles: ObstacleProvider = {
    async armRace(input) {
      triggers.push(input.trigger.checkpoint);
      return {
        raceId: input.raceId,
        tier: "basic",
        trigger: input.trigger,
        policy: chosen,
        selectedAt: 1,
        source: "model",
      };
    },
    async getPolicy() {
      throw new Error("getPolicy must not be used when armRace exists");
    },
    async apply() {
      return { applied: true };
    },
  };
  const { coordinator, verifier } = setup({
    obstacles,
    fight: { sabotage: { checkpoint: 3, summary: "Late modal" } },
  });
  await coordinator.prepareAndStart(1_000);
  assert.deepEqual(triggers, []);
  assert.equal(coordinator.sabotage, null);
  assert.equal(coordinator.engine.race.sabotagePlan, undefined);

  await coordinator.recordCheckpoint("racer-4", 1, 1_100);
  await coordinator.recordCheckpoint("racer-4", 2, 1_200);
  assert.deepEqual(verifier.openings, []);
  await coordinator.recordCheckpoint("racer-4", 3, 1_300);
  assert.deepEqual(verifier.openings, []);
  assert.equal(coordinator.sabotage, null);
  assert.equal(
    coordinator.engine.events.some((event) => event.type === "sabotage_applied"),
    false,
  );
  await coordinator.shutdown();
});

test("sabotage hits drive telemetry, run status, signals and sabotage state", async () => {
  const { coordinator } = setup({
    obstacles: new FakeObstacles(),
    fight: { sabotage: { checkpoint: 2, summary: "Modal at checkpoint 2" } },
  });
  await coordinator.prepareAndStart(1_000);
  assert.deepEqual(coordinator.openingPrices, coordinator.market.pricesSnapshot());

  await coordinator.recordCheckpoint("racer-1", 1, 2_000);
  assert.equal(coordinator.market.pricesSnapshot()["racer-1"], round(135 / 435));
  assert.equal(coordinator.sabotage?.state, "armed");

  await coordinator.recordCheckpoint("racer-1", 2, 3_000);
  const sabotage = coordinator.sabotage;
  assert.equal(sabotage?.state, "fired");
  assert.equal(sabotage?.firedAt, 3_000);
  assert.deepEqual(sabotage?.hitRacerIds, ["racer-1"]);
  assert.equal(coordinator.engine.racers.get("racer-1")?.status, "recovering");
  assert.equal(coordinator.runStatus("racer-1"), "recovering");
  assert.equal(coordinator.market.pricesSnapshot()["racer-1"], round(145 / 445));

  await coordinator.recordRecovery("racer-1", 7_000);
  assert.equal(coordinator.engine.racers.get("racer-1")?.status, "running");
  assert.equal(coordinator.runStatus("racer-1"), "run");
  assert.equal(coordinator.market.pricesSnapshot()["racer-1"], round(155 / 455));

  const telemetry = coordinator.telemetry.racer("racer-1");
  assert.deepEqual(
    telemetry.log.map((entry) => entry.kind),
    ["checkpoint", "checkpoint", "sabotage", "recovered"],
  );
  assert.match(telemetry.log[2]?.text ?? "", /^Sabotage active:/);
  assert.equal(telemetry.log[2]?.kind, "sabotage");
  assert.equal(telemetry.log[3]?.text, "Sabotage cleared: Recovered");
  assert.deepEqual(telemetry.checkpointClearedAt, [2_000, 3_000, null]);
  assert.equal(telemetry.sabotageHitAt, 3_000);
  assert.equal(telemetry.recoveredAt, 7_000);

  const history = coordinator.priceHistory();
  const racer1 = history.map((point) => point.prices["racer-1"]);
  // The checkpoint is published before the sabotage is applied, so the chart
  // shows the +0.35L boost (170/470) and then the -0.25L hit.
  assert.deepEqual(racer1.slice(-4), [
    round(135 / 435),
    round(170 / 470),
    round(145 / 445),
    round(155 / 455),
  ]);
  await coordinator.shutdown();
});

test("sabotage expires once hazards freeze without firing", async () => {
  const { coordinator } = setup({ obstacles: new FakeObstacles() });
  await coordinator.prepareAndStart(1_000);
  await coordinator.tick(181_000);
  assert.equal(coordinator.sabotage?.state, "expired");
  assert.equal(coordinator.market.status, "frozen");
  await coordinator.shutdown();
});

test("placeOrder returns dto receipts and is idempotent per clientOrderId", async () => {
  const { coordinator, ledger } = setup();
  await coordinator.prepareAndStart(1_000);

  const quote = coordinator.market.quote("racer-1", "yes", "buy", 10);
  const receipt = coordinator.placeOrder({
    userId: "alice",
    racerId: "racer-1",
    side: "yes",
    action: "buy",
    quantity: 10,
    clientOrderId: "order-1",
  }, 2_000);
  assert.equal(receipt.raceId, "race-1");
  assert.equal(receipt.clientOrderId, "order-1");
  assert.equal(receipt.price, quote.averagePrice);
  assert.equal(receipt.total, quote.total);
  assert.ok(receipt.price > 0.25, "the fill pays for its own price impact");
  assert.equal(receipt.payoutIfWin, 10);
  assert.equal(receipt.executedAt, 2_000);
  assert.equal(ledger.balance("alice"), round(100 - quote.total));

  const repeat = coordinator.placeOrder({
    userId: "alice",
    racerId: "racer-1",
    side: "yes",
    action: "buy",
    quantity: 10,
    clientOrderId: "order-1",
  }, 2_500);
  assert.deepEqual(repeat, receipt);
  assert.equal(ledger.balance("alice"), round(100 - quote.total));

  const sold = coordinator.placeOrder({
    userId: "alice",
    racerId: "racer-1",
    side: "yes",
    action: "sell",
    quantity: 4,
  }, 3_000);
  assert.equal(sold.payoutIfWin, 0);
  assert.equal(sold.clientOrderId, null);
  assert.notEqual(sold.orderId, receipt.orderId);

  const rejects = (order: object, code: string) =>
    assert.throws(
      () => coordinator.placeOrder({
        userId: "bob",
        racerId: "racer-2",
        side: "no",
        action: "buy",
        quantity: 1,
        ...order,
      }),
      (error: unknown) => error instanceof DomainError && error.code === code,
    );
  rejects({ action: "sell" }, "insufficient_position");
  rejects({ limitPrice: 0.5 }, "price_moved");
  rejects({ racerId: "racer-9" }, "not_found");
  rejects({ quantity: 0 }, "invalid");
  rejects({ side: "maybe" }, "invalid");
  rejects({ quantity: 1_000 }, "insufficient_balance");
  await coordinator.shutdown();
});

test("subscribers get price, fight and account changes; errors are isolated", async () => {
  const { coordinator } = setup();
  await coordinator.prepareAndStart(1_000);
  coordinator.placeOrder({ userId: "bob", racerId: "racer-2", side: "yes", action: "buy", quantity: 5 }, 1_500);

  const seen: RaceChange[] = [];
  coordinator.subscribe(() => {
    throw new Error("broken subscriber");
  });
  const unsubscribe = coordinator.subscribe((change) => seen.push(change));
  coordinator.placeOrder({ userId: "alice", racerId: "racer-1", side: "no", action: "buy", quantity: 5 }, 2_000);

  assert.deepEqual(seen.map((change) => change.kind), ["price", "fight", "account"]);
  const price = seen[0];
  assert.ok(price.kind === "price");
  assert.equal(price.point.t, 2_000);
  const account = seen[2];
  assert.ok(account.kind === "account");
  assert.deepEqual([...account.userIds].sort(), ["alice", "bob"]);

  unsubscribe();
  coordinator.placeOrder({ userId: "alice", racerId: "racer-1", side: "no", action: "buy", quantity: 1 }, 2_500);
  assert.equal(seen.length, 3);
  await coordinator.shutdown();
});

test("tick appends a heartbeat price point while live", async () => {
  const { coordinator } = setup();
  await coordinator.prepareAndStart(1_000);
  const points: number[] = [];
  coordinator.subscribe((change) => {
    if (change.kind === "price") points.push(change.point.t);
  });
  await coordinator.tick(3_000);
  assert.deepEqual(points, []);
  await coordinator.tick(6_000);
  assert.deepEqual(points, [6_000]);
  assert.equal(coordinator.priceHistory().at(-1)?.t, 6_000);
  await coordinator.shutdown();
});

test("a failed start refunds positions, aborts the race and rethrows", async () => {
  const { coordinator, ledger, sessions, events } = setup({
    prepareError: new Error("steel unavailable"),
  });
  const bought = coordinator.placeOrder({ userId: "alice", racerId: "racer-1", side: "yes", action: "buy", quantity: 10 }, 600);
  assert.equal(ledger.balance("alice"), round(100 - bought.total));

  await assert.rejects(coordinator.prepareAndStart(1_000), /steel unavailable/);
  assert.equal(coordinator.market.status, "unresolved");
  assert.equal(ledger.balance("alice"), 100);
  assert.equal(ledger.entries("alice").at(-1)?.type, "refund");
  assert.equal(coordinator.engine.race.status, "timed_out");
  assert.equal(coordinator.closedAt, 1_000);
  assert.equal(sessions.released, true);
  const last = (await events.list("race-1")).at(-1);
  assert.equal(last?.type, "race_timed_out");
  assert.deepEqual(last?.metadata, { reason: "start_failed" });
});

test("a runner's declared step budget shows before its first report", async () => {
  const declared = setup({ maxSteps: 90 });
  assert.equal(declared.coordinator.telemetry.racer("racer-1").maxSteps, 90);
  await declared.coordinator.prepareAndStart(1_000);
  assert.equal(declared.coordinator.telemetry.racer("racer-4").maxSteps, 90);

  // Without one, the placeholder stands until a report brings the budget.
  const undeclared = setup();
  assert.equal(undeclared.coordinator.telemetry.racer("racer-1").maxSteps, DEFAULT_MAX_STEPS);
});

test("competitor reports feed telemetry and never throw into the runner", async () => {
  const { coordinator, runner } = setup();
  await coordinator.prepareAndStart(1_000);
  const frames: string[] = [];
  coordinator.subscribe((change) => {
    if (change.kind === "frame") frames.push(change.racerId);
  });
  const context = runner.running.get("racer-1");
  assert.ok(context?.reportAction && context.reportFrame);

  context.reportAction({
    kind: "action",
    text: "click add-to-cart",
    url: "https://course.test/cart",
    step: 3,
    maxSteps: 40,
  });
  const telemetry = coordinator.telemetry.racer("racer-1");
  assert.equal(telemetry.step, 3);
  assert.equal(telemetry.maxSteps, 40);
  assert.equal(telemetry.url, "https://course.test/cart");
  assert.equal(telemetry.currentAction, "click add-to-cart");

  assert.doesNotThrow(() => context.reportAction?.({} as never));
  assert.doesNotThrow(() =>
    context.reportFrame?.({ contentType: "text/html" as "image/png", body: "x" }));
  context.reportFrame({ contentType: "image/svg+xml", body: "<svg/>", capturedAt: 1_200 });
  assert.equal(coordinator.frame("racer-1")?.seq, 1);
  assert.equal(coordinator.frame("racer-1")?.capturedAt, 1_200);
  assert.deepEqual(frames, ["racer-1"]);
  await coordinator.shutdown();
});

test("a failed racer collapses to the price floor", async () => {
  const { coordinator, runner } = setup();
  await coordinator.prepareAndStart(1_000);
  runner.rejecters.get("racer-3")?.(new Error("model crashed"));
  await flushAsync();
  assert.equal(coordinator.engine.racers.get("racer-3")?.status, "failed");
  assert.equal(coordinator.market.isCollapsed("racer-3"), true);
  assert.equal(coordinator.runStatus("racer-3"), "bad");
  // The log reads as a cause; the event keeps the raw reason for diagnostics.
  assert.equal(coordinator.telemetry.racer("racer-3").log.at(-1)?.text, "Failed: stopped after its model provider failed");
  assert.equal(
    coordinator.engine.events.find((event) => event.type === "racer_failed")?.metadata?.reason,
    "model crashed",
  );
  await coordinator.shutdown();
});

test("a browser that dies mid-race fails only its racer, readably, and releases only its session", async () => {
  const { coordinator, runner, sessions } = setup();
  await coordinator.prepareAndStart(1_000);
  // As in shop-mtzaxsks-cacac3: racer-2 stops on the budget, then Steel's
  // session timeout closes racer-3's browser 1.4 s later.
  runner.rejecters.get("racer-2")?.(new Error(
    "racer-2 model decision failed after 3 provider/protocol retries: OpenRouter race budget of $0.25 was exhausted",
  ));
  await flushAsync();
  runner.rejecters.get("racer-3")?.(new Error("page.title: Target page, context or browser has been closed"));
  await flushAsync();

  assert.deepEqual(sessions.releasedRacers, ["racer-2", "racer-3"]);
  assert.equal(coordinator.engine.racers.get("racer-3")?.status, "failed");
  assert.equal(
    coordinator.telemetry.racer("racer-3").log.at(-1)?.text,
    "Failed: stopped when its browser crashed",
  );
  // The others race on in their own browsers.
  assert.equal(coordinator.engine.racers.get("racer-1")?.status, "running");
  assert.equal(coordinator.engine.racers.get("racer-4")?.status, "running");
  assert.equal(coordinator.engine.race.status, "running");
  assert.equal(sessions.released, false);
  await coordinator.shutdown();
});

test("a verified finish the race cannot record is logged as a readable cause", async () => {
  const { coordinator, runner } = setup({ obstacles: new FakeObstacles() });
  await coordinator.prepareAndStart(Date.now());
  // The sabotage at checkpoint 1 leaves racer-1 recovering, so the race has
  // not recorded its last checkpoints when the course reports it finished.
  await coordinator.recordCheckpoint("racer-1", 1);
  assert.equal(coordinator.engine.racers.get("racer-1")?.status, "recovering");

  assert.equal(await runner.running.get("racer-1")?.checkFinish?.(), false);
  const text = coordinator.telemetry.racer("racer-1").log.at(-1)?.text;
  assert.equal(text, "Verified completion could not be finalized: its progress could not be verified");
  // Not the raw engine error, which names the racer and the engine rule.
  assert.doesNotMatch(text ?? "", /racer-1|final checkpoint/);
  await coordinator.shutdown();
});

test("resolution settles through the shared ledger and records closedAt", async () => {
  const { coordinator, ledger } = setup();
  await coordinator.prepareAndStart(1_000);
  const bought = coordinator.placeOrder({ userId: "alice", racerId: "racer-2", side: "yes", action: "buy", quantity: 10 }, 1_500);
  const accounts: string[][] = [];
  coordinator.subscribe((change) => {
    if (change.kind === "account") accounts.push(change.userIds);
  });

  for (const checkpoint of [1, 2, 3]) {
    await coordinator.recordCheckpoint("racer-2", checkpoint, 2_000 + checkpoint);
  }
  assert.equal(coordinator.closedAt, null);
  await coordinator.recordFinish("racer-2", 5_000);

  assert.equal(coordinator.market.status, "resolved");
  assert.equal(coordinator.closedAt, 5_000);
  assert.equal(ledger.balance("alice"), round(100 - bought.total + 10));
  assert.equal(ledger.entries("alice").at(-1)?.type, "payout");
  assert.ok(accounts.at(-1)?.includes("alice"));
  assert.equal(coordinator.telemetry.racer("racer-2").log.at(-1)?.kind, "status");
});
