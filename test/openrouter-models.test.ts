import assert from "node:assert/strict";
import test from "node:test";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  InternalServerError,
  RateLimitError,
} from "openai";
import {
  COMPETITOR_TOOL_NAME,
  competitorUserMessage,
  DecisionRetryError,
} from "../src/agents/competitor-decision.js";
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

test("the default limiter paces Claude Haiku 4.5 by its configured id, and ids match in any case", async () => {
  const limiter = new OpenRouterModelRateLimiter();
  for (const model of ["anthropic/claude-haiku-4.5", " Anthropic/Claude-Haiku-4.5 ", "openai/gpt-5.6-luna"]) {
    const wait = await limiter.acquire(model);
    assert.deepEqual([wait.maxCalls, wait.windowMs], [20, 60_000], model);
  }
  const configured = new OpenRouterModelRateLimiter({ "Qwen/Qwen3.8-27B": { maxCalls: 3, windowMs: 1_000 } });
  assert.equal((await configured.acquire("qwen/qwen3.8-27b")).maxCalls, 3);
});

const INPUT = {
  task: "Buy the blue mug",
  racerId: "racer-1",
  observation: { url: "https://shop.test/", title: "Shop", bodyText: "Blue mug", controls: [] },
  history: [],
};

type Request = {
  messages: Array<{ role: string; content: string }>;
  tools: unknown[];
  tool_choice: unknown;
};
type RequestOptions = { signal?: AbortSignal; maxRetries?: number };
/**
 * One provider reply: a tool payload, a reply without the tool call, a failed
 * request, or a function that returns one of these when the request is made.
 */
type Reply = string | { content: string } | Error | (() => Reply);
type ModelOptions = ConstructorParameters<typeof OpenRouterCompetitorDecisionModel>[0];

/** A competitor model whose provider answers each request with the next scripted reply. */
function scripted(replies: Reply[], options: Partial<ModelOptions> = {}) {
  const requests: Request[] = [];
  const sent: Array<RequestOptions | undefined> = [];
  const model = new OpenRouterCompetitorDecisionModel({ model: "test/model", apiKey: "test-key", ...options });
  const create = async (request: Request, requestOptions?: RequestOptions) => {
    requests.push(request);
    sent.push(requestOptions);
    let reply = replies.shift() ?? "";
    while (typeof reply === "function") reply = reply();
    if (reply instanceof Error) throw reply;
    const message = typeof reply === "string"
      ? { tool_calls: [{ type: "function", function: { name: COMPETITOR_TOOL_NAME, arguments: reply } }] }
      : { content: reply.content };
    return { choices: [{ message }], usage: { cost: 0 } };
  };
  Object.defineProperty(model, "client", { value: { chat: { completions: { create } } } });
  return { model, requests, sent };
}

/** A 429 as OpenRouter sends it, with these response headers and error metadata. */
function rateLimited(headers: Record<string, string> = {}, metadata?: Record<string, unknown>): APIError {
  const error = {
    message: "Rate limit exceeded: new-account-rpm/anthropic/claude-4.5-haiku-20251001",
    code: 429,
    ...(metadata === undefined ? {} : { metadata }),
  };
  return APIError.generate(429, { error }, undefined, new Headers(headers));
}

