import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import {
  classifyBlockedBy,
  modelFacingErrorText,
  PlaywrightCompetitorRunner,
  validateEvaluateScript,
  type AgentDecision,
  type CompetitorDecisionModel,
  type PlaywrightCompetitorRunnerOptions,
} from "../src/agents/playwright-competitor-runner.js";
import type {
  AgentActionReport,
  CapturedFrame,
  CompetitorContext,
} from "../src/application/contracts.js";
import type { DecisionIssue } from "../src/api/dto.js";

test("bounds same-page recovery scripts and rejects privileged capabilities", () => {
  assert.equal(
    validateEvaluateScript("window.__arenaRecoverDisruptions?.()"),
    "window.__arenaRecoverDisruptions?.()",
  );
  assert.throws(() => validateEvaluateScript("fetch('https://example.com')"), /forbidden capability/);
  assert.throws(() => validateEvaluateScript("document.forms[0].requestSubmit()"), /forbidden capability/);
  assert.throws(() => validateEvaluateScript("document.querySelector('button')['click']()"), /forbidden capability/);
  assert.throws(() => validateEvaluateScript("x".repeat(2_001)), /cannot exceed/);
  assert.throws(() => validateEvaluateScript("(() => {"), /invalid JavaScript syntax/);
});

type FakeElement = { role: string; text: string; decoy?: boolean; type?: string };
type FakeAction = {
  kind: "click" | "fill";
  selector: string;
  hasText?: string;
  value?: string;
  options?: { timeout?: number };
};

class FakeLocator {
  constructor(
    protected readonly owner: FakePage,
    readonly selector: string,
    readonly hasText?: string,
  ) {}
  first() { return this; }
  filter(options: { hasText?: string }) {
    return this.owner.locatorFor(this.selector, options.hasText);
  }
  private matches(): FakeElement[] {
    const role = /data-arena-role="([^"]*)"/.exec(this.selector)?.[1];
    if (role === undefined) return [];
    const elements = this.owner.elements ?? [{ role, text: role }];
    const needle = this.hasText?.toLowerCase();
    return elements.filter((element) =>
      element.role === role &&
      (needle === undefined || element.text.toLowerCase().includes(needle)));
  }
  async count() { return this.matches().length; }
  async evaluate() {
    if (this.owner.evidenceError) throw this.owner.evidenceError;
    const element = this.matches()[0];
    if (!element) throw new Error("element is detached");
    return { role: element.role, text: element.text, decoy: element.decoy === true, type: element.type ?? "" };
  }
  async innerText() { return this.owner.bodyText ?? "Demo course"; }
  async evaluateAll() { return this.owner.controls ?? []; }
  async click(options?: { timeout?: number }) {
    this.owner.actions.push({ kind: "click", selector: this.selector, hasText: this.hasText, options });
    if (this.owner.clickError) throw this.owner.clickError;
    this.owner.onClick?.();
  }
  async fill(value: string, options?: { timeout?: number }) {
    this.owner.actions.push({
      kind: "fill",
      selector: this.selector,
      hasText: this.hasText,
      value,
      options,
    });
    const failure = this.owner.fillErrors.shift();
    if (failure) throw failure;
    this.owner.onFill?.(value);
  }
}

class FakePage {
  currentUrl = "https://course.test/";
  navigations: string[] = [];
  activeDisruption = false;
  /** Controls on the page. Undefined: every role matches one control. */
  elements?: FakeElement[];
  actions: FakeAction[] = [];
  clickError?: Error;
  evidenceError?: Error;
  onClick?: () => void;
  /** Thrown by the next fills, in order. */
  fillErrors: Error[] = [];
  onFill?: (value: string) => void;
  /** The body's visible text. Default "Demo course". */
  bodyText?: string;
  /** What the observation's control scan returns. Default: nothing. */
  controls?: Array<Record<string, unknown>>;
  locatorFor(selector: string, hasText?: string) { return new FakeLocator(this, selector, hasText); }
  locator(selector: string) { return this.locatorFor(selector); }
  url() { return this.currentUrl; }
  async title() { return "Course"; }
  async goto(url: string) {
    this.currentUrl = url;
    this.navigations.push(url);
    return null;
  }
  async evaluate<T>(_pageFunction: unknown, argument?: unknown): Promise<T> {
    if (typeof argument === "string") {
      if (argument.includes("__arenaRecoverDisruptions")) this.activeDisruption = false;
      return 1 as T;
    }
    return this.activeDisruption as T;
  }
  async waitForTimeout() {}
}

class CursorLocator extends FakeLocator {
  async boundingBox() {
    return { x: 20, y: 30, width: 100, height: 40 };
  }
}

class CursorPage extends FakePage {
  moves: Array<{ x: number; y: number; steps?: number }> = [];
  mouse = {
    move: async (x: number, y: number, options?: { steps?: number }) => {
      this.moves.push({ x, y, steps: options?.steps });
    },
  };

  override locatorFor(selector: string, hasText?: string) {
    return new CursorLocator(this, selector, hasText);
  }

  viewportSize() {
    return { width: 800, height: 600 };
  }
}

type DecisionInput = Parameters<CompetitorDecisionModel["decide"]>[0];

