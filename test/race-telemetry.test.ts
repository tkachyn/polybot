import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_LOG_LIMIT,
  PRICE_HISTORY_LIMIT,
  RaceTelemetry,
  STEP_FRAME_LIMIT,
  STEP_RECORD_LIMIT,
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
  assert.equal(deriveRunStatus("recovering", calm), "recovering");
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
    "recovering",
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

test("stores one bounded redacted worker state and deduplicates repeats", () => {
  const telemetry = new RaceTelemetry(racers, 3);
  const observation = {
    url: "https://course.test/cart?token=secret&raceId=race-1",
    title: "Cart",
    bodyText: "Checkout password=secret " + "x".repeat(5_000),
    controls: [{
      tag: "button",
      role: "button",
      arenaRole: "primary-action",
      text: "Checkout",
      disabled: false,
      visible: true,
    }],
    at: 1_000,
    step: 4,
    maxSteps: 60,
    candidateMilestone: "checkpoint:2",
    navigated: true,
  };
  assert.equal(telemetry.recordState("racer-1", observation), true);
  assert.equal(telemetry.recordState("racer-1", observation), false);
  const state = telemetry.latestState("racer-1");
  assert.equal(state?.url, "https://course.test/cart");
  assert.doesNotMatch(state?.bodyText ?? "", /password=secret/);
  assert.ok((state?.bodyText.length ?? 0) <= 4_000);
  assert.equal(state?.candidateMilestone, "checkpoint:2");
  assert.equal(telemetry.latestState("racer-2"), null);
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

test("keeps every step's full capture as a bounded list of copies", () => {
  const telemetry = new RaceTelemetry(racers, 3);
  const observation = {
    url: "https://course.test/cart",
    title: "Cart",
    text: "Your cart",
    controls: [
      { tag: "button", role: null, arenaRole: "primary-action", label: "Checkout", visible: true, disabled: false },
    ],
  };
  const signature = '{"type":"click","targetRole":"primary-action","label":"Checkout"}';
  telemetry.recordAction("racer-1", report({
    text: 'Clicked "Checkout" (primary-action)',
    step: 3,
    url: "https://course.test/cart",
    at: 5_000,
    observedAt: 3_000,
    decidedAt: 4_500,
    observation,
    action: { type: "click", targetRole: "primary-action", label: "Checkout" },
    reasoning: `  Checkout\n is next. ${"x".repeat(500)}`,
    signature,
    evidence: {
      target: { role: "primary-action", text: "Checkout", decoy: false },
      navigated: true,
      clearedSabotage: true,
      cursor: { x: 10, y: 20, viewportWidth: 800, viewportHeight: 600, action: "click" },
    },
  }), 9_999);
  telemetry.recordAction("racer-1", report({
    kind: "error",
    text: 'Clicked "Pay" (primary-action)',
    error: "\x1b[2mlocator.click: Timeout 5000ms exceeded.\x1b[22m",
    modelError: "locator.click: Timeout 5000ms exceeded. Another element is covering the control.",
    step: 4,
    evidence: { blockedBy: "modal" },
    // Nothing to record: reads as no pause and no issue.
    rateLimitWaitMs: -5,
    decisionIssue: { malformedAttempts: 0, fallback: false },
  }), 6_000);
  telemetry.recordAction("racer-1", report({
    kind: "note",
    text: "waiting for the referee",
    step: 4,
    observation: "junk" as never,
    action: { type: "teleport" } as never,
  }), 7_000);
  telemetry.recordAction("racer-1", report({
    kind: "action",
    text: "Inspected the page",
    step: 5,
    observedAt: 7_100,
    promptedAt: 7_600,
    decidedAt: 7_900,
    rateLimitWaitMs: 1_499.6,
    decisionIssue: { malformedAttempts: 2, fallback: true },
  }), 8_000);

  const [first, second, third, fourth] = telemetry.stepRecords("racer-1");
  assert.deepEqual({ ...first, reasoning: null }, {
    step: 3,
    kind: "action",
    actedAt: 5_000,
    observedAt: 3_000,
    promptedAt: null,
    decidedAt: 4_500,
    rateLimitWaitMs: 0,
    url: "https://course.test/cart",
    text: 'Clicked "Checkout" (primary-action)',
    observation,
    action: { type: "click", targetRole: "primary-action", label: "Checkout" },
    reasoning: null,
    decisionIssue: null,
    error: null,
    modelError: null,
    signature,
    evidence: {
      target: { role: "primary-action", text: "Checkout", decoy: false },
      blockedBy: null,
      navigated: true,
      clearedSabotage: true,
      cursor: { x: 10, y: 20, viewportWidth: 800, viewportHeight: 600, action: "click" },
    },
  });
  // Reasoning is whitespace-collapsed and clipped at 400 characters.
  assert.equal(first.reasoning?.length, 400);
  assert.ok(first.reasoning?.startsWith("Checkout is next. xxx"));
  // Errors lose Playwright's colour codes; absent fields are null.
  assert.deepEqual(
    [second.kind, second.error, second.evidence.blockedBy, second.evidence.target, second.observation, second.observedAt],
    ["error", "locator.click: Timeout 5000ms exceeded.", "modal", null, null, null],
  );
  // The record keeps the raw error for diagnostics and what the model was told, for prompts.
  assert.equal(second.modelError, "locator.click: Timeout 5000ms exceeded. Another element is covering the control.");
  assert.deepEqual(
    [third.kind, third.observation, third.action, third.signature, third.modelError],
    ["note", null, null, null, null],
  );
  // The prompt time, the rate-limit pause and the decision issue, as reported.
  assert.deepEqual(
    [fourth.promptedAt, fourth.rateLimitWaitMs, fourth.decisionIssue],
    [7_600, 1_500, { malformedAttempts: 2, fallback: true }],
  );
  assert.deepEqual([second.promptedAt, second.rateLimitWaitMs, second.decisionIssue], [null, 0, null]);

  // Copies: changing a returned record changes nothing stored.
  if (first.observation) first.observation.text = "mutated";
  assert.equal(telemetry.stepRecords("racer-1")[0].observation?.text, "Your cart");

  for (let step = 1; step <= STEP_RECORD_LIMIT + 20; step += 1) {
    telemetry.recordAction("racer-2", report({ text: `step ${step}`, step }), step);
  }
  const records = telemetry.stepRecords("racer-2");
  assert.equal(records.length, STEP_RECORD_LIMIT);
  assert.deepEqual([records[0].step, records.at(-1)?.step], [21, STEP_RECORD_LIMIT + 20]);
  assert.deepEqual(telemetry.stepRecords("racer-9"), []);
});

test("keeps step-tagged frames by step for the latest 300 steps, beside the latest frame", () => {
  const telemetry = new RaceTelemetry(racers, 3);
  for (let step = 1; step <= STEP_FRAME_LIMIT + 5; step += 1) {
    telemetry.recordFrame(
      "racer-1",
      { contentType: "image/jpeg", body: Buffer.from(`step-${step}`), capturedAt: step * 10, step },
      step * 10,
    );
    telemetry.recordFrame(
      "racer-1",
      { contentType: "image/jpeg", body: Buffer.from(`after-${step}`), capturedAt: step * 10 + 5 },
      step * 10 + 5,
    );
  }
  const steps = telemetry.stepFrameSteps("racer-1");
  assert.equal(steps.length, STEP_FRAME_LIMIT);
  assert.deepEqual([steps[0], steps.at(-1)], [6, STEP_FRAME_LIMIT + 5]);
  assert.equal(telemetry.stepFrame("racer-1", 5), null);
  const sixth = telemetry.stepFrame("racer-1", 6);
  assert.equal(String(sixth?.body), "step-6");
  assert.deepEqual([sixth?.capturedAt, sixth?.contentType], [60, "image/jpeg"]);
  // Normal frame handling is unchanged: the latest frame is the latest capture.
  assert.equal(String(telemetry.frame("racer-1")?.body), `after-${STEP_FRAME_LIMIT + 5}`);
  assert.equal(telemetry.frame("racer-1")?.seq, 2 * (STEP_FRAME_LIMIT + 5));

  // A repeated step replaces its frame; a step older than every kept one is dropped.
  telemetry.recordFrame("racer-1", { contentType: "image/png", body: Buffer.from("again"), step: 100 }, 9_000);
  assert.equal(String(telemetry.stepFrame("racer-1", 100)?.body), "again");
  telemetry.recordFrame("racer-1", { contentType: "image/png", body: Buffer.from("stale"), step: 2 }, 9_100);
  assert.equal(telemetry.stepFrame("racer-1", 2), null);
  assert.equal(telemetry.stepFrameSteps("racer-1").length, STEP_FRAME_LIMIT);

  // Untagged frames are never stored by step; unknown racers have none.
  telemetry.recordFrame("racer-2", { contentType: "image/svg+xml", body: "<svg/>" }, 1);
  assert.deepEqual(telemetry.stepFrameSteps("racer-2"), []);
  assert.deepEqual(telemetry.stepFrameSteps("racer-9"), []);
  assert.equal(telemetry.stepFrame("racer-9", 1), null);
});