/** The error a decision rejects with. */
function failureOf(decision: Promise<unknown>): Promise<unknown> {
  return decision.then(() => assert.fail("expected the decision to fail"), (error: unknown) => error);
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

test("a reply without the tool call is asked again with tool_choice required", async () => {
  const { model, requests } = scripted([
    { content: "I will click Add to cart." },
    '{"type":"click","targetRole":"primary-action"}',
  ]);
  assert.deepEqual(await model.decide(INPUT), { type: "click", targetRole: "primary-action" });
  assert.deepEqual(model.takeDecisionIssue(), { malformedAttempts: 1, fallback: false });
  // Some providers ignore a named tool choice but honour "required".
  assert.deepEqual(requests.map((request) => request.tool_choice), [
    { type: "function", function: { name: COMPETITOR_TOOL_NAME } },
    "required",
  ]);
  assert.equal(requests[1].tools.length, 1);
  assert.match(requests[1].messages[0].content, /did not call take_browser_action/);
});

test("a model that never calls the tool inspects instead of ending the racer", async () => {
  const { model, requests } = scripted([{ content: "Clicking." }, { content: "Still prose." }]);
  assert.deepEqual(await model.decide(INPUT), { type: "inspect" });
  assert.deepEqual(model.takeDecisionIssue(), { malformedAttempts: 2, fallback: true });
  assert.equal(requests.length, 2);
});

test("a click without a targetRole inspects instead of ending the racer", async () => {
  // Claude Haiku once lost a fight to "click requires targetRole".
  const { model } = scripted(['{"type":"click","label":"Checkout"}']);
  assert.deepEqual(await model.decide(INPUT), { type: "inspect" });
  assert.deepEqual(model.takeDecisionIssue(), { malformedAttempts: 1, fallback: true });
});

test("a rate limit becomes a paced retry that prepareForCall waits out", async () => {
  const { model, sent } = scripted([rateLimited({ "retry-after-ms": "40" }), '{"type":"finish"}'], {
    providerRetry: { baseMs: 10, windowMs: 1_000 },
  });
  const failure = await failureOf(model.decide(INPUT));
  assert.ok(failure instanceof DecisionRetryError);
  assert.equal(failure.message, "rate limited (HTTP 429)");
  assert.equal(failure.retryAfterMs, 40);
  assert.ok(failure.cause instanceof RateLimitError);
  const wait = await model.prepareForCall();
  assert.ok(wait.waitedMs >= 30, `waited ${wait.waitedMs}ms`);
  assert.deepEqual(await model.decide(INPUT), { type: "finish" });
  // Nothing is left to wait out, and the SDK never retried unseen.
  assert.equal((await model.prepareForCall()).waitedMs, 0);
  assert.deepEqual(sent.map((options) => options?.maxRetries), [0, 0]);
});

test("transient failures back off exponentially within the window, and an answer starts afresh", async () => {
  const unavailable = () =>
    APIError.generate(503, { error: { message: "Service unavailable" } }, undefined, new Headers());
  const { model } = scripted([
    unavailable(),
    new APIConnectionError({ message: "Connection error." }),
    new APIConnectionTimeoutError(),
    unavailable(),
    unavailable(),
    unavailable(),
    '{"type":"finish"}',
    unavailable(),
  ]);
  const retries: Array<[string, number]> = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failure = await failureOf(model.decide(INPUT));
    assert.ok(failure instanceof DecisionRetryError);
    retries.push([failure.message, failure.retryAfterMs]);
  }
  // Doubling from 1 s; the last wait is cut to what is left of the 30 s window.
  assert.deepEqual(retries, [
    ["provider error (HTTP 503)", 1_000],
    ["connection failed", 2_000],
    ["request timed out", 4_000],
    ["provider error (HTTP 503)", 8_000],
    ["provider error (HTTP 503)", 15_000],
  ]);
  // With the window spent, the failure itself is thrown.
  await assert.rejects(model.decide(INPUT), InternalServerError);
  // An answer starts a fresh back-off.
  assert.deepEqual(await model.decide(INPUT), { type: "finish" });
  const fresh = await failureOf(model.decide(INPUT));
  assert.ok(fresh instanceof DecisionRetryError);
  assert.equal(fresh.retryAfterMs, 1_000);
});

test("paced retries honour Retry-After and OpenRouter's reset time, but never past the window", async () => {
  const resetAt = Date.now() + 12_000;
  const { model } = scripted([
    rateLimited({ "retry-after": "3" }),
    rateLimited({}, {
      headers: { "X-RateLimit-Limit": "20", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(resetAt) },
    }),
    rateLimited({ "retry-after": "45" }),
  ]);
  const first = await failureOf(model.decide(INPUT));
  assert.ok(first instanceof DecisionRetryError);
  assert.equal(first.retryAfterMs, 3_000);
  const second = await failureOf(model.decide(INPUT));
  assert.ok(second instanceof DecisionRetryError);
  assert.ok(second.retryAfterMs > 11_000 && second.retryAfterMs <= 12_000, `${second.retryAfterMs}ms`);
  // 45 s does not fit in what is left of the window: the rate limit itself is thrown.
  await assert.rejects(model.decide(INPUT), RateLimitError);
});

test("auth and credit errors, a spent budget and aborts are never retried", async () => {
  for (const status of [401, 402, 403]) {
    const { model } = scripted([
      APIError.generate(status, { error: { message: "No auth credentials found" } }, undefined, new Headers()),
    ]);
    await assert.rejects(model.decide(INPUT), (error: unknown) => error instanceof APIError && error.status === status);
  }
  // A rate limit once the race budget is spent reports the budget.
  const budget = new OpenRouterUsageBudget(0.01);
  const broke = scripted([() => {
    budget.record(0.01);
    return rateLimited({ "retry-after": "1" });
  }], { budget });
  await assert.rejects(broke.model.decide(INPUT), /budget of \$0\.01 was exhausted/);
  // A rate limit on a request the runner aborted is thrown as it is.
  const controller = new AbortController();
  const stopped = scripted([() => {
    controller.abort();
    return rateLimited({ "retry-after": "1" });
  }]);
  await assert.rejects(stopped.model.decide({ ...INPUT, signal: controller.signal }), RateLimitError);
});
