import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  COMPETITOR_SYSTEM_PROMPT,
  COMPETITOR_TOOL_DESCRIPTION,
  COMPETITOR_TOOL_NAME,
  COMPETITOR_TOOL_SCHEMA,
} from "../src/agents/competitor-decision.js";
import type { DatasetMode, DatasetRows } from "../src/dataset/build.js";
import { buildDatasetRows, toJsonl } from "../src/dataset/build.js";
import type { DatasetStep } from "../src/api/dto.js";
import type { FightDatasetRecord } from "../src/dataset/types.js";
import {
  AGENTS,
  CURSOR,
  DAY,
  NOW,
  PAYMENT,
  PRODUCT,
  RACE_ID,
  REPAIR_R1,
  REPAIR_R2,
  SCREENSHOTS,
  T,
  TASK,
  TRACES,
  TRAP,
  TRAP_COVERED,
  TRAP_PAGE,
  click,
  goldenRecord,
  reaction,
  steelEvent,
  stepRecord,
  variant,
} from "./dataset-fixtures.js";

function build(
  records: FightDatasetRecord[] = [goldenRecord()],
  options: { now?: number; days?: number; mode?: DatasetMode } = {},
): DatasetRows {
  return buildDatasetRows(records, { now: NOW, days: 30, mode: "live", ...options });
}

function step(rows: DatasetRows, racerId: string, number: number, raceId = RACE_ID): DatasetStep {
  const found = rows.steps.find((candidate) => candidate.id === `${raceId}:${racerId}:${number}`);
  assert.ok(found, `${raceId}:${racerId}:${number}`);
  return found;
}

