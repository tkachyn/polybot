import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActionReport } from "../src/application/contracts.js";
import { RaceTelemetry, TRACE_LIMIT } from "../src/application/race-telemetry.js";

const racers = ["racer-1", "racer-2", "racer-3", "racer-4"];

function report(overrides: Partial<AgentActionReport> = {}): AgentActionReport {
  return { kind: "action", text: "click next", step: 1, maxSteps: 60, ...overrides };
}

test("keeps a bounded evaluation trace with sanitised browser evidence", () => {
  const telemetry = new RaceTelemetry(racers, 3);
  telemetry.recordAction("racer-1", report({
    text: "click primary-action",
    step: 4,
    url: "https://course.test/shipping",
    at: 1_000,
    evidence: {
      target: { role: "primary-action", text: "  Continue\n", decoy: true },
      blockedBy: "modal",
      navigated: false,
    },
  }), 9_999);
  telemetry.recordAction("racer-1", report({
    kind: "error",
    text: "click pay",
    error: "element is disabled",
    step: 5,
    evidence: {
      target: { role: "primary-action", text: null, decoy: "yes" as unknown as boolean },
      blockedBy: "exploded" as never,
    },
  }), 2_000);
  telemetry.recordAction("racer-1", report({ kind: "note", text: "waiting for the referee", step: 5 }), 3_000);

  assert.deepEqual(telemetry.trace("racer-1"), [
    {
      step: 4,
      at: 1_000,
      kind: "action",
      text: "click primary-action",
      url: "https://course.test/shipping",
      targetRole: "primary-action",
      targetText: "Continue",
      decoy: true,
      blockedBy: "modal",
    },
    {
      step: 5,
      at: 2_000,
      kind: "error",
      text: "click pay (element is disabled)",
      url: "https://course.test/shipping",
      targetRole: "primary-action",
      targetText: null,
      decoy: false,
      blockedBy: null,
    },
    {
      step: 5,
      at: 3_000,
      kind: "note",
      text: "waiting for the referee",
      url: "https://course.test/shipping",
      targetRole: null,
      targetText: null,
      decoy: false,
      blockedBy: null,
    },
  ]);
  assert.deepEqual(telemetry.traceStats("racer-1"), { errors: 1, loops: 0 });

  for (let step = 1; step <= TRACE_LIMIT + 20; step += 1) {
    telemetry.recordAction("racer-2", report({ text: `step ${step}`, step }), step);
  }
  const trace = telemetry.trace("racer-2");
  assert.equal(trace.length, TRACE_LIMIT);
  assert.equal(trace[0].step, 21);
  assert.equal(trace.at(-1)?.step, TRACE_LIMIT + 20);
  trace[0].text = "mutated";
  assert.equal(telemetry.trace("racer-2")[0].text, "step 21");
  // The spectator log stays bounded separately.
  assert.equal(telemetry.racer("racer-2").log.length, 60);
});

test("counts loop episodes once per run of three or more identical steps", () => {
  const telemetry = new RaceTelemetry(racers, 3);
  ["a", "a", "a", "a", "b", "b", "b", "c", "a", "a"].forEach((signature, index) => {
    telemetry.recordAction("racer-1", report({ text: `step ${index}`, signature, step: index + 1 }), index);
  });
  assert.deepEqual(telemetry.traceStats("racer-1"), { errors: 0, loops: 2 });

  // The text is the default signature, notes do not break a run, and an
  // error with the same signature continues it.
  telemetry.recordAction("racer-2", report({ text: "scroll" }), 1);
  telemetry.recordAction("racer-2", report({ text: "scroll" }), 2);
  telemetry.recordAction("racer-2", report({ kind: "note", text: "thinking" }), 3);
  telemetry.recordAction("racer-2", report({ kind: "error", text: "scroll", error: "timeout" }), 4);
  assert.deepEqual(telemetry.traceStats("racer-2"), { errors: 1, loops: 1 });
});

test("keeps the latest frame before a hit and the first frame 1.5 s after it", () => {
  const telemetry = new RaceTelemetry(racers, 3);
  telemetry.recordFrame("racer-1", { contentType: "image/jpeg", body: Buffer.from("A"), capturedAt: 1_000 }, 1_000);
  const revision = telemetry.keyframeRevision;
  telemetry.captureHitKeyframes("racer-1", "plant-decoy-control", 2_000);
  assert.equal(telemetry.keyframeRevision, revision + 1);

  telemetry.recordFrame("racer-1", { contentType: "image/jpeg", body: Buffer.from("B"), capturedAt: 3_000 }, 3_000);
  telemetry.recordFrame("racer-1", { contentType: "image/png", body: Buffer.from("C"), capturedAt: 3_500 }, 3_500);
  telemetry.recordFrame("racer-1", { contentType: "image/jpeg", body: Buffer.from("D"), capturedAt: 9_000 }, 9_000);
  assert.equal(telemetry.keyframeRevision, revision + 2);
  assert.equal(String(telemetry.keyframe("racer-1", "plant-decoy-control-before")?.body), "A");
  assert.equal(String(telemetry.keyframe("racer-1", "plant-decoy-control-after")?.body), "C");
  assert.deepEqual(telemetry.keyframes("racer-1"), {
    "plant-decoy-control-before": { key: "plant-decoy-control-before", capturedAt: 1_000, contentType: "image/jpeg" },
    "plant-decoy-control-after": { key: "plant-decoy-control-after", capturedAt: 3_500, contentType: "image/png" },
  });

  // At most two bodies per hit, however often it is reported.
  telemetry.captureHitKeyframes("racer-1", "plant-decoy-control", 9_500);
  telemetry.recordFrame("racer-1", { contentType: "image/jpeg", body: Buffer.from("E"), capturedAt: 20_000 }, 20_000);
  assert.equal(Object.keys(telemetry.keyframes("racer-1")).length, 2);
  assert.equal(String(telemetry.keyframe("racer-1", "plant-decoy-control-after")?.body), "C");

  // A hit before any frame still gets its after frame.
  telemetry.captureHitKeyframes("racer-2", "legacy-step-1", 1_000);
  telemetry.recordFrame("racer-2", { contentType: "image/svg+xml", body: "<svg/>", capturedAt: 2_600 }, 2_600);
  assert.deepEqual(Object.keys(telemetry.keyframes("racer-2")), ["legacy-step-1-after"]);
  assert.equal(telemetry.keyframe("racer-3", "legacy-step-1-before"), null);
  assert.equal(telemetry.keyframe("racer-9", "anything"), null);
});