test("evaluate recovery clears an active disruption and reports manual recovery", async () => {
  const page = new FakePage();
  page.activeDisruption = true;
  const model = new SequenceModel([
    { type: "evaluate", script: "window.__arenaRecoverDisruptions?.()" },
    { type: "finish" },
  ]);
  const runner = new PlaywrightCompetitorRunner({
    task: "Complete the course",
    startUrl: "https://course.test/start",
    model,
  });
  let recoveries = 0;
  let finished = false;
  const reports: AgentActionReport[] = [];
  const context = {
    raceId: "race-1",
    racerId: "racer-1",
    courseId: "course-1",
    seed: "seed-1",
    checkpointCount: 1,
    session: { racerId: "racer-1", steelSessionId: "steel-1", page } as unknown as CompetitorContext["session"],
    async reportCheckpoint() {},
    async reportFinish() { finished = true; },
    async reportRecovery() { recoveries += 1; },
    reportAction(report: AgentActionReport) { reports.push(report); },
  } satisfies CompetitorContext;
  await runner.prepare(context);
  await runner.run(context);
  assert.equal(recoveries, 1);
  assert.equal(finished, true);
  // The step that cleared the sabotage says so, with the agent's own script.
  assert.equal(reports[0].evidence?.clearedSabotage, true);
  assert.deepEqual(reports[0].action, { type: "evaluate", script: "window.__arenaRecoverDisruptions?.()" });
  assert.equal(reports[1].evidence?.clearedSabotage, undefined);
});

class SequenceModel implements CompetitorDecisionModel {
  readonly inputs: DecisionInput[] = [];
  constructor(private readonly decisions: AgentDecision[]) {}
  async decide(input: DecisionInput): Promise<AgentDecision> {
    this.inputs.push(structuredClone(input));
    const decision = this.decisions.shift();
    if (!decision) throw new Error("No decision configured");
    return decision;
  }
}

test("prepares a seeded racer URL and reports verified progress", async () => {
  const page = new FakePage();
  const model = new SequenceModel([
    { type: "checkpoint", checkpoint: 1 },
    { type: "finish" },
  ]);
  const runner = new PlaywrightCompetitorRunner({
    task: "Complete the course",
    startUrl: "https://course.test/start",
    model,
  });
  const checkpoints: number[] = [];
  const states: Array<{ step: number; candidateMilestone?: string }> = [];
  let finished = false;
  const base = {
    raceId: "race-1",
    racerId: "racer-1",
    courseId: "course-1",
    seed: "seed-1",
    checkpointCount: 3,
    session: {
      racerId: "racer-1",
      steelSessionId: "steel-1",
      page: page as unknown as Page,
    },
    reportState(observation: { step: number; candidateMilestone?: string }) {
      states.push({
        step: observation.step,
        ...(observation.candidateMilestone === undefined
          ? {}
          : { candidateMilestone: observation.candidateMilestone }),
      });
    },
  };

  await runner.prepare(base);
  await runner.run({
    ...base,
    async reportCheckpoint(checkpoint) { checkpoints.push(checkpoint); },
    async reportFinish() { finished = true; },
  });

  assert.deepEqual(checkpoints, [1]);
  assert.equal(finished, true);
  assert.match(page.navigations[0], /raceId=race-1/);
  assert.match(page.navigations[0], /racerId=racer-1/);
  assert.match(page.navigations[0], /seed=seed-1/);
  assert.deepEqual(states.map((state) => state.step), [0, 1, 2]);
  assert.equal(states[1]?.candidateMilestone, "checkpoint:1");
  assert.equal(states[2]?.candidateMilestone, "finish");
});

test("stops immediately when the verifier proves completion after an action", async () => {
  const page = new FakePage();
  const runner = new PlaywrightCompetitorRunner({
    task: "Complete the course",
    startUrl: "https://course.test/start",
    model: new SequenceModel([{ type: "click", targetRole: "primary-action" }]),
  });
  const base = contextFor(page);
  let checks = 0;
  let explicitFinish = false;
  await runner.prepare(base);
  await runner.run({
    ...base,
    async reportCheckpoint() {},
    async reportFinish() { explicitFinish = true; },
    async checkFinish() {
      checks += 1;
      return true;
    },
  });
  assert.equal(checks, 1);
  assert.equal(explicitFinish, false);
});

test("reviews live progress after an action without a checkpoint decision", async () => {
  const page = new FakePage();
  const runner = new PlaywrightCompetitorRunner({
    task: "Complete the course",
    startUrl: "https://course.test/start",
    model: new SequenceModel([{ type: "click", targetRole: "primary-action" }]),
  });
  const base = contextFor(page);
  const reviews: number[] = [];
  await runner.prepare(base);
  await runner.run({
    ...base,
    async reportCheckpoint() {},
    async reportFinish() {},
    async reviewProgress(observation) {
      reviews.push(observation.step);
      return true;
    },
  });
  assert.deepEqual(reviews, [1]);
});

test("resolves a distinct model for each racer", async () => {
  const page = new FakePage();
  const selected: string[] = [];
  const runner = new PlaywrightCompetitorRunner({
    task: "Complete the course",
    startUrl: "https://course.test/start",
    modelForRacer(racerId) {
      selected.push(racerId);
      return new SequenceModel([{ type: "finish" }]);
    },
  });
  const base = {
    raceId: "race-1",
    racerId: "racer-3",
    courseId: "course-1",
    seed: "seed-1",
    checkpointCount: 3,
    session: {
      racerId: "racer-3",
      steelSessionId: "steel-3",
      page: page as unknown as Page,
    },
  };

  await runner.prepare(base);
  await runner.run({
    ...base,
    async reportCheckpoint() {},
    async reportFinish() {},
  });

  assert.deepEqual(selected, ["racer-3"]);
  assert.match(page.navigations[0], /courseId=course-1/);
  assert.match(page.navigations[0], /checkpointCount=3/);
});

