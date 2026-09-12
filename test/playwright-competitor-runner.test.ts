import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import {
  classifyBlockedBy,
  PlaywrightCompetitorRunner,
  type AgentDecision,
  type CompetitorDecisionModel,
  type PlaywrightCompetitorRunnerOptions,
} from "../src/agents/playwright-competitor-runner.js";
import type {
  AgentActionReport,
  CapturedFrame,
  CompetitorContext,
} from "../src/application/contracts.js";

type FakeElement = { role: string; text: string; decoy?: boolean };
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
    return { role: element.role, text: element.text, decoy: element.decoy === true };
  }
  async innerText() { return "Demo course"; }
  async evaluateAll() { return []; }
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
  }
}

class FakePage {
  currentUrl = "https://course.test/";
  navigations: string[] = [];
  /** Controls on the page. Undefined: every role matches one control. */
  elements?: FakeElement[];
  actions: FakeAction[] = [];
  clickError?: Error;
  evidenceError?: Error;
  onClick?: () => void;
  locatorFor(selector: string, hasText?: string) { return new FakeLocator(this, selector, hasText); }
  locator(selector: string) { return this.locatorFor(selector); }
  url() { return this.currentUrl; }
  async title() { return "Course"; }
  async goto(url: string) {
    this.currentUrl = url;
    this.navigations.push(url);
    return null;
  }
  async waitForTimeout() {}
}

type DecisionInput = Parameters<CompetitorDecisionModel["decide"]>[0];

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

  // One capture after each non-final action.
  assert.equal(frames.length, 2);
  assert.equal(frames[0].contentType, "image/jpeg");
  assert.ok(Buffer.isBuffer(frames[0].body));
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
