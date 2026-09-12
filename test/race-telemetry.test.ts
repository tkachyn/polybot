import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_LOG_LIMIT,
  PRICE_HISTORY_LIMIT,
  RaceTelemetry,
  deriveRunStatus,
} from "../src/application/race-telemetry.js";
import type { AgentActionReport } from "../src/application/contracts.js";
import { DomainError } from "../src/domain/errors.js";

const racers = ["racer-1", "racer-2", "racer-3", "racer-4"];

function report(overrides: Partial<AgentActionReport> = {}): AgentActionReport {
  return { kind: "action", text: "click next", step: 1, maxSteps: 60, ...overrides };
}

test("derives run status from phase, loops and error streaks", () => {
  const calm = { recentSignatures: ["a", "b", "c"], consecutiveErrors: 0 };
  assert.equal(deriveRunStatus("running", calm), "run");
  assert.equal(deriveRunStatus("finished", calm), "run");
  assert.equal(deriveRunStatus("recovering", calm), "bad");
  assert.equal(deriveRunStatus("failed", calm), "bad");
  assert.equal(deriveRunStatus("timed_out", calm), "bad");
  assert.equal(
    deriveRunStatus("running", { recentSignatures: ["a", "a", "a"], consecutiveErrors: 0 }),
    "warn",
  );
  assert.equal(
    deriveRunStatus("running", { recentSignatures: ["a", "a"], consecutiveErrors: 0 }),
    "run",
  );
  assert.equal(
    deriveRunStatus("running", { recentSignatures: ["b", "a", "a", "a"], consecutiveErrors: 0 }),
    "warn",
  );
  assert.equal(
    deriveRunStatus("running", { recentSignatures: [], consecutiveErrors: 2 }),
    "warn",
  );
  assert.equal(
    deriveRunStatus("recovering", { recentSignatures: [], consecutiveErrors: 5 }),
    "bad",
  );
});

test("action reports update the step, URL, current action and loop signals", () => {
  const telemetry = new RaceTelemetry(racers, 3);
  const initial = telemetry.racer("racer-1");
  assert.equal(initial.maxSteps, 60);
  assert.equal(initial.step, 0);
  assert.deepEqual(initial.checkpointClearedAt, [null, null, null]);

  const entry = telemetry.recordAction(
    "racer-1",
    report({ url: "https://course.test/cart", step: 4, maxSteps: 40, at: 1_234 }),
    9_999,
  );
  assert.deepEqual(entry, {
    seq: 1,
    at: 1_234,
    kind: "action",
    text: "click next",
    url: "https://course.test/cart",
  });
  const state = telemetry.racer("racer-1");
  assert.equal(state.step, 4);
  assert.equal(state.maxSteps, 40);
  assert.equal(state.currentAction, "click next");
  assert.equal(state.url, "https://course.test/cart");

  telemetry.recordAction("racer-1", report({ step: 5 }), 2_000);
  assert.equal(telemetry.runStatus("racer-1", "running"), "run");
  telemetry.recordAction("racer-1", report({ step: 6 }), 2_100);
  assert.equal(telemetry.runStatus("racer-1", "running"), "warn");
  telemetry.recordAction("racer-1", report({ text: "type email", step: 7 }), 2_200);
  assert.equal(telemetry.runStatus("racer-1", "running"), "run");

  // Explicit signatures override the text.
  for (let step = 8; step <= 10; step += 1) {
    telemetry.recordAction("racer-1", report({ text: `scroll ${step}`, signature: "scroll", step }), 2_300);
  }
  assert.equal(telemetry.runStatus("racer-1", "running"), "warn");
});

test("error reports count a streak that an action resets; notes are neutral", () => {
  const telemetry = new RaceTelemetry(racers, 3);
  const logged = telemetry.recordAction(
    "racer-2",
    report({ kind: "error", text: "click pay", error: "element detached", signature: "e1" }),
    1_000,
  );
  assert.equal(logged.kind, "error");
  assert.equal(logged.text, "click pay (element detached)");
  telemetry.recordAction("racer-2", report({ kind: "note", text: "thinking" }), 1_100);
  assert.equal(telemetry.racer("racer-2").consecutiveErrors, 1);
  telemetry.recordAction("racer-2", report({ kind: "error", text: "click pay", signature: "e2" }), 1_200);
  assert.equal(telemetry.racer("racer-2").consecutiveErrors, 2);
  assert.equal(telemetry.runStatus("racer-2", "running"), "warn");

  telemetry.recordAction("racer-2", report({ text: "inspect" }), 1_300);
  assert.equal(telemetry.racer("racer-2").consecutiveErrors, 0);
  assert.equal(telemetry.runStatus("racer-2", "running"), "run");
  assert.deepEqual(
    telemetry.racer("racer-2").log.map((entry) => entry.kind),
    ["error", "status", "error", "action"],
  );
});

