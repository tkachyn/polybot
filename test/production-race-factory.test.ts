import assert from "node:assert/strict";
import test from "node:test";
import { MASTER_CAPACITY_SHARE } from "../src/agents/openrouter-models.js";
import {
  agentKeyForModel,
  competitorRoster,
  displayNameForModel,
  masterCapacityShare,
  modelRateLimits,
  openRouterAgents,
} from "../src/application/production-race-factory.js";

test("labels OpenRouter models with readable names", () => {
  assert.equal(displayNameForModel("openai/gpt-5.6-luna"), "GPT-5.6 Luna");
  assert.equal(displayNameForModel("qwen/qwen3.8-27b"), "Qwen3.8 27B");
  assert.equal(displayNameForModel("google/gemma-3-27b-it"), "Gemma 3 27B IT");
  assert.equal(displayNameForModel("deepseek/deepseek-v4-pro-0813"), "DeepSeek V4 Pro 0813");
  assert.equal(displayNameForModel("x-ai/grok-4.1:free"), "Grok 4.1");
});

test("maps model vendors to UI identity keys", () => {
  assert.equal(agentKeyForModel("openai/gpt-5.6-luna"), "gpt");
  assert.equal(agentKeyForModel("qwen/qwen3.8-27b"), "qwen");
  assert.equal(agentKeyForModel("google/gemma-3-27b-it"), "gemini");
  assert.equal(agentKeyForModel("x-ai/grok-4.1"), "grok");
  assert.equal(agentKeyForModel("deepseek/deepseek-v4-pro-0813"), "deepseek");
});

test("names each live racer after the model it actually runs", () => {
  const roster = competitorRoster(
    "openai/gpt-5.6-luna,qwen/qwen3.8-27b,google/gemma-3-27b-it,deepseek/deepseek-v4-pro-0813",
  );
  assert.deepEqual(openRouterAgents(undefined, roster), [
    { key: "gpt", name: "GPT-5.6 Luna", provider: "openrouter", model: "openai/gpt-5.6-luna" },
    { key: "qwen", name: "Qwen3.8 27B", provider: "openrouter", model: "qwen/qwen3.8-27b" },
    { key: "gemini", name: "Gemma 3 27B IT", provider: "openrouter", model: "google/gemma-3-27b-it" },
    { key: "deepseek", name: "DeepSeek V4 Pro 0813", provider: "openrouter", model: "deepseek/deepseek-v4-pro-0813" },
  ]);
});

test("keeps keys unique when two racers share a vendor", () => {
  const roster = competitorRoster(
    "openai/gpt-5.6-luna,openai/gpt-5.6-mini,qwen/qwen3.8-27b,openai/gpt-4.1",
  );
  assert.deepEqual(
    openRouterAgents(undefined, roster).map((agent) => agent.key),
    ["gpt", "gpt-2", "qwen", "gpt-3"],
  );
});

test("an operator roster keeps its names but runs the roster models", () => {
  const roster = competitorRoster("a/m1,b/m2,c/m3,d/m4");
  const agents = openRouterAgents([
    { key: "k1", name: "One", provider: "x", model: "x" },
    { key: "k2", name: "Two", provider: "x", model: "x" },
    { key: "k3", name: "Three", provider: "x", model: "x" },
    { key: "k4", name: "Four", provider: "x", model: "x" },
  ], roster);
  assert.deepEqual(agents.map((agent) => [agent.key, agent.name, agent.model]), [
    ["k1", "One", "a/m1"],
    ["k2", "Two", "b/m2"],
    ["k3", "Three", "c/m3"],
    ["k4", "Four", "d/m4"],
  ]);
  assert.throws(() => openRouterAgents(agents.slice(0, 3), roster), /exactly 4 agents/);
});

test("paces the master in the same window as the racers on its model", () => {
  const limit = { maxCalls: 20, windowMs: 60_000 };
  const roster = competitorRoster(
    "openai/gpt-5.6-luna,anthropic/claude-haiku-4.5,google/gemma-3-27b-it,openai/gpt-5.6-luna",
  );
  // One window per configured model, the master's included, each only once.
  assert.deepEqual(modelRateLimits([...roster.values(), "openai/gpt-5.6-luna", undefined], limit), {
    "openai/gpt-5.6-luna": limit,
    "anthropic/claude-haiku-4.5": limit,
    "google/gemma-3-27b-it": limit,
  });
  assert.ok("x-ai/grok-4.1" in modelRateLimits([...roster.values(), "x-ai/grok-4.1"], limit));
  // On a racer's model the master holds only its share; on a model of its own, the whole window.
  assert.equal(masterCapacityShare(roster, " OpenAI/GPT-5.6-Luna "), MASTER_CAPACITY_SHARE);
  assert.equal(masterCapacityShare(roster, "x-ai/grok-4.1"), 1);
});
