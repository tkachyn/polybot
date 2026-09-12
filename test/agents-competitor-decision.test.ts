import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPETITOR_TOOL_SCHEMA,
  DECISION_TYPES,
  describeDecision,
  parseDecision,
} from "../src/agents/competitor-decision.js";

test("parseDecision validates each decision type", () => {
  assert.deepEqual(parseDecision({ type: "click", targetRole: "add-to-cart" }), {
    type: "click",
    targetRole: "add-to-cart",
  });
  assert.deepEqual(parseDecision({ type: "finish", extra: 1 }), { type: "finish" });
  assert.throws(() => parseDecision({ type: "click" }), /click requires targetRole/);
  assert.throws(() => parseDecision({ type: "teleport" }), /Unsupported competitor decision/);
  assert.throws(() => parseDecision(null), /Invalid competitor decision/);
});

test("the tool schema enumerates every decision type", () => {
  assert.deepEqual(COMPETITOR_TOOL_SCHEMA.properties.type.enum, [...DECISION_TYPES]);
  assert.deepEqual(COMPETITOR_TOOL_SCHEMA.required, ["type"]);
});

test("describeDecision produces spectator log text", () => {
  assert.equal(describeDecision({ type: "click", targetRole: "add-to-cart" }), 'Clicked "add-to-cart"');
  assert.equal(
    describeDecision({ type: "type", targetRole: "search", text: "4K monitor" }),
    'Typed "4K monitor" into search',
  );
  assert.equal(describeDecision({ type: "navigate", url: "/cart" }), "Navigated to /cart");
  assert.equal(
    describeDecision({ type: "navigate", url: "https://shop.test/cart?step=2" }),
    "Navigated to shop.test/cart?step=2",
  );
  assert.equal(describeDecision({ type: "checkpoint", checkpoint: 2 }), "Reported checkpoint 2");
  assert.equal(describeDecision({ type: "wait", durationMs: 500 }), "Waited 500ms");
  assert.equal(describeDecision({ type: "finish" }), "Reported finish");
  const long = describeDecision({ type: "type", targetRole: "q", text: "x".repeat(200) });
  assert.ok(long.length < 60);
  assert.match(long, /…" into q$/);
});