class ScreenshotPage extends FakePage {
  shots: Array<Record<string, unknown>> = [];
  active = 0;
  maxActive = 0;
  shotDelayMs = 0;
  failClicksOn = new Set<string>();

  override locator(selector: string) {
    const locator = super.locator(selector);
    const failing = [...this.failClicksOn].some((role) => selector.includes(role));
    if (failing) {
      locator.click = async () => { throw new Error(`${selector} is covered`); };
    }
    return locator;
  }

  async screenshot(options: Record<string, unknown>) {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.shotDelayMs > 0) await delay(this.shotDelayMs);
      this.shots.push(options);
      return Buffer.from(`jpeg-${this.shots.length}`);
    } finally {
      this.active -= 1;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contextFor(page: FakePage, racerId = "racer-1") {
  return {
    raceId: "race-1",
    racerId,
    courseId: "course-1",
    seed: "seed-1",
    checkpointCount: 3,
    session: { racerId, steelSessionId: `steel-${racerId}`, page: page as unknown as Page },
  };
}

/** Prepares and runs one racer on `page` with scripted decisions. */
async function runWith(
  page: FakePage,
  decisions: AgentDecision[],
  extra: Partial<CompetitorContext> = {},
  options: Partial<PlaywrightCompetitorRunnerOptions> = {},
) {
  const model = new SequenceModel(decisions);
  const runner = new PlaywrightCompetitorRunner({
    task: "Complete the course",
    startUrl: "https://course.test/start",
    model,
    ...options,
  });
  const reports: AgentActionReport[] = [];
  const base = contextFor(page);
  await runner.prepare(base);
  await runner.run({
    ...base,
    async reportCheckpoint() {},
    async reportFinish() {},
    reportAction(report) { reports.push(report); },
    ...extra,
  });
  return { reports, model };
}

test("moves the browser cursor to a target and reports its position", async () => {
  const page = new CursorPage();
  const { reports } = await runWith(page, [
    { type: "click", targetRole: "primary-action" },
    { type: "finish" },
  ]);

  assert.ok(page.moves.length > 1, "the cursor should move through intermediate points");
  assert.ok(page.moves.some((move) => move.x > 24 && move.x < 70));
  assert.deepEqual(page.moves.at(-1), { x: 70, y: 50, steps: undefined });
  assert.deepEqual(reports[0].evidence?.cursor, {
    x: 70,
    y: 50,
    viewportWidth: 800,
    viewportHeight: 600,
    action: "click",
  });
});

test("restores the native cursor at its last target after navigation", async () => {
  const page = new CursorPage();
  await runWith(page, [
    { type: "click", targetRole: "primary-action" },
    { type: "navigate", url: "https://course.test/next" },
    { type: "finish" },
  ]);

  const targetMoves = page.moves.filter((move) => move.x === 70 && move.y === 50);
  assert.ok(targetMoves.length >= 2, "navigation should restore the last cursor position");
});

test("uses the master completion judge when course finish proof is unavailable", async () => {
  const page = new FakePage();
  const sources: Array<string | undefined> = [];
  const { reports } = await runWith(page, [{ type: "finish" }], {
    reportFinish: async (source) => {
      sources.push(source);
      return source === "master";
    },
    completionJudge: {
      async judgeCheckpoint() {
        return false;
      },
      async judgeCompletion(input) {
        assert.match(input.observation.bodyText, /Demo course/);
        return true;
      },
    },
  });

  assert.deepEqual(sources, [undefined, "master"]);
  assert.equal(reports[0]?.kind, "action");
  assert.equal(reports[0]?.text, "Reported finish");
});

test("uses the master completion judge when checkpoint proof is unavailable", async () => {
  const page = new FakePage();
  const sources: Array<string | undefined> = [];
  await runWith(page, [{ type: "checkpoint", checkpoint: 1 }, { type: "finish" }], {
    reportCheckpoint: async (_checkpoint, source) => {
      sources.push(source);
      return source === "master";
    },
    completionJudge: {
      async judgeCheckpoint(input) {
        assert.equal(input.checkpoint, 1);
        return true;
      },
      async judgeCompletion() {
        return true;
      },
    },
  });

  assert.deepEqual(sources, [undefined, "master"]);
});

function timeoutError(callLog: string, action = "locator.click"): Error {
  return Object.assign(
    new Error(`${action}: Timeout 5000ms exceeded.\nCall log:\n${callLog}`),
    { name: "TimeoutError" },
  );
}

const RESOLVED_LOG = [
  `  - waiting for locator('[data-arena-role="primary-action"]').first()`,
  `    - locator resolved to <button data-arena-role="primary-action">Go</button>`,
  "  - attempting click action",
  "    - waiting for element to be visible, enabled and stable",
].join("\n");

test("reports every decision and captures a JPEG after each action", async () => {
  const page = new ScreenshotPage();
  page.failClicksOn.add("missing");
  const runner = new PlaywrightCompetitorRunner({
    task: "Complete the course",
    startUrl: "https://course.test/start",
    modelForRacer: (racerId) => {
      assert.equal(racerId, "racer-2");
      return new SequenceModel([
        { type: "click", targetRole: "add-to-cart" },
        { type: "click", targetRole: "missing" },
        { type: "finish" },
      ]);
    },
    maxActions: 10,
    frameIntervalMs: 60_000,
  });
  const reports: AgentActionReport[] = [];
  const frames: CapturedFrame[] = [];
  const base = contextFor(page, "racer-2");
  await runner.prepare(base);
  await runner.run({
    ...base,
    async reportCheckpoint() {},
    async reportFinish() {},
    reportAction(report) { reports.push(report); },
    reportFrame(frame) { frames.push(frame); },
  });

  assert.deepEqual(
    reports.map((report) => [report.kind, report.text, report.step, report.maxSteps]),
    [
      ["action", 'Clicked "add-to-cart"', 1, 10],
      ["error", 'Clicked "missing"', 2, 10],
      ["action", "Reported finish", 3, 10],
    ],
  );
  assert.equal(reports[0].url, page.currentUrl);
  assert.equal(reports[0].signature, JSON.stringify({ type: "click", targetRole: "add-to-cart" }));
  assert.equal(reports[0].error, undefined);
  assert.match(reports[1].error ?? "", /is covered/);

  // Each step's observation screenshot, tagged with its step, plus one
  // capture after each non-final action.
  assert.deepEqual(frames.map((frame) => frame.step), [1, undefined, 2, undefined, 3]);
  assert.ok(frames.every((frame) => frame.contentType === "image/jpeg" && Buffer.isBuffer(frame.body)));
  assert.ok(frames.every((frame) => typeof frame.capturedAt === "number"));
  assert.deepEqual(page.shots[0], { type: "jpeg", quality: 55, fullPage: false });
});

test("resolves a control by label among controls sharing a role and reports what it hit", async () => {
  const page = new FakePage();
  page.elements = [
    { role: "primary-action", text: "Continue", decoy: true },
    { role: "primary-action", text: "Complete checkpoint 2" },
    { role: "search", text: "Search products" },
  ];
  const { reports } = await runWith(page, [
    { type: "click", targetRole: "primary-action" },
    { type: "click", targetRole: "primary-action", label: "complete CHECKPOINT" },
    { type: "type", targetRole: "search", text: "monitor", label: "Search products" },
    { type: "finish" },
  ]);

  assert.deepEqual(
    page.actions.map((action) => [action.kind, action.hasText, action.options]),
    [
      ["click", undefined, { timeout: 5_000 }],
      ["click", "complete CHECKPOINT", { timeout: 5_000 }],
      ["fill", "Search products", { timeout: 5_000 }],
    ],
  );
  assert.deepEqual(reports[0].evidence, {
    target: { role: "primary-action", text: "Continue", decoy: true },
    navigated: false,
  });
  assert.deepEqual(reports[1].evidence?.target, {
    role: "primary-action",
    text: "Complete checkpoint 2",
    decoy: false,
  });
  assert.equal(reports[1].text, 'Clicked "complete CHECKPOINT" (primary-action)');
  assert.deepEqual(reports[2].evidence?.target, {
    role: "search",
    text: "Search products",
    decoy: false,
  });
  assert.equal(reports[3].evidence?.target, undefined);
});

test("fails fast with blockedBy missing when no control matches", async () => {
  const page = new FakePage();
  page.elements = [{ role: "primary-action", text: "Pay now" }];
  const { reports, model } = await runWith(page, [
    { type: "click", targetRole: "primary-action", label: "Cancel order" },
    { type: "type", targetRole: "checkout-submit", text: "x" },
    { type: "finish" },
  ]);

  assert.equal(page.actions.length, 0, "no click or fill was attempted");
  assert.deepEqual(
    reports.slice(0, 2).map((report) => [report.kind, report.evidence?.blockedBy, report.evidence?.target]),
    [["error", "missing", undefined], ["error", "missing", undefined]],
  );
  const expected = 'No control with data-arena-role "primary-action" shows the label "Cancel order"';
  assert.equal(reports[0].error, expected);
  assert.equal(model.inputs[1].history.at(-1)?.error, expected);
  assert.equal(reports[0].modelError, expected);
  assert.equal(modelFacingErrorText(reports[0].error ?? "", "missing"), expected);
  assert.match(reports[1].error ?? "", /No control has data-arena-role "checkout-submit"/);
});

test("classifies browser errors into blockedBy", () => {
  assert.equal(
    classifyBlockedBy(timeoutError(`${RESOLVED_LOG}\n      - <div role="dialog">…</div> intercepts pointer events`)),
    "modal",
  );
  assert.equal(classifyBlockedBy(timeoutError(`${RESOLVED_LOG}\n      - element is not enabled`)), "disabled");
  assert.equal(
    classifyBlockedBy(timeoutError(`${RESOLVED_LOG}\n      - element is not editable`, "locator.fill")),
    "disabled",
  );
  assert.equal(classifyBlockedBy(timeoutError(`${RESOLVED_LOG}\n      - element is not visible`)), "hidden");
  assert.equal(
    classifyBlockedBy(timeoutError(`  - waiting for locator('[data-arena-role="gone"]').first()`)),
    "missing",
  );
  assert.equal(classifyBlockedBy(timeoutError(`${RESOLVED_LOG}\n      - element is not stable`)), "timeout");
  assert.equal(
    classifyBlockedBy(Object.assign(
      new Error('page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "https://course.test/"'),
      { name: "TimeoutError" },
    )),
    "timeout",
  );
  // The call log is chronological: the latest reason wins.
  assert.equal(
    classifyBlockedBy(timeoutError(
      `${RESOLVED_LOG}\n      - element is not visible\n      - <div>…</div> intercepts pointer events`,
    )),
    "modal",
  );
  assert.equal(
    classifyBlockedBy(new Error("locator.fill: Error: Element is not an <input>, <textarea> or <select>")),
    undefined,
  );
  assert.equal(classifyBlockedBy(new Error("Checkpoint 2 was not verified for racer-1")), undefined);
});

test("reports blockedBy but keeps the call log and hidden markup away from the model", async () => {
  const page = new FakePage();
  page.clickError = timeoutError([
    `  - waiting for locator('[data-arena-role="primary-action"]').first()`,
    `    - locator resolved to <button id="arena-decoy-race-1" data-arena-decoy="true" data-arena-role="primary-action">Continue</button>`,
    "  - attempting click action",
    `      - <div data-arena-disruption-id="disruption-1" role="dialog">…</div> intercepts pointer events`,
  ].join("\n"));
  const { reports, model } = await runWith(page, [
    { type: "click", targetRole: "primary-action" },
    { type: "finish" },
  ]);

  assert.equal(reports[0].kind, "error");
  assert.equal(reports[0].evidence?.blockedBy, "modal");
  // Telemetry keeps the full browser error.
  assert.match(reports[0].error ?? "", /intercepts pointer events/);
  assert.equal(
    model.inputs[1].history[0].error,
    "locator.click: Timeout 5000ms exceeded. Another element is covering the control.",
  );
  // The report keeps both: the full error for diagnostics, and exactly what the model was told.
  assert.equal(reports[0].modelError, model.inputs[1].history[0].error);
  assert.equal(reports[1].modelError, undefined);
  // The raw error rebuilds the same text, for records without modelError.
  assert.equal(
    modelFacingErrorText(reports[0].error ?? "", reports[0].evidence?.blockedBy ?? null),
    reports[0].modelError,
  );
  assert.doesNotMatch(JSON.stringify(model.inputs), /decoy|disruption|Call log/i);
});

test("reports whether each action navigated", async () => {
  const page = new FakePage();
  page.onClick = () => { page.currentUrl = "https://course.test/next"; };
  const { reports } = await runWith(page, [
    { type: "inspect" },
    { type: "navigate", url: "/cart" },
    { type: "click", targetRole: "primary-action" },
    { type: "finish" },
  ]);

  assert.deepEqual(reports.map((report) => report.evidence?.navigated), [false, true, true, false]);
  assert.equal(reports[2].url, "https://course.test/next");
  assert.match(page.navigations[1] ?? "", /\/cart\?raceId=race-1/);
  assert.match(page.navigations[1] ?? "", /racerId=racer-1/);
});

test("syncs progress after every action, success or error, before checking completion", async () => {
  const events: string[] = [];
  let checks = 0;
  const page = new FakePage();
  page.elements = [{ role: "primary-action", text: "Go" }];
  await runWith(page, [
    { type: "click", targetRole: "primary-action" },
    { type: "click", targetRole: "missing-role" },
    { type: "checkpoint", checkpoint: 1 },
    { type: "click", targetRole: "primary-action" },
  ], {
    reportAction(report) { events.push(`report:${report.step}:${report.kind}`); },
    async reportCheckpoint(checkpoint) { events.push(`checkpoint:${checkpoint}`); },
    async syncProgress() { events.push("sync"); },
    async checkFinish() {
      checks += 1;
      events.push("check");
      return checks === 4;
    },
  });
  assert.deepEqual(events, [
    "report:1:action", "sync", "check",
    "report:2:error", "sync", "check",
    "checkpoint:1", "report:3:action", "sync", "check",
    "report:4:action", "sync", "check",
  ]);

  // An explicit finish still syncs, then ends the run without a completion check.
  events.length = 0;
  await runWith(new FakePage(), [{ type: "finish" }], {
    reportAction(report) { events.push(`report:${report.step}:${report.kind}`); },
    async reportFinish() { events.push("finish"); },
    async syncProgress() { events.push("sync"); },
    async checkFinish() { events.push("check"); return false; },
  });
  assert.deepEqual(events, ["finish", "report:1:action", "sync"]);

  // A failing sync never ends the run.
  const { reports } = await runWith(new FakePage(), [{ type: "inspect" }, { type: "finish" }], {
    async syncProgress() { throw new Error("verifier unavailable"); },
  });
  assert.deepEqual(reports.map((report) => report.kind), ["action", "action"]);
});

test("rejects waiting during sabotage and reports recovery after DOM cleanup", async () => {
  const page = new FakePage();
  page.activeDisruption = true;
  const recovery: string[] = [];
  const { reports } = await runWith(
    page,
    [
      { type: "wait", durationMs: 100 },
      { type: "evaluate", script: "window.__arenaRecoverDisruptions?.()" },
      { type: "finish" },
    ],
    {
      async reportRecovery() { recovery.push("recovered"); },
    },
  );

  assert.equal(reports[0].kind, "error");
  assert.match(reports[0].error ?? "", /Waiting cannot clear/);
  assert.equal(reports[1].kind, "action");
  assert.deepEqual(recovery, ["recovered"]);
});

test("reports a visible note when a provider pauses for rate-limit capacity", async () => {
  const reports: AgentActionReport[] = [];
  const model: CompetitorDecisionModel = {
    async prepareForCall() {
      return { waitedMs: 1_500, maxCalls: 20, windowMs: 60_000 };
    },
    async decide() {
      return { type: "finish" };
    },
  };
  await runWith(new FakePage(), [{ type: "finish" }], {
    reportAction(report) { reports.push(report); },
  }, { model });

  assert.equal(reports[0].kind, "note");
  assert.match(reports[0].text, /Rate limit pause complete/);
  assert.equal(reports[1].kind, "action");
});

test("retries provider decision failures without consuming a browser action", async () => {
  const page = new FakePage();
  let calls = 0;
  const reports: AgentActionReport[] = [];
  const runner = new PlaywrightCompetitorRunner({
    task: "Complete the course",
    startUrl: "https://course.test/start",
    model: {
      async decide() {
        calls += 1;
        if (calls === 1) throw new Error("provider returned malformed tool output");
        return { type: "finish" };
      },
    },
  });
  const base = contextFor(page);
  await runner.prepare(base);
  await runner.run({
    ...base,
    async reportCheckpoint() {},
    async reportFinish() {},
    reportAction(report) { reports.push(report); },
  });

  assert.equal(calls, 2);
  assert.equal(reports[0]?.kind, "note");
  assert.match(reports[0]?.text ?? "", /no browser action used/);
  assert.equal(reports[1]?.kind, "action");
  assert.equal(reports[1]?.step, 1);
});

test("caps intermittent protocol failures instead of looping forever", async () => {
  const page = new FakePage();
  let calls = 0;
  const reports: AgentActionReport[] = [];
  const runner = new PlaywrightCompetitorRunner({
    task: "Complete the course",
    startUrl: "https://course.test/start",
    model: {
      async decide() {
        calls += 1;
        if (calls % 3 === 0) return { type: "inspect" };
        throw new Error("invalid tool arguments");
      },
    },
  });
  const base = contextFor(page);
  await runner.prepare(base);
  await assert.rejects(
    runner.run({
      ...base,
      async reportCheckpoint() {},
      async reportFinish() {},
      reportAction(report) { reports.push(report); },
    }),
    /after 6 provider\/protocol retries/,
  );
  assert.equal(reports.filter((report) => report.kind === "note").length, 6);
});

test("waits for a started navigation to commit before syncing progress", async () => {
  const events: string[] = [];
  class SettlingPage extends FakePage {
    async waitForLoadState(state: string, options?: { timeout?: number }) {
      events.push(`settle:${state}:${options?.timeout}`);
    }
  }
  const page = new SettlingPage();
  page.elements = [{ role: "primary-action", text: "Go" }];
  await runWith(page, [{ type: "click", targetRole: "primary-action" }, { type: "finish" }], {
    reportAction(report) { events.push(`report:${report.step}`); },
    async reportFinish() { events.push("finish"); },
    async syncProgress() { events.push("sync"); },
  });
  assert.deepEqual(events, [
    "report:1", "settle:domcontentloaded:3000", "sync",
    "finish", "report:2", "settle:domcontentloaded:3000", "sync",
  ]);
});

test("applies the configured action timeout and tolerates unreadable evidence", async () => {
  const page = new FakePage();
  page.evidenceError = new Error("evaluate timed out");
  const { reports } = await runWith(
    page,
    [{ type: "type", targetRole: "search", text: "monitor" }, { type: "finish" }],
    {},
    { actionTimeoutMs: 750 },
  );

  assert.deepEqual(page.actions[0], {
    kind: "fill",
    selector: '[data-arena-role="search"]',
    hasText: undefined,
    value: "monitor",
    options: { timeout: 750 },
  });
  assert.equal(reports[0].kind, "action");
  assert.equal(reports[0].evidence?.target, undefined);
  assert.throws(
    () => new PlaywrightCompetitorRunner({
      task: "t",
      startUrl: "https://course.test/",
      model: new SequenceModel([]),
      actionTimeoutMs: 0,
    }),
    /actionTimeoutMs must be a positive number/,
  );
});

test("does not impose a default action ceiling", async () => {
  const page = new FakePage();
  const reports: AgentActionReport[] = [];
  const decisions: AgentDecision[] = [
    ...Array.from({ length: 20 }, () => ({ type: "inspect" as const })),
    { type: "finish" },
  ];
  const runner = new PlaywrightCompetitorRunner({
    task: "Complete the course",
    startUrl: "https://course.test/start",
    model: new SequenceModel(decisions),
  });
  const base = contextFor(page);
  await runner.prepare(base);
  await runner.run({
    ...base,
    async reportCheckpoint() {},
    async reportFinish() {},
    reportAction(report) { reports.push(report); },
  });

  assert.equal(reports.length, 21);
  assert.equal(reports.at(-1)?.step, 21);
  assert.equal(reports.at(-1)?.maxSteps, 0);
});

test("checks completion after a browser action error", async () => {
  const page = new ScreenshotPage();
  page.failClicksOn.add("missing");
  let synced = false;
  const runner = new PlaywrightCompetitorRunner({
    task: "Complete the course",
    startUrl: "https://course.test/start",
    model: new SequenceModel([{ type: "click", targetRole: "missing" }]),
  });
  const base = contextFor(page);
  await runner.prepare(base);
  await runner.run({
    ...base,
    async reportCheckpoint() {},
    async reportFinish() {},
    async syncProgress() { synced = true; },
    async checkFinish() { return synced; },
  });

  assert.equal(synced, true);
});

test("captures frames on an interval without overlap and stops when the run ends", async () => {
  const page = new ScreenshotPage();
  page.shotDelayMs = 15;
  let released!: () => void;
  const gate = new Promise<void>((resolve) => { released = resolve; });
  const model: CompetitorDecisionModel = {
    async decide() {
      await gate;
      return { type: "finish" };
    },
  };
  const runner = new PlaywrightCompetitorRunner({
    task: "Complete the course",
    startUrl: "https://course.test/start",
    model,
    frameIntervalMs: 3,
  });
  const frames: CapturedFrame[] = [];
  const base = contextFor(page);
  await runner.prepare(base);
  const running = runner.run({
    ...base,
    async reportCheckpoint() {},
    async reportFinish() {},
    reportFrame(frame) { frames.push(frame); },
  });

  await delay(80);
  released();
  await running;
  const afterRun = page.shots.length;
  assert.ok(frames.length >= 2, `expected interval frames, got ${frames.length}`);
  assert.equal(page.maxActive, 1);

  await delay(40);
  assert.ok(page.shots.length <= afterRun + 1, "interval kept capturing after the run ended");
  const settled = page.shots.length;
  await delay(40);
  assert.equal(page.shots.length, settled);
});

test("stop clears the frame interval and swallows capture errors", async () => {
  const page = new FakePage(); // no screenshot(): every capture fails
  let released!: () => void;
  const gate = new Promise<void>((resolve) => { released = resolve; });
  const runner = new PlaywrightCompetitorRunner({
    task: "Complete the course",
    startUrl: "https://course.test/start",
    model: {
      async decide() {
        await gate;
        return { type: "inspect" };
      },
    },
    frameIntervalMs: 2,
  });
  const frames: CapturedFrame[] = [];
  const base = contextFor(page);
  await runner.prepare(base);
  const running = runner.run({
    ...base,
    async reportCheckpoint() {},
    async reportFinish() {},
    reportFrame(frame) { frames.push(frame); },
  });
  await delay(20);
  await runner.stop("racer-1");
  released();
  await running;
  assert.equal(frames.length, 0);
});

test("requires a model or a per-racer model resolver", () => {
  assert.throws(
    () => new PlaywrightCompetitorRunner({ task: "t", startUrl: "https://course.test/" }),
    /model or model resolver is required/,
  );
});

test("reports what the model saw, the exact tool call, its reasoning and timing", async () => {
  const page = new FakePage();
  page.elements = [{ role: "primary-action", text: "Add to cart" }, { role: "search", text: "Search" }];
  page.controls = [
    { tag: "button", role: null, arenaRole: "primary-action", text: "Add to cart", disabled: false, visible: true, masked: false },
    { tag: "input", role: "searchbox", arenaRole: "search", text: "", disabled: false, visible: true, masked: false },
  ];
  const before = Date.now();
  const { reports, model } = await runWith(page, [
    { type: "click", targetRole: "primary-action", label: "Add to cart", reasoning: "The task needs the SSD in the cart." },
    { type: "type", targetRole: "search", text: "1 TB SSD", reasoning: "Searching narrows the list." },
    { type: "finish" },
  ]);

  assert.deepEqual(reports[0].observation, {
    url: page.navigations[0],
    title: "Course",
    text: "Demo course",
    controls: [
      { tag: "button", role: null, arenaRole: "primary-action", label: "Add to cart", visible: true, disabled: false },
      { tag: "input", role: "searchbox", arenaRole: "search", label: "", visible: true, disabled: false },
    ],
  });
  assert.deepEqual(reports.map((report) => report.action), [
    { type: "click", targetRole: "primary-action", label: "Add to cart" },
    { type: "type", targetRole: "search", text: "1 TB SSD", textLength: 8 },
    { type: "finish" },
  ]);
  assert.deepEqual(reports.map((report) => report.reasoning), [
    "The task needs the SSD in the cart.",
    "Searching narrows the list.",
    undefined,
  ]);
  for (const report of reports) {
    assert.ok(typeof report.observedAt === "number" && typeof report.decidedAt === "number");
    assert.ok(before <= report.observedAt && report.observedAt <= report.decidedAt && report.decidedAt <= Date.now());
  }
  // Loop signatures and the model's own history leave the reasoning out.
  assert.equal(
    reports[0].signature,
    JSON.stringify({ type: "click", targetRole: "primary-action", label: "Add to cart" }),
  );
  assert.deepEqual(model.inputs[1].history, [
    { decision: { type: "click", targetRole: "primary-action", label: "Add to cart" } },
  ]);
  assert.doesNotMatch(JSON.stringify(model.inputs.map((input) => input.history)), /reasoning|SSD in the cart|narrows/);
  // The model's observation is unchanged: the masking flag never reaches it.
  assert.deepEqual(model.inputs[0].observation.controls[0], {
    tag: "button", role: null, arenaRole: "primary-action", text: "Add to cart", disabled: false, visible: true,
  });
});

test("tags the screenshot taken with each observation, before the model decides", async () => {
  const page = new ScreenshotPage();
  const shoot = page.screenshot.bind(page);
  let shots = 0;
  page.screenshot = async (options: Record<string, unknown>) => {
    shots += 1;
    if (shots === 3) throw new Error("capture failed");
    return shoot(options);
  };
  const frames: CapturedFrame[] = [];
  const reports: AgentActionReport[] = [];
  const seenAtDecide: Array<Array<number | undefined>> = [];
  const decisions: AgentDecision[] = [{ type: "inspect" }, { type: "inspect" }, { type: "finish" }];
  const runner = new PlaywrightCompetitorRunner({
    task: "Complete the course",
    startUrl: "https://course.test/start",
    frameIntervalMs: 60_000,
    model: {
      async decide() {
        seenAtDecide.push(frames.map((frame) => frame.step));
        const decision = decisions.shift();
        if (!decision) throw new Error("No decision configured");
        return decision;
      },
    },
  });
  const base = contextFor(page);
  await runner.prepare(base);
  await runner.run({
    ...base,
    async reportCheckpoint() {},
    async reportFinish() {},
    reportAction(report) { reports.push(report); },
    reportFrame(frame) { frames.push(frame); },
  });

  // Step 2's screenshot failed: that frame alone is lost, and the run goes on.
  assert.deepEqual(seenAtDecide, [[1], [1, undefined], [1, undefined, undefined, 3]]);
  assert.deepEqual(reports.map((report) => report.step), [1, 2, 3]);
  for (const frame of frames.filter((item) => item.step !== undefined)) {
    const report = reports[(frame.step ?? 0) - 1];
    assert.ok(frame.capturedAt !== undefined && report.decidedAt !== undefined);
    assert.ok(frame.capturedAt <= report.decidedAt, "the screenshot precedes the decision");
  }
});

test("never records text typed into a password field", async () => {
  const secret = "hunter2-secret";
  const page = new FakePage();
  page.elements = [
    { role: "account-password", text: "Password", type: "password" },
    { role: "primary-action", text: "Sign in" },
  ];
  // Playwright's call log quotes the value a failed fill was given.
  page.fillErrors = [new Error([
    "locator.fill: Timeout 5000ms exceeded.",
    "Call log:",
    `  - waiting for locator('[data-arena-role="account-password"]').first()`,
    `    - fill("${secret}")`,
    "      - element is not enabled",
  ].join("\n"))];
  // Once filled, the field shows its value and the page echoes it.
  page.onFill = (value) => {
    page.controls = [{
      tag: "input", role: null, arenaRole: "account-password", text: value, disabled: false, visible: true, masked: true,
    }];
    page.bodyText = `Signed in with ${value}`;
  };
  const { reports, model } = await runWith(page, [
    { type: "type", targetRole: "account-password", text: secret, reasoning: `I type ${secret} as the password.` },
    { type: "type", targetRole: "account-password", text: secret },
    { type: "click", targetRole: "primary-action", reasoning: `${secret} is in, so I sign in.` },
    { type: "finish" },
  ]);

  assert.doesNotMatch(JSON.stringify(reports), new RegExp(secret));
  assert.deepEqual(reports.map((report) => report.text), [
    'Typed "[redacted]" into account-password',
    'Typed "[redacted]" into account-password',
    'Clicked "primary-action"',
    "Reported finish",
  ]);
  assert.deepEqual(reports[1].action, {
    type: "type", targetRole: "account-password", text: "[redacted]", textLength: secret.length,
  });
  assert.equal(
    reports[0].signature,
    JSON.stringify({ type: "type", targetRole: "account-password", text: "[redacted]" }),
  );
  assert.equal(reports[0].kind, "error");
  assert.match(reports[0].error ?? "", /fill\("\[redacted\]"\)/);
  assert.equal(reports[0].reasoning, "I type [redacted] as the password.");
  // What the model was told carries no call log, so no typed value either.
  assert.equal(reports[0].modelError, "locator.fill: Timeout 5000ms exceeded. The control is disabled.");
  assert.equal(reports[0].modelError, model.inputs[1].history[0].error);
  assert.equal(reports[2].reasoning, "[redacted] is in, so I sign in.");
  assert.deepEqual(reports[2].observation?.controls.map((control) => control.label), ["[redacted]"]);
  assert.equal(reports[2].observation?.text, "Signed in with [redacted]");
  // Evidence reads a password field's label, never its value.
  assert.deepEqual(reports[1].evidence?.target, { role: "account-password", text: "Password", decoy: false });
  // The model still sees what it typed; only the record is redacted.
  const typed = model.inputs[1].history[0].decision;
  assert.equal(typed.type === "type" ? typed.text : null, secret);
});

test("redacts typing into a field named like a password, or one that cannot be read", async () => {
  const page = new FakePage();
  page.elements = [{ role: "search", text: "Search" }];
  const { reports } = await runWith(page, [
    { type: "type", targetRole: "pin-code", text: "4821" },
    { type: "type", targetRole: "search", text: "monitor", label: "Search" },
    { type: "finish" },
  ]);
  assert.deepEqual(reports.map((report) => report.action?.text), ["[redacted]", "monitor", undefined]);
  assert.equal(reports[0].text, 'Typed "[redacted]" into pin-code');
  assert.equal(reports[1].text, 'Typed "monitor" into "Search" (search)');
  assert.doesNotMatch(JSON.stringify(reports), /4821/);

  // A target whose type cannot be read might be a password field.
  const unreadable = new FakePage();
  unreadable.evidenceError = new Error("evaluate timed out");
  const { reports: blind } = await runWith(unreadable, [
    { type: "type", targetRole: "search", text: "monitor" },
    { type: "finish" },
  ]);
  assert.deepEqual(blind[0].action, { type: "type", targetRole: "search", text: "[redacted]", textLength: 7 });
});

test("reports the prompt time, the rate-limit pause and any decision issue with each step", async () => {
  const answers: Array<{ decision: AgentDecision; issue: DecisionIssue | null }> = [
    { decision: { type: "inspect" }, issue: { malformedAttempts: 2, fallback: true } },
    { decision: { type: "finish" }, issue: null },
  ];
  let pending: DecisionIssue | null = null;
  const model: CompetitorDecisionModel = {
    async prepareForCall() {
      return { waitedMs: 1_500 };
    },
    async decide() {
      const next = answers.shift();
      if (!next) throw new Error("No decision configured");
      pending = next.issue;
      return next.decision;
    },
    takeDecisionIssue() {
      const taken = pending;
      pending = null;
      return taken;
    },
  };
  const { reports } = await runWith(new FakePage(), [], {}, { model });

  const steps = reports.filter((report) => report.kind !== "note");
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0].decisionIssue, { malformedAttempts: 2, fallback: true });
  assert.equal(steps[1].decisionIssue, undefined);
  for (const report of steps) {
    assert.equal(report.rateLimitWaitMs, 1_500);
    const { observedAt, promptedAt, decidedAt } = report;
    assert.ok(observedAt !== undefined && promptedAt !== undefined && decidedAt !== undefined);
    assert.ok(observedAt <= promptedAt && promptedAt <= decidedAt);
  }
});