const ids = (racerId: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${RACE_ID}:${racerId}:${index + 1}`);

test("one row per executed step, racer order, oldest first; notes are not steps", () => {
  const rows = build();
  assert.deepEqual(rows.steps.map((row) => row.id), [
    ...ids("racer-1", 8),
    ...ids("racer-2", 4),
    ...ids("racer-3", 4),
    ...ids("racer-4", 2),
  ]);
  assert.ok(rows.steps.every((row) => row.schemaVersion === 1 && row.mode === "live"));
});

test("golden step: the decoy click inside the trap window", () => {
  const expected: DatasetStep = {
    schemaVersion: 1,
    id: "race-g:racer-1:2",
    raceId: RACE_ID,
    racerId: "racer-1",
    step: 2,
    mode: "live",
    agent: AGENTS[0],
    task: { text: TASK, courseId: "course-g", seed: "seed-g" },
    timing: {
      observedAt: T + 10_500, promptedAt: null, decidedAt: T + 10_800, actedAt: T + 11_000,
      rateLimitWaitMs: 0, modelLatencyMs: 300,
    },
    progress: { checkpoint: 1, checkpointCount: 3, nextCheckpointLabel: "Shipping" },
    observation: TRAP_PAGE,
    screenshot: SCREENSHOTS.r1s2,
    hazard: { stepId: TRAP, hazardType: "insert_decoy", tier: "basic", appliedAt: T + 10_000, clearedAt: T + 14_500 },
    action: click("Continue"),
    reasoning: "Continue looks like the next step.",
    decisionIssue: null,
    result: {
      ok: true,
      error: null,
      blockedBy: null,
      decoy: true,
      navigated: false,
      clearedSabotage: false,
      progressed: false,
      finished: false,
      target: { role: "primary-action", text: "Continue" },
      cursor: CURSOR,
    },
    steel: [steelEvent(10_800)],
    labels: { quality: "harmful", reaction: "deceived" },
  };
  assert.deepEqual(step(build(), "racer-1", 2), expected);

  const blind = step(build(), "racer-1", 4);
  assert.deepEqual(blind.timing, {
    observedAt: null, promptedAt: null, decidedAt: null, actedAt: T + 19_000, rateLimitWaitMs: 0, modelLatencyMs: null,
  });
  assert.deepEqual([blind.observation, blind.screenshot, blind.reasoning], [null, null, null]);
  const blocked = step(build(), "racer-1", 5);
  assert.deepEqual(
    [blocked.result.ok, blocked.result.error, blocked.result.blockedBy, blocked.result.target],
    [false, "locator.click: Timeout 2000ms exceeded", "timeout", null],
  );
});

test("a step is in a sabotage window from the hit until that racer's next recovery", () => {
  const rows = build();
  const window = (racerId: string, number: number) => step(rows, racerId, number).hazard;
  const racer1 = { stepId: TRAP, hazardType: "insert_decoy", tier: "basic", appliedAt: T + 10_000, clearedAt: T + 14_500 };
  assert.equal(window("racer-1", 1), null, "observed before the hit");
  assert.deepEqual(window("racer-1", 2), racer1);
  assert.deepEqual(window("racer-1", 3), racer1, "the step that cleared it was observed inside");
  assert.equal(window("racer-1", 4), null, "no observation time: acted after the recovery");
  assert.deepEqual(window("racer-2", 2), { ...racer1, appliedAt: T + 11_000, clearedAt: T + 13_000 });
  assert.equal(window("racer-2", 3), null);
  for (const number of [2, 3, 4]) {
    assert.deepEqual(window("racer-3", number), { ...racer1, appliedAt: T + 12_000, clearedAt: null }, "never cleared");
  }
  assert.ok(rows.steps.filter((row) => row.racerId === "racer-4").every((row) => row.hazard === null));

  // The window is [appliedAt, clearedAt): a step observed at the recovery is outside it.
  const edge = goldenRecord();
  edge.agents[1].steps[2].observedAt = T + 13_000;
  edge.agents[1].steps[1].observedAt = T + 11_000;
  const edgeRows = build([edge]);
  assert.equal(step(edgeRows, "racer-2", 3).hazard, null);
  assert.equal(step(edgeRows, "racer-2", 2).hazard?.appliedAt, T + 11_000);
});

test("progressed and finished: verified progress between this action and the next", () => {
  const rows = build();
  const flags = (racerId: string, number: number) => {
    const { progressed, finished } = step(rows, racerId, number).result;
    return [progressed, finished];
  };
  assert.deepEqual(flags("racer-1", 1), [true, false], "a checkpoint at the action's own time");
  assert.deepEqual(flags("racer-1", 2), [false, false]);
  assert.deepEqual(flags("racer-1", 3), [false, false], "checkpoint 2 came after the next action");
  assert.deepEqual(flags("racer-1", 4), [true, false]);
  assert.deepEqual(flags("racer-1", 7), [true, false]);
  assert.deepEqual(flags("racer-1", 8), [false, true], "the last step's window is open-ended");
  assert.deepEqual(flags("racer-2", 1), [true, false]);
  assert.deepEqual(flags("racer-3", 1), [true, false]);
  assert.deepEqual(flags("racer-2", 2), [false, false], "another racer's checkpoint never counts");

  const progress = (number: number) => step(rows, "racer-1", number).progress;
  assert.deepEqual(progress(1), { checkpoint: 0, checkpointCount: 3, nextCheckpointLabel: "Cart" });
  assert.deepEqual(progress(2), { checkpoint: 1, checkpointCount: 3, nextCheckpointLabel: "Shipping" });
  assert.deepEqual(progress(5), { checkpoint: 2, checkpointCount: 3, nextCheckpointLabel: "Payment" });
  assert.deepEqual(progress(7), { checkpoint: 2, checkpointCount: 3, nextCheckpointLabel: "Payment" });
  assert.deepEqual(progress(8), { checkpoint: 3, checkpointCount: 3, nextCheckpointLabel: null });
});

test("quality: harmful, then progress, then wasted, then neutral; reactions inside windows", () => {
  const rows = build();
  const labels = Object.fromEntries(rows.steps.map((row) => [row.id, row.labels]));
  const quality = (racerId: string) =>
    rows.steps.filter((row) => row.racerId === racerId).map((row) => row.labels.quality);
  assert.deepEqual(quality("racer-1"), [
    "progress", "harmful", "progress", "progress", "harmful", "neutral", "progress", "progress",
  ]);
  assert.deepEqual(quality("racer-2"), ["progress", "progress", "neutral", "wasted"]);
  assert.deepEqual(quality("racer-3"), ["progress", "harmful", "harmful", "neutral"], "harmful beats wasted");
  assert.deepEqual(quality("racer-4"), ["neutral", "harmful"]);

  assert.equal(labels["race-g:racer-1:2"].reaction, "deceived");
  assert.equal(labels["race-g:racer-1:3"].reaction, "deceived");
  assert.equal(labels["race-g:racer-2:2"].reaction, "recovered");
  assert.deepEqual(["race-g:racer-3:2", "race-g:racer-3:4"].map((id) => labels[id].reaction), ["stalled", "stalled"]);
  assert.equal(labels["race-g:racer-1:1"].reaction, null, "outside any window");
  assert.equal(labels["race-g:racer-4:2"].reaction, null);

  // A decoy click that also progressed is still harmful; clearing beats a repeat.
  const mixed = goldenRecord();
  mixed.events.push({
    id: "extra", raceId: RACE_ID, racerId: "racer-1", type: "checkpoint_reached", checkpoint: 2, occurredAt: T + 11_500,
  });
  mixed.agents[1].steps[3].evidence.clearedSabotage = true;
  const mixedRows = build([mixed]);
  const decoy = step(mixedRows, "racer-1", 2);
  assert.deepEqual([decoy.result.progressed, decoy.labels.quality], [true, "harmful"]);
  assert.equal(step(mixedRows, "racer-2", 4).labels.quality, "progress");
});

test("each step carries the Steel events from its decision up to the next decision", () => {
  const rows = build();
  const labelsOf = (number: number) => step(rows, "racer-1", number).steel.map((event) => event.label);
  assert.deepEqual(labelsOf(1), ["e8600"], "from its own decision; e7000 predates every decision");
  assert.deepEqual(labelsOf(2), ["e10800"], "the next decision starts the next slice");
  assert.deepEqual(labelsOf(3), ["e12400", "e18999"], "until the next step's acted time when it has no decision time");
  assert.deepEqual(labelsOf(4), ["e19000"], "from its acted time when it has no decision time");
  assert.deepEqual([labelsOf(5), labelsOf(6), labelsOf(7)], [[], [], []]);
  assert.deepEqual(labelsOf(8), ["e50000"], "the last slice is open-ended");
  assert.deepEqual(step(rows, "racer-1", 3).steel[0], steelEvent(12_400));
});

test("sft: good steps of won or finished runs, exactly as the runner prompted the model", () => {
  const rows = build();
  // Step 2 and 5 are harmful, step 4 has no observation, step 6 typed a redacted password.
  assert.deepEqual(rows.sft.map((example) => example.metadata.stepId), [
    "race-g:racer-1:1", "race-g:racer-1:3", "race-g:racer-1:7", "race-g:racer-1:8",
  ]);

  const repair = rows.sft[1];
  const runtimeObservation = {
    url: "https://shop.test/cart",
    title: "Cart",
    bodyText: "Cart\nBlue mug $12",
    controls: [
      { tag: "button", role: null, arenaRole: "primary-action", text: "Continue", disabled: false, visible: true },
      { tag: "button", role: null, arenaRole: "primary-action", text: "Checkout", disabled: false, visible: true },
    ],
  };
  const user = JSON.stringify({
    task: TASK,
    racerId: "racer-1",
    observation: runtimeObservation,
    history: [
      { decision: { type: "click", targetRole: "primary-action", label: "Add to cart" } },
      { decision: { type: "click", targetRole: "primary-action", label: "Continue" } },
    ],
  });
  const id = `call_${createHash("sha256").update("race-g:racer-1:3").digest("hex").slice(0, 24)}`;
  assert.deepEqual(repair, {
    messages: [
      { role: "system", content: COMPETITOR_SYSTEM_PROMPT },
      { role: "user", content: user },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id,
          type: "function",
          function: {
            name: COMPETITOR_TOOL_NAME,
            arguments: JSON.stringify({
              type: "evaluate",
              script: REPAIR_R1.script,
              reasoning: "The Continue button was a decoy; remove it.",
            }),
          },
        }],
      },
    ],
    metadata: {
      stepId: "race-g:racer-1:3",
      raceId: RACE_ID,
      agentKey: "gpt",
      model: "openai/gpt-5.2",
      quality: "progress",
      hazardType: "insert_decoy",
      mode: "live",
    },
  });
  assert.match(id, /^call_[0-9a-f]{24}$/);

  // History: the previous decisions with their errors, typed text as recorded, no dataset-only fields.
  const pay = rows.sft[2];
  const input = JSON.parse(pay.messages[1].content as string) as { history: unknown[]; observation: unknown };
  assert.deepEqual(input.history.map((entry) => JSON.stringify(entry)), [
    '{"decision":{"type":"click","targetRole":"primary-action","label":"Add to cart"}}',
    '{"decision":{"type":"click","targetRole":"primary-action","label":"Continue"}}',
    `{"decision":{"type":"evaluate","script":${JSON.stringify(REPAIR_R1.script)}}}`,
    '{"decision":{"type":"click","targetRole":"primary-action","label":"Checkout"}}',
    '{"decision":{"type":"click","targetRole":"primary-action","label":"Pay"},"error":"locator.click: Timeout 2000ms exceeded"}',
    '{"decision":{"type":"type","targetRole":"password","text":"[redacted]","label":"Password"}}',
  ]);
  assert.equal((input.observation as { bodyText: string }).bodyText, PAYMENT.text);
  const call = pay.messages[2];
  assert.ok(call.role === "assistant");
  assert.equal(call.tool_calls[0].function.arguments, '{"type":"click","targetRole":"primary-action","label":"Pay now"}', "no reasoning given");
  assert.equal(rows.sft[0].metadata.hazardType, null);
  assert.equal(JSON.parse(rows.sft[0].messages[1].content as string).history.length, 0);

  // A finished (not winning) run counts too; its wasted step does not.
  const finished = goldenRecord();
  finished.evaluation.agents[1] = { ...finished.evaluation.agents[1], outcome: "finished", success: true };
  assert.deepEqual(build([finished]).sft.map((example) => example.metadata.stepId).slice(4), [
    "race-g:racer-2:1", "race-g:racer-2:2", "race-g:racer-2:3",
  ]);
});

test("sft history holds the latest ten decisions", () => {
  const record = goldenRecord();
  record.agents[0].steps = Array.from({ length: 12 }, (_, index) => stepRecord(index + 1, T + 1_000 * (index + 1), {
    observedAt: T + 1_000 * (index + 1) - 500,
    observation: PRODUCT,
    action: click(`Option ${index + 1}`),
  }));
  record.events = [];
  const last = build([record]).sft.find((example) => example.metadata.stepId === "race-g:racer-1:12");
  assert.ok(last);
  const history = JSON.parse(last.messages[1].content as string).history as Array<{ decision: { label: string } }>;
  assert.deepEqual(history.map((entry) => entry.decision.label), Array.from({ length: 10 }, (_, index) => `Option ${index + 2}`));
});

test("sft history shows the model-facing error, never the call log or hidden decoy markup", () => {
  const record = goldenRecord();
  const raw = [
    "locator.click: Timeout 5000ms exceeded.",
    "Call log:",
    '  - <button id="arena-decoy-7" data-arena-decoy="true" data-arena-role="primary-action">Continue</button> intercepts pointer events',
  ].join("\n");
  record.agents[0].steps = [
    stepRecord(1, T + 1_000, {
      kind: "error", observedAt: T + 500, observation: PRODUCT, action: click("Add to cart"),
      error: raw, evidence: { blockedBy: "modal" },
    }),
    stepRecord(2, T + 2_000, { observedAt: T + 1_500, observation: PRODUCT, action: click("Checkout") }),
  ];
  record.events = [];
  const rows = build([record]);
  const example = rows.sft.find((candidate) => candidate.metadata.stepId === `${RACE_ID}:racer-1:2`);
  assert.ok(example);
  const history = JSON.parse(example.messages[1].content as string).history as Array<{ error?: string }>;
  assert.equal(history.length, 1);
  const shown = history[0].error;
  assert.ok(shown);
  assert.doesNotMatch(shown, /arena-decoy|data-arena|Call log/);
  // steps.jsonl keeps the raw browser text as a diagnostic.
  assert.match(step(rows, "racer-1", 1).result.error ?? "", /Call log/);
});

test("sft history uses the model-facing error the runner recorded, verbatim", () => {
  const record = goldenRecord();
  const shown = "Timeout 5000ms exceeded. Another element is covering the control.";
  record.agents[0].steps = [
    stepRecord(1, T + 1_000, {
      kind: "error", observedAt: T + 500, observation: PRODUCT, action: click("Add to cart"),
      error: "locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator", modelError: shown,
      evidence: { blockedBy: "modal" },
    }),
    stepRecord(2, T + 2_000, { observedAt: T + 1_500, observation: PRODUCT, action: click("Checkout") }),
  ];
  record.events = [];
  const example = build([record]).sft.find((candidate) => candidate.metadata.stepId === `${RACE_ID}:racer-1:2`);
  assert.ok(example);
  const history = JSON.parse(example.messages[1].content as string).history as Array<{ error?: string }>;
  assert.equal(history[0].error, shown);
});

test("sft history carries the runner's feedback on a step that worked, verbatim", () => {
  const record = goldenRecord();
  const feedback = "Inspect shows the same page you already have. Act on one of the listed controls.";
  record.agents[0].steps = [
    stepRecord(1, T + 1_000, { observedAt: T + 500, observation: PRODUCT, action: { type: "inspect" } }),
    stepRecord(2, T + 2_000, { observedAt: T + 1_500, observation: PRODUCT, action: { type: "inspect" } }),
    stepRecord(3, T + 3_000, {
      observedAt: T + 2_500, observation: PRODUCT, action: { type: "inspect" }, modelError: feedback,
    }),
    stepRecord(4, T + 4_000, { observedAt: T + 3_500, observation: PRODUCT, action: click("Add to cart") }),
  ];
  record.events = [];
  const rows = build([record]);
  // The feedback step is an ordinary action that wasted a turn.
  const nudged = step(rows, "racer-1", 3);
  assert.deepEqual([nudged.result.ok, nudged.result.error, nudged.labels.quality], [true, null, "wasted"]);
  const example = rows.sft.find((candidate) => candidate.metadata.stepId === `${RACE_ID}:racer-1:4`);
  assert.ok(example);
  assert.deepEqual(JSON.parse(example.messages[1].content as string).history, [
    { decision: { type: "inspect" } },
    { decision: { type: "inspect" } },
    { decision: { type: "inspect" }, error: feedback },
  ]);
});

test("preferences: self-correction and cross-agent pairs at the trap", () => {
  const rows = build();
  assert.deepEqual(rows.preferences.map((pair) => pair.id), [
    "self-correction:race-g:racer-1:2>race-g:racer-1:3",
    "cross-agent:race-g:racer-1:2>race-g:racer-2:2",
    "cross-agent:race-g:racer-3:2>race-g:racer-2:2",
  ]);
  assert.deepEqual(rows.preferences[0], {
    id: "self-correction:race-g:racer-1:2>race-g:racer-1:3",
    prompt: { task: TASK, observation: TRAP_PAGE, history: [click("Add to cart")] },
    chosen: REPAIR_R1,
    rejected: click("Continue"),
    metadata: {
      pairType: "self-correction",
      raceId: RACE_ID,
      sabotageStepId: TRAP,
      hazardType: "insert_decoy",
      checkpoint: 1,
      chosenStepId: "race-g:racer-1:3",
      rejectedStepId: "race-g:racer-1:2",
      chosenAgent: "gpt",
      rejectedAgent: "gpt",
      chosenResult: "cleared",
      rejectedResult: "decoy",
      mode: "live",
    },
  });
  // The prompt is the failing racer's view: its observation and its earlier actions.
  const blocked = rows.preferences[2];
  assert.deepEqual(blocked.prompt, { task: TASK, observation: TRAP_COVERED, history: [click("Add to cart")] });
  assert.deepEqual([blocked.chosen, blocked.rejected], [REPAIR_R2, click("Continue")]);
  assert.deepEqual(
    [blocked.metadata.chosenAgent, blocked.metadata.rejectedAgent, blocked.metadata.chosenResult, blocked.metadata.rejectedResult],
    ["claude", "gemini", "cleared", "modal"],
  );
  assert.equal(rows.preferences[1].metadata.rejectedResult, "decoy");

  // A step that progressed is "progressed"; an erroring step without a block is "error".
  const progressed = goldenRecord();
  progressed.events.push({
    id: "extra", raceId: RACE_ID, racerId: "racer-2", type: "checkpoint_reached", checkpoint: 2, occurredAt: T + 12_500,
  });
  progressed.agents[2].steps[1].evidence.blockedBy = null;
  const pairs = build([progressed]).preferences;
  assert.equal(pairs[1].metadata.chosenResult, "progressed");
  assert.equal(pairs[2].metadata.rejectedResult, "error");
});

test("identical preference pairs are kept once", () => {
  const record = goldenRecord();
  // Racer-3 now fails exactly as racer-1 did: same view, same history, same click.
  record.agents[2].steps[1].observation = TRAP_PAGE;
  record.agents[2].steps[1].evidence = { ...record.agents[1].steps[1].evidence, clearedSabotage: false, target: { role: "primary-action", text: "Continue", decoy: true } };
  assert.deepEqual(build([record]).preferences.map((pair) => pair.id), [
    "self-correction:race-g:racer-1:2>race-g:racer-1:3",
    "cross-agent:race-g:racer-1:2>race-g:racer-2:2",
  ]);
});

test("episodes: one per agent, with sabotage reactions but no evidence", () => {
  const record = goldenRecord();
  const rows = build([record]);
  assert.deepEqual(rows.episodes.map((episode) => episode.id), [1, 2, 3, 4].map((n) => `race-g:racer-${n}`));
  const { evidence: _evidence, ...hit } = reaction("deceived", 10_000);
  assert.deepEqual(rows.episodes[0], {
    schemaVersion: 1,
    id: "race-g:racer-1",
    raceId: RACE_ID,
    racerId: "racer-1",
    fightNumber: 7,
    mode: "live",
    title: "Golden fight",
    task: { text: TASK, courseId: "course-g", seed: "seed-g", checkpointLabels: ["Cart", "Shipping", "Payment"] },
    agent: AGENTS[0],
    startedAt: T,
    finishedAt: T + 40_000,
    outcome: "won",
    success: true,
    durationMs: 40_000,
    steps: 8,
    errors: 1,
    loops: 0,
    robustness: 55,
    sabotage: [hit],
    crowd: { openingYes: 0.25, beforeFirstHitYes: 0.3, afterFirstHitYes: 0.2, finalYes: 0.1 },
    stepIds: ids("racer-1", 8),
    steelTraceFile: TRACES.r1,
  });
  assert.deepEqual(rows.episodes.map((episode) => episode.steelTraceFile), [TRACES.r1, TRACES.r2, null, null]);
  assert.deepEqual(rows.episodes[3].stepIds, ids("racer-4", 2));
  assert.equal(record.evaluation.agents[0].sabotage[0].evidence.replayOffsetSec, 12, "the input keeps its evidence");
});

test("manifest: counts, files, the tool and the notes", () => {
  const rows = build();
  const { manifest } = rows;
  assert.deepEqual(
    [manifest.schemaVersion, manifest.name, manifest.generatedAt, manifest.filters],
    [1, "sabotage-markets", NOW, { days: 30, mode: "live" }],
  );
  assert.deepEqual(manifest.counts, {
    fights: 1, episodes: 4, steps: 18, sft: 4, preferences: 3, screenshots: 4, steelTraces: 2,
  });
  assert.deepEqual(manifest.byMode, { live: 1, simulated: 0 });
  assert.deepEqual(manifest.files.map((file) => [file.path, file.rows]), [
    ["episodes.jsonl", 4],
    ["steps.jsonl", 18],
    ["sft.jsonl", 4],
    ["preferences.jsonl", 3],
    ["assets/<raceId>/<racerId>/step-NNNN.<ext>", null],
    ["steel/<raceId>/<racerId>.trace.json", null],
  ]);
  assert.ok(manifest.files.every((file) => file.description.length > 0 && !file.description.includes("\n")));
  assert.deepEqual(manifest.tool, {
    name: COMPETITOR_TOOL_NAME,
    description: COMPETITOR_TOOL_DESCRIPTION,
    parameters: COMPETITOR_TOOL_SCHEMA,
  });
  assert.equal(manifest.systemPrompt, COMPETITOR_SYSTEM_PROMPT);
  const notes = manifest.notes.join("\n");
  assert.match(notes, /never the characters/);
  assert.match(notes, /\[redacted\]/);
  assert.match(notes, /scripted agents, not real models/);
  assert.match(notes, /Steel's clock/);
  assert.match(notes, /30 days before 2026-09-12T12:00:00\.000Z \(since 2026-08-13T12:00:00\.000Z\); mode: live/);
  assert.deepEqual(rows.files, [
    SCREENSHOTS.r1s1, SCREENSHOTS.r1s2, SCREENSHOTS.r1s3, SCREENSHOTS.r3s2, TRACES.r1, TRACES.r2,
  ]);
});

test("the window, the mode and the latest record per fight decide what is included", () => {
  const stale = goldenRecord();
  stale.title = "Stale copy";
  stale.evaluation.generatedAt = T + 10;
  const records = [
    goldenRecord(),
    variant("sim-1", NOW - 2 * DAY, "simulated"),
    variant("live-old", NOW - 40 * DAY, "live"),
    stale,
  ];
  const live = build(records);
  assert.deepEqual(live.episodes.map((episode) => episode.title), Array(4).fill("Golden fight"), "the latest evaluation wins");
  assert.equal(live.manifest.counts.fights, 1);

  const all = build(records, { mode: "all" });
  assert.deepEqual([...new Set(all.steps.map((row) => row.raceId))], ["sim-1", RACE_ID], "oldest fight first");
  assert.deepEqual(all.manifest.byMode, { live: 1, simulated: 1 });
  assert.match(all.manifest.notes.at(-1) ?? "", /mode: all\.$/);
  assert.ok(all.steps.filter((row) => row.raceId === "sim-1").every((row) => row.mode === "simulated"));

  assert.equal(build(records, { mode: "simulated" }).manifest.counts.fights, 1);
  assert.equal(build(records, { mode: "all", days: 365 }).manifest.counts.fights, 3);
  assert.equal(build(records, { mode: "all", days: 1 }).manifest.counts.fights, 0);
  const empty = build([]);
  assert.deepEqual([empty.steps, empty.episodes, empty.sft, empty.preferences, empty.files], [[], [], [], [], []]);
});

test("rows are deterministic and the input is never mutated", () => {
  const records = [goldenRecord(), variant("sim-1", NOW - 2 * DAY, "simulated")];
  const before = JSON.stringify(records);
  const first = build(records, { mode: "all" });
  assert.deepEqual(build(records, { mode: "all" }), first);
  assert.equal(JSON.stringify(records), before);
  // Rows never share objects with the records.
  first.steps[1].observation?.controls.push({ tag: "a", role: null, arenaRole: null, label: "x", visible: true, disabled: false });
  assert.equal(JSON.stringify(records), before);
});

test("toJsonl writes one line per row", () => {
  assert.equal(toJsonl([]), "");
  assert.equal(toJsonl([{ a: 1 }, { b: "x\ny" }]), '{"a":1}\n{"b":"x\\ny"}\n');
});

test("a malformed or substituted tool call is labelled, and is never an SFT target", () => {
  const record = goldenRecord();
  record.agents[0].steps = [
    // The model never gave a usable call, so the runner inspected instead.
    stepRecord(1, T + 1_000, {
      observedAt: T + 100, promptedAt: T + 400, decidedAt: T + 700, rateLimitWaitMs: 250,
      observation: PRODUCT, action: { type: "inspect" }, decisionIssue: { malformedAttempts: 2, fallback: true },
    }),
    // Valid on the retry: the model's own call, but not from the standard prompt.
    stepRecord(2, T + 2_000, {
      observedAt: T + 1_500, decidedAt: T + 1_800, observation: PRODUCT, action: click("Add to cart"),
      decisionIssue: { malformedAttempts: 1, fallback: false },
    }),
    stepRecord(3, T + 3_000, { observedAt: T + 2_500, decidedAt: T + 2_900, observation: PRODUCT, action: click("Checkout") }),
  ];
  record.events = [];
  const rows = build([record]);

  const substituted = step(rows, "racer-1", 1);
  assert.equal(substituted.labels.quality, "harmful");
  assert.deepEqual(substituted.decisionIssue, { malformedAttempts: 2, fallback: true });
  // Latency runs from the prompt, after the pause; without a prompt time, from the observation.
  assert.deepEqual(substituted.timing, {
    observedAt: T + 100, promptedAt: T + 400, decidedAt: T + 700, actedAt: T + 1_000, rateLimitWaitMs: 250, modelLatencyMs: 300,
  });
  const retried = step(rows, "racer-1", 2);
  assert.deepEqual([retried.labels.quality, retried.timing.modelLatencyMs], ["neutral", 300]);
  assert.equal(step(rows, "racer-1", 3).decisionIssue, null);

  const taught = rows.sft.map((example) => example.metadata.stepId);
  assert.ok(taught.includes(`${RACE_ID}:racer-1:3`), "a clean step is taught");
  assert.ok(!taught.includes(`${RACE_ID}:racer-1:1`) && !taught.includes(`${RACE_ID}:racer-1:2`));
});

test("preference pairs never use a step whose tool call had an issue", () => {
  const stepId = `${RACE_ID}:racer-1:2`;
  const pairsWith = (rows: ReturnType<typeof build>) => rows.preferences.filter((pair) =>
    pair.metadata.rejectedStepId === stepId || pair.metadata.chosenStepId === stepId);
  assert.ok(pairsWith(build()).length > 0, "the golden decoy click is in a pair");

  const record = goldenRecord();
  const decoyClick = record.agents[0].steps.find((candidate) => candidate.step === 2 && candidate.kind !== "note");
  assert.ok(decoyClick);
  decoyClick.decisionIssue = { malformedAttempts: 1, fallback: false };
  assert.deepEqual(pairsWith(build([record])), []);
});
