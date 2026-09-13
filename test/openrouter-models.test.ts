import assert from "node:assert/strict";
import test from "node:test";
import { COMPETITOR_TOOL_NAME, competitorUserMessage } from "../src/agents/competitor-decision.js";
import {
  OpenRouterCompetitorDecisionModel,
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

const INPUT = {
  task: "Buy the blue mug",
  racerId: "racer-1",
  observation: { url: "https://shop.test/", title: "Shop", bodyText: "Blue mug", controls: [] },
  history: [],
};

type Request = { messages: Array<{ role: string; content: string }> };

/** A competitor model whose provider answers each request with the next tool payload. */
function scripted(payloads: string[]) {
  const requests: Request[] = [];
  const model = new OpenRouterCompetitorDecisionModel({ model: "test/model", apiKey: "test-key" });
  const create = async (request: Request) => {
    requests.push(request);
    const call = { type: "function", function: { name: COMPETITOR_TOOL_NAME, arguments: payloads.shift() ?? "" } };
    return { choices: [{ message: { tool_calls: [call] } }], usage: { cost: 0 } };
  };
  Object.defineProperty(model, "client", { value: { chat: { completions: { create } } } });
  return { model, requests };
}

test("a first-try tool call has no decision issue, and the prompt is the runtime user message", async () => {
  const { model, requests } = scripted(['{"type":"click","targetRole":"primary-action","reasoning":"Next."}']);
  const decision = await model.decide({ ...INPUT, signal: new AbortController().signal });
  assert.equal(decision.type, "click");
  assert.equal(model.takeDecisionIssue(), null);
  assert.equal(requests[0].messages[1].content, competitorUserMessage(INPUT));
  assert.doesNotMatch(requests[0].messages[1].content, /"signal"/);
});

test("a malformed payload fixed on the retry is one malformed attempt, cleared on read", async () => {
  const { model, requests } = scripted(["not json", '{"type":"finish"}']);
  assert.equal((await model.decide(INPUT)).type, "finish");
  assert.deepEqual(model.takeDecisionIssue(), { malformedAttempts: 1, fallback: false });
  assert.equal(model.takeDecisionIssue(), null);
  assert.match(requests[1].messages[0].content, /previous tool payload was malformed/);
});

test("when the model never gives a usable call, the inspect it gets is marked as a fallback", async () => {
  const garbled = scripted(["not json", "still not json"]);
  assert.deepEqual(await garbled.model.decide(INPUT), { type: "inspect" });
  assert.deepEqual(garbled.model.takeDecisionIssue(), { malformedAttempts: 2, fallback: true });

  // Valid JSON that is not a decision is not retried.
  const invalid = scripted(['{"type":"teleport"}', '{"type":"finish"}']);
  assert.deepEqual(await invalid.model.decide(INPUT), { type: "inspect" });
  assert.deepEqual(invalid.model.takeDecisionIssue(), { malformedAttempts: 1, fallback: true });
  // The next decision starts clean.
  assert.equal((await invalid.model.decide(INPUT)).type, "finish");
  assert.equal(invalid.model.takeDecisionIssue(), null);
});
