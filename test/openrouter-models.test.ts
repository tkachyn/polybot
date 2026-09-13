import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenRouterModelRateLimiter,
  OpenRouterToolArgumentsError,
  OpenRouterUsageBudget,
  parseToolArguments,
} from "../src/agents/openrouter-models.js";

test("tracks OpenRouter spend and blocks calls after the race budget", () => {
  const budget = new OpenRouterUsageBudget(0.25);
  budget.record(0.10);
  budget.record(0.15);

  assert.deepEqual(budget.snapshot(), {
    limitUsd: 0.25,
    spentUsd: 0.25,
    remainingUsd: 0,
    requests: 2,
  });
  assert.throws(() => budget.assertAvailable(), /budget of \$0\.25 was exhausted/);
});

test("repairs bounded OpenRouter JSON wrappers without evaluating provider output", () => {
  assert.deepEqual(parseToolArguments('```json\n{"type":"inspect",}\n```'), {
    type: "inspect",
  });
  assert.deepEqual(parseToolArguments('provider response: {"type":"finish"}'), {
    type: "finish",
  });
  assert.throws(() => parseToolArguments("not json"), OpenRouterToolArgumentsError);
});

test("shares a sliding-window limit across calls for one model", async () => {
  const limiter = new OpenRouterModelRateLimiter({
    "openai/gpt-5.6-luna": { maxCalls: 2, windowMs: 30 },
  });
  await limiter.acquire("openai/gpt-5.6-luna");
  await limiter.acquire("OPENAI/GPT-5.6-LUNA");
  const started = Date.now();
  const wait = await limiter.acquire("openai/gpt-5.6-luna");

  assert.ok(wait.waitedMs >= 15, `expected a window wait, got ${Date.now() - started}ms`);
  assert.equal(wait.maxCalls, 2);
  assert.equal(wait.windowMs, 30);
  const unlimited = await limiter.acquire("anthropic/claude");
  assert.equal(unlimited.waitedMs, 0);
});
