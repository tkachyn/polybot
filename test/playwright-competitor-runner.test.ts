import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import {
  PlaywrightCompetitorRunner,
  type AgentDecision,
  type CompetitorDecisionModel,
} from "../src/agents/playwright-competitor-runner.js";
import type { AgentActionReport, CapturedFrame } from "../src/application/contracts.js";

class FakeLocator {
  constructor(private readonly selector: string) {}
  first() { return this; }
  async innerText() { return "Demo course"; }
  async evaluateAll() { return []; }
  async click() { void this.selector; }
  async fill(_value: string) { void this.selector; }
}

class FakePage {
  currentUrl = "https://course.test/";
  navigations: string[] = [];
  locator(selector: string) { return new FakeLocator(selector); }
  url() { return this.currentUrl; }
  async title() { return "Course"; }
  async goto(url: string) {
    this.currentUrl = url;
    this.navigations.push(url);
    return null;
  }
  async waitForTimeout() {}
}

class SequenceModel implements CompetitorDecisionModel {
  constructor(private readonly decisions: AgentDecision[]) {}
  async decide(): Promise<AgentDecision> {
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
    const locator = new FakeLocator(selector);
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
