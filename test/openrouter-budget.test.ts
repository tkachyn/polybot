import assert from "node:assert/strict";
import test from "node:test";
import { OpenRouterUsageBudget } from "../src/agents/openrouter-models.js";
import { failureCause, failureProblem } from "../src/domain/failure-reasons.js";

test("a racer that spends its share of the race budget stops only itself", () => {
  const race = new OpenRouterUsageBudget(1);
  const looping = race.share("racer-2", 0.25);
  const other = race.share("racer-3", 0.25);
  const master = race.share("master", 0.125);

  // racer-2 loops until its own share is gone.
  looping.record(0.125);
  looping.record(0.125);
  assert.throws(
    () => looping.assertAvailable(),
    /racer-2's \$0\.25 share of the OpenRouter race budget was exhausted/,
  );
  // Everyone else still has theirs.
  assert.doesNotThrow(() => other.assertAvailable());
  assert.doesNotThrow(() => master.assertAvailable());

  // The race's total still counts every call, for llmUsage.
  master.record(0.0625);
  assert.deepEqual(race.snapshot(), { limitUsd: 1, spentUsd: 0.3125, remainingUsd: 0.6875, requests: 3 });
  assert.deepEqual(looping.snapshot(), { limitUsd: 0.25, spentUsd: 0.25, remainingUsd: 0, requests: 2 });
});

test("a spent share reads as the racer's own budget running out, not the fight's", () => {
  const share = new OpenRouterUsageBudget(1).share("racer-2", 0.25);
  share.record(0.25);
  let message = "";
  try {
    share.assertAvailable();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  // As the runner reports it once the racer's retries are spent.
  const reason = `racer-2 model decision failed after 3 provider/protocol retries: ${message}`;
  assert.equal(failureCause(reason), "stopped when its share of the model budget ran out");
  assert.equal(failureProblem(message), "its share of the model budget ran out");
  // A whole race budget keeps its own wording.
  assert.equal(
    failureCause("OpenRouter race budget of $1.00 was exhausted"),
    "stopped when the fight's model budget ran out",
  );
});
