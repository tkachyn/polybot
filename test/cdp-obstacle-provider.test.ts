import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDisruptionScript,
  CdpObstacleProvider,
  DECOY_ID_PREFIX,
  DECOY_LABELS,
  MORE_ACTIONS_LABEL,
  MORE_ACTIONS_ROLE,
  RENAME_LABELS,
  validateDisruptionCommand,
} from "../src/infra/cdp-obstacle-provider.js";
import type { SteelSessionManager } from "../src/infra/steel-session-manager.js";
import type { DisruptionCommand } from "../src/domain/types.js";

const HAZARDS: DisruptionCommand["hazardType"][] = [
  "blocking_modal",
  "move_primary_action",
  "insert_decoy",
  "temporary_disable",
  "rename_control",
];

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
  assert.match(script, /__arenaRecoverDisruptions/);
  assert.doesNotMatch(script, /setTimeout\(revert/);
});

test("every hazard script parses and carries the contract's roles and labels", () => {
  for (const hazardType of HAZARDS) {
    for (const intensity of [1, 2, 3]) {
      const script = buildDisruptionScript(
        { hazardType, targetRole: 'primary-"action\\', durationMs: 5_000, intensity },
        "disruption-race-1-racer-1-0-plant-decoy-control",
      );
      assert.doesNotThrow(() => new Function(`return ${script}`), `${hazardType}@${intensity}`);
      assert.match(script, /target_not_found/);
      assert.match(script, /already_applied/);
    }
  }
  const script = buildDisruptionScript(
    { hazardType: "insert_decoy", targetRole: "primary-action", durationMs: 5_000, intensity: 1 },
    "d-1",
  );
  for (const expected of [
    MORE_ACTIONS_ROLE,
    MORE_ACTIONS_LABEL,
    DECOY_ID_PREFIX,
    ...DECOY_LABELS,
    ...RENAME_LABELS,
  ]) {
    assert.ok(script.includes(expected), `script mentions ${expected}`);
  }
  const blocking = buildDisruptionScript(
    { hazardType: "blocking_modal", targetRole: "primary-action", durationMs: 5_000, intensity: 1 },
    "blocking-1",
  );
  assert.doesNotMatch(blocking, /dismiss-overlay|Close/);
  assert.match(blocking, /We’re having trouble loading this page/);
  assert.match(blocking, /Please try again in a moment/);
  assert.doesNotMatch(blocking, /Use an in-page DOM recovery action|Inspect the DOM/i);
  assert.match(blocking, /__arenaRecoverDisruptions/);
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

/** A session manager whose CDP session answers with `values`, in order. */
function fakeSessions(values: unknown[]) {
  const expressions: string[] = [];
  let detached = 0;
  const cdp = {
    async send(_method: string, params: { expression: string }) {
      expressions.push(params.expression);
      return { result: { value: values.shift() } };
    },
    async detach() { detached += 1; },
  };
  const sessions = {
    get: () => ({ page: { context: () => ({ newCDPSession: async () => cdp }) } }),
  } as unknown as SteelSessionManager;
  return { sessions, expressions, detached: () => detached };
}

const DECOY: DisruptionCommand = {
  hazardType: "insert_decoy",
  targetRole: "primary-action",
  durationMs: 5_000,
  intensity: 1,
};

test("applies each disruption id once per racer", async () => {
  const fake = fakeSessions([
    { applied: true, disruptionId: "d-1" },
    { applied: true, disruptionId: "d-1" },
  ]);
  const provider = new CdpObstacleProvider(fake.sessions);

  assert.deepEqual(
    await provider.apply("racer-1", { ...DECOY, disruptionId: "d-1" }),
    { applied: true, disruptionId: "d-1" },
  );
  assert.deepEqual(
    await provider.apply("racer-1", { ...DECOY, disruptionId: "d-1" }),
    { applied: false, reason: "already_applied" },
  );
  assert.equal(fake.expressions.length, 1, "the repeat never reached the page");
  assert.equal(fake.detached(), 1);

  // Another racer has its own browser.
  assert.equal((await provider.apply("racer-2", { ...DECOY, disruptionId: "d-1" })).applied, true);
  assert.equal(fake.expressions.length, 2);
});

test("retries a misfire, derives a stable id and rejects malformed CDP responses", async () => {
  const fake = fakeSessions([
    { applied: false, reason: "target_not_found" },
    { applied: true },
    "not a result",
  ]);
  const provider = new CdpObstacleProvider(fake.sessions);

  assert.deepEqual(await provider.apply("racer-1", DECOY), {
    applied: false,
    reason: "target_not_found",
  });
  assert.deepEqual(await provider.apply("racer-1", DECOY), { applied: true });
  assert.match(fake.expressions[0], /disruption-racer-1-insert_decoy-primary-action-5000-1/);
  assert.deepEqual(
    await provider.apply("racer-1", { ...DECOY, disruptionId: "d-2" }),
    { applied: false, reason: "invalid_cdp_response" },
  );
  assert.equal(fake.detached(), 3);
});