test("bounds the action log and keeps sequence numbers increasing", () => {
  const telemetry = new RaceTelemetry(racers, 3);
  for (let index = 1; index <= ACTION_LOG_LIMIT + 15; index += 1) {
    telemetry.appendLog("racer-3", { kind: "action", text: `step ${index}`, at: index });
  }
  const log = telemetry.racer("racer-3").log;
  assert.equal(log.length, ACTION_LOG_LIMIT);
  assert.equal(log[0].seq, 16);
  assert.equal(log.at(-1)?.seq, ACTION_LOG_LIMIT + 15);
  assert.equal(log[0].text, "step 16");
  assert.equal(telemetry.racer("racer-4").log.length, 0);

  const long = telemetry.appendLog("racer-3", { kind: "status", text: "x".repeat(500), at: 1 });
  assert.equal(long.text.length, 240);
});

test("records checkpoint, sabotage and recovery timestamps", () => {
  const telemetry = new RaceTelemetry(racers, 3);
  telemetry.markCheckpointCleared("racer-1", 2, 5_000);
  telemetry.markCheckpointCleared("racer-1", 2, 6_000);
  telemetry.markCheckpointCleared("racer-1", 9, 6_000);
  telemetry.markSabotageHit("racer-1", 2, 5_000);
  telemetry.markRecovered("racer-1", 8_000);
  const state = telemetry.racer("racer-1");
  assert.deepEqual(state.checkpointClearedAt, [null, 5_000, null]);
  assert.equal(state.sabotageHitAt, 5_000);
  assert.equal(state.sabotageHitCheckpoint, 2);
  assert.equal(state.recoveredAt, 8_000);
});

test("frames bump their sequence and reject unknown content types", () => {
  const telemetry = new RaceTelemetry(racers, 3);
  assert.equal(telemetry.frame("racer-1"), null);
  const first = telemetry.recordFrame(
    "racer-1",
    { contentType: "image/svg+xml", body: "<svg/>" },
    1_000,
  );
  assert.deepEqual(first, { seq: 1, capturedAt: 1_000, contentType: "image/svg+xml", body: "<svg/>" });
  const body = Buffer.from([0xff, 0xd8]);
  telemetry.recordFrame("racer-1", { contentType: "image/jpeg", body, capturedAt: 1_500 }, 2_000);
  const second = telemetry.frame("racer-1");
  assert.equal(second?.seq, 2);
  assert.equal(second?.capturedAt, 1_500);
  assert.equal(second?.body, body);

  assert.throws(
    () => telemetry.recordFrame("racer-1", { contentType: "text/html" as "image/png", body: "x" }, 1),
    DomainError,
  );
  assert.equal(telemetry.frame("racer-1")?.seq, 2);
  assert.throws(() => telemetry.racer("racer-9"), DomainError);
});

test("price history skips duplicates unless a heartbeat forces a point", () => {
  const telemetry = new RaceTelemetry(racers, 3);
  const flat = { "racer-1": 0.25, "racer-2": 0.25, "racer-3": 0.25, "racer-4": 0.25 };
  assert.deepEqual(telemetry.appendPrice(1_000, flat), { t: 1_000, prices: flat });
  assert.equal(telemetry.appendPrice(2_000, { ...flat }), null);
  assert.deepEqual(telemetry.appendPrice(7_000, flat, { heartbeat: true }), { t: 7_000, prices: flat });

  const moved = { ...flat, "racer-1": 0.3, "racer-4": 0.2 };
  // Same-millisecond samples are nudged forward so clients keep them.
  assert.equal(telemetry.appendPrice(7_000, moved)?.t, 7_001);
  assert.equal(telemetry.appendPrice(6_000, flat)?.t, 7_002);
  assert.deepEqual(telemetry.priceHistory().map((point) => point.t), [1_000, 7_000, 7_001, 7_002]);
  assert.deepEqual(telemetry.lastPricePoint(), { t: 7_002, prices: flat });

  const history = telemetry.priceHistory();
  history[0].prices["racer-1"] = 1;
  assert.equal(telemetry.priceHistory()[0].prices["racer-1"], 0.25);
});

test("price history keeps the latest 2,000 points", () => {
  const telemetry = new RaceTelemetry(racers, 3);
  for (let index = 0; index < PRICE_HISTORY_LIMIT + 5; index += 1) {
    telemetry.appendPrice(index * 10, { "racer-1": index }, { heartbeat: true });
  }
  const history = telemetry.priceHistory();
  assert.equal(history.length, PRICE_HISTORY_LIMIT);
  assert.equal(history[0].t, 50);
  assert.equal(history.at(-1)?.t, (PRICE_HISTORY_LIMIT + 4) * 10);
});

test("stores opening prices", () => {
  const telemetry = new RaceTelemetry(racers, 3);
  assert.equal(telemetry.openingPrices(), null);
  telemetry.setOpeningPrices({ "racer-1": 0.4 });
  const opening = telemetry.openingPrices();
  assert.deepEqual(opening, { "racer-1": 0.4 });
  if (opening) opening["racer-1"] = 0;
  assert.deepEqual(telemetry.openingPrices(), { "racer-1": 0.4 });
});
