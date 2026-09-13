import assert from "node:assert/strict";
import test from "node:test";
import {
  agentKeyForModel,
  competitorRoster,
  displayNameForModel,
  openRouterAgents,
} from "../src/application/production-race-factory.js";

test("labels OpenRouter models with readable names", () => {
  assert.equal(displayNameForModel("openai/gpt-5.6-luna"), "GPT-5.6 Luna");
  assert.equal(displayNameForModel("anthropic/claude-sonnet-4.6"), "Claude Sonnet 4.6");
  assert.equal(displayNameForModel("google/gemma-3-27b-it"), "Gemma 3 27B IT");
  assert.equal(displayNameForModel("deepseek/deepseek-v4-pro-0813"), "DeepSeek V4 Pro 0813");
  assert.equal(displayNameForModel("x-ai/grok-4.1:free"), "Grok 4.1");
});

test("maps model vendors to UI identity keys", () => {
  assert.equal(agentKeyForModel("openai/gpt-5.6-luna"), "gpt");
  assert.equal(agentKeyForModel("anthropic/claude-sonnet-4.6"), "claude");
  assert.equal(agentKeyForModel("google/gemma-3-27b-it"), "gemini");
  assert.equal(agentKeyForModel("x-ai/grok-4.1"), "grok");
  assert.equal(agentKeyForModel("deepseek/deepseek-v4-pro-0813"), "deepseek");
});

test("names each live racer after the model it actually runs", () => {
  const roster = competitorRoster(
    "openai/gpt-5.6-luna,anthropic/claude-sonnet-4.6,google/gemma-3-27b-it,deepseek/deepseek-v4-pro-0813",
  );
  assert.deepEqual(openRouterAgents(undefined, roster), [
    { key: "gpt", name: "GPT-5.6 Luna", provider: "openrouter", model: "openai/gpt-5.6-luna" },
    { key: "claude", name: "Claude Sonnet 4.6", provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
    { key: "gemini", name: "Gemma 3 27B IT", provider: "openrouter", model: "google/gemma-3-27b-it" },
    { key: "deepseek", name: "DeepSeek V4 Pro 0813", provider: "openrouter", model: "deepseek/deepseek-v4-pro-0813" },
  ]);
});

test("keeps keys unique when two racers share a vendor", () => {
  const roster = competitorRoster(
    "openai/gpt-5.6-luna,openai/gpt-5.6-mini,anthropic/claude-sonnet-4.6,openai/gpt-4.1",
  );
  assert.deepEqual(
    openRouterAgents(undefined, roster).map((agent) => agent.key),
    ["gpt", "gpt-2", "claude", "gpt-3"],
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
