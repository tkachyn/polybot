import assert from "node:assert/strict";
import test from "node:test";
import { OpenRouterUsageBudget } from "../src/agents/openrouter-models.js";

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
