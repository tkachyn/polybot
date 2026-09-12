import assert from "node:assert/strict";
import test from "node:test";
import {
  createRosterModels,
  resolveCompetitorRoster,
} from "../src/agents/competitor-roster.js";
import type { CompetitorDecisionModel } from "../src/agents/playwright-competitor-runner.js";
import { DEFAULT_AGENT_ROSTER } from "../src/application/fight-metadata.js";

const FULL_ENV = {
  RACER_1_MODEL: "gpt-5.2",
  RACER_3_MODEL: "gemini-3-pro",
  RACER_4_MODEL: "grok-4.1",
  COMPETITOR_LLM_MODEL: "claude-opus-4-6",
};

test("resolves the default roster with env models and the anthropic fallback", () => {
  const roster = resolveCompetitorRoster(undefined, FULL_ENV);
  assert.deepEqual(roster.map((agent) => [agent.key, agent.provider, agent.model]), [
    ["gpt", "openai", "gpt-5.2"],
    ["claude", "anthropic", "claude-opus-4-6"],
    ["gemini", "google", "gemini-3-pro"],
    ["grok", "xai", "grok-4.1"],
  ]);
  // The default roster itself is never mutated.
  assert.equal(DEFAULT_AGENT_ROSTER[0].model, "unconfigured");
});

test("env overrides win over the fight's agents; fight models are kept otherwise", () => {
  const agents = DEFAULT_AGENT_ROSTER.map((agent) => ({ ...agent, model: `${agent.key}-fight` }));
  const roster = resolveCompetitorRoster(agents, {
    RACER_2_PROVIDER: "openai",
    RACER_2_MODEL: "gpt-mini",
    RACER_2_NAME: "GPT Mini",
    RACER_2_KEY: "gpt-mini",
  });
  assert.deepEqual(roster[0], { ...DEFAULT_AGENT_ROSTER[0], model: "gpt-fight" });
  assert.deepEqual(roster[1], {
    key: "gpt-mini",
    name: "GPT Mini",
    provider: "openai",
    model: "gpt-mini",
  });
  assert.throws(() => resolveCompetitorRoster(agents.slice(0, 3), {}), /exactly 4 agents/);
});

test("createRosterModels builds one model per racer id", () => {
  const roster = resolveCompetitorRoster(undefined, FULL_ENV);
  const created: Array<{ provider: string; model: string }> = [];
  const models = createRosterModels(roster, FULL_ENV, (options) => {
    created.push({ provider: options.provider, model: options.model });
    return { decide: async () => ({ type: "finish" }) } satisfies CompetitorDecisionModel;
  });
  assert.deepEqual([...models.keys()], ["racer-1", "racer-2", "racer-3", "racer-4"]);
  assert.deepEqual(created.map((entry) => entry.provider), ["openai", "anthropic", "google", "xai"]);
});

test("createRosterModels reports every missing model and key in one error", () => {
  const roster = resolveCompetitorRoster(undefined, { RACER_1_MODEL: "gpt-5.2" });
  assert.throws(
    () => createRosterModels(roster, { RACER_1_MODEL: "gpt-5.2" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /racer-1 \(GPT-5\.2, openai\): OPENAI_API_KEY is required/);
      assert.match(error.message, /racer-2 .* has no model: set RACER_2_MODEL or COMPETITOR_LLM_MODEL/);
      assert.match(error.message, /racer-3 .* has no model: set RACER_3_MODEL;/);
      assert.match(error.message, /racer-4 .* has no model: set RACER_4_MODEL$/);
      return true;
    },
  );
});
