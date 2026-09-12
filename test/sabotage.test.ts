import assert from "node:assert/strict";
import test from "node:test";
import {
  HAZARD_TYPES,
  describeHazard,
  describeHazardDetail,
  sabotagePlaceholder,
  tierForPolicy,
} from "../src/domain/sabotage.js";
import type { DisruptionCommand } from "../src/domain/types.js";

const chosen: DisruptionCommand = {
  hazardType: "insert_decoy",
  targetRole: "checkout-submit",
  durationMs: 6_000,
  intensity: 2,
};

test("tierForPolicy maps intensity to a sabotage tier", () => {
  assert.equal(tierForPolicy({ ...chosen, intensity: 1 }), "basic");
  assert.equal(tierForPolicy(chosen), "intermediate");
  assert.equal(tierForPolicy({ ...chosen, intensity: 3 }), "difficult");
});

test("describes hazards in at most 70 characters", () => {
  assert.equal(
    describeHazard(
      { hazardType: "blocking_modal", targetRole: "primary-action", durationMs: 4_000, intensity: 1 },
      "Checkout",
    ),
    "Blocking modal covers the page at Checkout",
  );
  for (const hazardType of HAZARD_TYPES) {
    const summary = describeHazard({ ...chosen, hazardType }, "Checkout");
    assert.ok(summary.length <= 70, summary);
    assert.match(summary, /Checkout$/);
  }
  assert.match(describeHazard(chosen, "Checkout"), /checkout submit/);

  const long = describeHazard(chosen, "A".repeat(100));
  assert.equal(long.length, 70);
  assert.ok(long.endsWith("…"));

  assert.ok(describeHazardDetail(chosen, "Checkout").length <= 280);
  assert.match(describeHazardDetail(chosen, "Checkout"), /6s/);
  assert.equal(sabotagePlaceholder("Checkpoint 2"), "Sabotage armed at Checkpoint 2");
  assert.equal(sabotagePlaceholder("B".repeat(80)).length, 70);
});
