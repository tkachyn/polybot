import assert from "node:assert/strict";
import test from "node:test";
import {
  MASTER_CAPACITY_SHARE,
  ModelCapacityError,
  OpenRouterMasterPolicyModel,
  OpenRouterModelRateLimiter,
} from "../src/agents/openrouter-models.js";

const MODEL = "openai/gpt-5.6-luna";

test("a shared slot is taken only while one is free and the share has room", async () => {
  const limiter = new OpenRouterModelRateLimiter({ [MODEL]: { maxCalls: 8, windowMs: 60_000 } });
  // A quarter of eight slots: two for share callers, however free the window is.
  assert.equal(limiter.tryAcquireShare(MODEL, 0.25), true);
  assert.equal(limiter.tryAcquireShare(MODEL.toUpperCase(), 0.25), true);
  assert.equal(limiter.tryAcquireShare(MODEL, 0.25), false);
  // The racers keep the other six, without waiting for any of them.
  for (let call = 0; call < 6; call += 1) {
    assert.equal((await limiter.acquire(MODEL)).waitedMs, 0);
  }

  // A full window has no slot to share either.
  const full = new OpenRouterModelRateLimiter({ [MODEL]: { maxCalls: 2, windowMs: 60_000 } });
  await full.acquire(MODEL);
  await full.acquire(MODEL);
  assert.equal(full.tryAcquireShare(MODEL, 1), false);

  // A model without an entry always has room; a share is a fraction of the window.
  assert.equal(limiter.tryAcquireShare("google/gemma-3-27b-it", 0.25), true);
  assert.throws(() => limiter.tryAcquireShare(MODEL, 0), /share/);
  assert.throws(() => limiter.tryAcquireShare(MODEL, 1.5), /share/);
});

type RequestOptions = { maxRetries?: number; timeout?: number };

/** A master whose provider approves every judgement, recording each request's options. */
function master(options: { rateLimiter?: OpenRouterModelRateLimiter; capacityShare?: number } = {}) {
  const sent: RequestOptions[] = [];
  const model = new OpenRouterMasterPolicyModel({ model: MODEL, apiKey: "test-key", ...options });
  const create = async (_request: unknown, requestOptions: RequestOptions = {}) => {
    sent.push(requestOptions);
    const call = {
      type: "function",
      function: { name: "judge_completion", arguments: '{"completed":true,"evidence":"Order placed"}' },
    };
    return { choices: [{ message: { tool_calls: [call] } }], usage: { cost: 0 } };
  };
  Object.defineProperty(model, "client", { value: { chat: { completions: { create } } } });
  return { model, sent };
}

const JUDGEMENT = {
  task: "Buy the blue mug",
  racerId: "racer-1",
  observation: { url: "https://shop.test/order", title: "Order", bodyText: "Order placed", controls: [] },
};

test("the master never waits for capacity and cannot starve a racer on its model", async () => {
  const limiter = new OpenRouterModelRateLimiter({ [MODEL]: { maxCalls: 20, windowMs: 60_000 } });
  const { model, sent } = master({ rateLimiter: limiter });
  const share = 20 * MASTER_CAPACITY_SHARE;
  // It judges until it holds its share of the window...
  for (let call = 0; call < share; call += 1) {
    assert.equal(await model.judgeCompletion(JUDGEMENT), true);
  }
  // ...then fails at once, without a request, instead of queueing for a slot.
  const started = Date.now();
  await assert.rejects(model.judgeCompletion(JUDGEMENT), ModelCapacityError);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(sent.length, share);
  // A racer on the same model keeps the rest of the window, unpaced.
  for (let call = share; call < 20; call += 1) {
    assert.equal((await limiter.acquire(MODEL)).waitedMs, 0);
  }
  // Every master request went out once: the SDK's hidden retries stay off.
  assert.ok(sent.every((options) => options.maxRetries === 0));
});

test("a racer that fills its model's window leaves the master no slot, and the master does not queue", async () => {
  const limiter = new OpenRouterModelRateLimiter({ [MODEL]: { maxCalls: 3, windowMs: 60_000 } });
  const { model, sent } = master({ rateLimiter: limiter, capacityShare: 1 });
  for (let call = 0; call < 3; call += 1) await limiter.acquire(MODEL);
  await assert.rejects(model.judgeCheckpoint({ ...JUDGEMENT, checkpoint: 1 }), ModelCapacityError);
  assert.equal(sent.length, 0);
  assert.throws(() => master({ capacityShare: 0 }), /capacity share/);
});
