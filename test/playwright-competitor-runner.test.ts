import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import {
  PlaywrightCompetitorRunner,
  type AgentDecision,
  type CompetitorDecisionModel,
} from "../src/agents/playwright-competitor-runner.js";

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
