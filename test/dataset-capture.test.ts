import assert from "node:assert/strict";
import test from "node:test";
import { captureFightDataset, type FightCaptureInput } from "../src/dataset/capture.js";
import { AGENTS, PRODUCT, T, click, goldenEvaluation, goldenEvents, jpeg, stepRecord } from "./dataset-fixtures.js";

const RAW = [
  {
    timestamp: "2026-09-10T12:00:03.000Z",
    endTimestamp: "2026-09-10T12:00:03.250Z",
    type: "click",
    page: { url: "https://shop.test/cart" },
    target: {
      tagName: "BUTTON",
      role: "button",
      accessibleName: "Continue",
      attributes: { id: "arena-decoy-1" },
      selector: { css: "#arena-decoy-1", id: "arena-decoy-1" },
      boundingBox: { x: 600, y: 400, width: 120, height: 40 },
    },
    pointer: { x: 660, y: 420, button: 0, clickCount: 1 },
  },
  { type: "click" },
  { timestamp: "2026-09-10T12:00:01.000Z", type: "navigate", navigation: { url: "https://shop.test/" } },
];

function input(overrides: Partial<FightCaptureInput> = {}): FightCaptureInput {
  const steps = [
    stepRecord(1, T + 2_000, { observation: PRODUCT, action: click("Add to cart") }),
    stepRecord(2, T + 4_000, { action: click("Continue") }),
    stepRecord(2, T + 4_500, { kind: "note", text: "Step budget exhausted" }),
  ];
  return {
    raceId: "race 9",
    fightNumber: 9,
    title: "Capture fight",
    mode: "live",
    task: { text: "Buy the blue mug", courseId: "course-g", seed: "seed-g", checkpointLabels: ["Cart"], checkpointCount: 1 },
    startedAt: T,
    finishedAt: T + 40_000,
    evaluation: goldenEvaluation(),
    events: goldenEvents(),
    racers: [
      {
        racerId: "racer-1",
        agent: AGENTS[0],
        steps,
        frame: (step) => step === 1 ? { contentType: "image/jpeg", body: jpeg(1) } : null,
        steelRaw: RAW,
      },
      {
        racerId: "racer-2",
        agent: AGENTS[1],
        steps: [stepRecord(1, T + 3_000, { action: click("Add to cart") })],
        frame: () => ({ contentType: "image/svg+xml", body: "<svg>racer-2</svg>" }),
        steelRaw: null,
      },
      {
        racerId: "racer-3",
        agent: AGENTS[2],
        steps: [stepRecord(1, T + 3_000)],
        frame: () => {
          throw new Error("frame store failed");
        },
        steelRaw: [],
      },
    ],
    ...overrides,
  };
}

test("captures steps, step screenshots and the raw Steel trace as bundle files", () => {
  const source = input();
  const { record, files } = captureFightDataset(source);
  assert.deepEqual(
    [record.schemaVersion, record.raceId, record.fightNumber, record.title, record.mode, record.startedAt, record.finishedAt],
    [1, "race 9", 9, "Capture fight", "live", T, T + 40_000],
  );
  assert.deepEqual(record.task, source.task);
  assert.deepEqual(record.evaluation, goldenEvaluation());
  assert.deepEqual(record.events, goldenEvents());

  const [gpt, claude, gemini] = record.agents;
  assert.deepEqual(gpt.steps, source.racers[0].steps, "every record, notes included");
  assert.deepEqual(gpt.screenshots, { 1: "assets/race_9/racer-1/step-0001.jpg" }, "only steps with a screenshot");
  assert.equal(gpt.steelTraceFile, "steel/race_9/racer-1.trace.json");
  assert.deepEqual(claude.screenshots, { 1: "assets/race_9/racer-2/step-0001.svg" });
  assert.equal(claude.steelTraceFile, null, "no trace was read");
  assert.deepEqual([gemini.screenshots, gemini.steelTraceFile], [{}, "steel/race_9/racer-3.trace.json"]);

  assert.deepEqual(files.map((file) => [file.path, file.contentType]), [
    ["assets/race_9/racer-1/step-0001.jpg", "image/jpeg"],
    ["steel/race_9/racer-1.trace.json", "application/json"],
    ["assets/race_9/racer-2/step-0001.svg", "image/svg+xml"],
    ["steel/race_9/racer-3.trace.json", "application/json"],
  ]);
  assert.deepEqual(files[0].body, jpeg(1));
  assert.equal(files[1].body, JSON.stringify(RAW), "the raw trace, unmodified");
  assert.equal(files[3].body, "[]");

  // The record holds copies.
  source.racers[0].steps[0].text = "changed";
  source.evaluation.title = "changed";
  assert.equal(gpt.steps[0].text, "step 1");
  assert.equal(record.evaluation.title, "Golden fight");
});

test("normalises the Steel events in time order, dropping malformed ones", () => {
  const { record } = captureFightDataset(input());
  const events = record.agents[0].steelEvents;
  assert.deepEqual(events.map((event) => event.type), ["navigate", "click"]);
  const clickEvent = events[1];
  assert.equal(clickEvent.at, Date.parse("2026-09-10T12:00:03.000Z"));
  assert.equal(clickEvent.endAt, Date.parse("2026-09-10T12:00:03.250Z"));
  assert.equal(clickEvent.label, "Continue");
  assert.equal(clickEvent.decoy, true);
  assert.deepEqual(clickEvent.bbox, [600, 400, 120, 40]);
  assert.deepEqual(record.agents[1].steelEvents, []);
});

test("a raw trace that cannot be serialised is left out rather than failing the capture", () => {
  const { record, files } = captureFightDataset(input({
    racers: [{
      racerId: "racer-1",
      agent: AGENTS[0],
      steps: [],
      frame: () => null,
      steelRaw: [{ timestamp: "2026-09-10T12:00:03.000Z", type: "click", size: 10n }],
    }],
  }));
  assert.equal(record.agents[0].steelTraceFile, null);
  assert.deepEqual(files, []);
});
