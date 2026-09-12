import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDisruptionScript,
  validateDisruptionCommand,
} from "../src/infra/cdp-obstacle-provider.js";

test("builds a bounded disruption script without executing it", () => {
  const script = buildDisruptionScript(
    {
      hazardType: "move_primary_action",
      targetRole: "checkout-submit",
      durationMs: 12_000,
      intensity: 2,
    },
    "disruption-1",
  );

  assert.match(script, /checkout-submit/);
  assert.match(script, /disruption-1/);
  assert.match(script, /durationMs = 12000/);
});

test("rejects unsafe disruption bounds", () => {
  assert.throws(
    () => validateDisruptionCommand({
      hazardType: "run_arbitrary_script" as never,
      targetRole: "x",
      durationMs: 100,
      intensity: 1,
    }),
    /unsupported hazardType/,
  );

  assert.throws(
    () => validateDisruptionCommand({
      hazardType: "blocking_modal",
      targetRole: "x",
      durationMs: 30_001,
      intensity: 1,
    }),
    /cannot exceed/,
  );

  assert.throws(
    () => validateDisruptionCommand({
      hazardType: "blocking_modal",
      targetRole: "x",
      durationMs: 100,
      intensity: 4,
    }),
    /intensity/,
  );
});
