import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicCompetitorDecisionModel } from "../src/agents/anthropic-models.js";
import {
  COMPETITOR_TOOL_NAME,
  COMPETITOR_TOOL_SCHEMA,
  DECISION_TYPES,
  describeDecision,
  parseDecision,
} from "../src/agents/competitor-decision.js";
import { OpenRouterCompetitorDecisionModel } from "../src/agents/openrouter-models.js";

const INPUT = {
  task: "Complete the course",
  racerId: "racer-1",
  observation: { url: "https://course.test/", title: "Course", bodyText: "", controls: [] },
  history: [],
};

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

test("parseDecision accepts an optional label on click and type", () => {
  assert.deepEqual(
    parseDecision({ type: "click", targetRole: "primary-action", label: "  Add to\n cart " }),
    { type: "click", targetRole: "primary-action", label: "Add to cart" },
  );
  assert.deepEqual(
    parseDecision({ type: "type", targetRole: "search", text: "4K monitor", label: "Search" }),
    { type: "type", targetRole: "search", text: "4K monitor", label: "Search" },
  );
  // Blank or non-string labels are dropped instead of failing the turn.
  for (const label of ["", "   ", null, 7, { text: "x" }]) {
    assert.deepEqual(
      parseDecision({ type: "click", targetRole: "primary-action", label }),
      { type: "click", targetRole: "primary-action" },
    );
  }
  // Over-long labels are truncated; they still match by substring.
  const long = parseDecision({ type: "click", targetRole: "primary-action", label: "a".repeat(300) });
  assert.equal(long.type === "click" ? long.label?.length : 0, 120);
  // Other decision types ignore it.
  assert.deepEqual(parseDecision({ type: "inspect", label: "x" }), { type: "inspect" });
});

test("the tool schema enumerates every decision type and offers a label", () => {
  assert.deepEqual(COMPETITOR_TOOL_SCHEMA.properties.type.enum, [...DECISION_TYPES]);
  assert.deepEqual(COMPETITOR_TOOL_SCHEMA.required, ["type"]);
  const label = COMPETITOR_TOOL_SCHEMA.properties.label;
  assert.equal(label.type, "string");
  assert.equal(label.maxLength, 120);
  assert.match(String(label.description), /visible label/);
});

test("describeDecision produces spectator log text", () => {
  assert.equal(describeDecision({ type: "click", targetRole: "add-to-cart" }), 'Clicked "add-to-cart"');
  assert.equal(
    describeDecision({ type: "click", targetRole: "primary-action", label: "Add to cart" }),
    'Clicked "Add to cart" (primary-action)',
  );
  assert.equal(
    describeDecision({ type: "type", targetRole: "search", text: "4K monitor" }),
    'Typed "4K monitor" into search',
  );
  assert.equal(
    describeDecision({ type: "type", targetRole: "search", text: "4K monitor", label: "Search products" }),
    'Typed "4K monitor" into "Search products" (search)',
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

test("the Anthropic adapter sends the shared schema and parses a label", async () => {
  const model = new AnthropicCompetitorDecisionModel({ apiKey: "test-key", model: "claude-test" });
  let request: { tools: Array<{ name: string; input_schema: unknown }> } | undefined;
  const client = (model as unknown as {
    client: { messages: { create: (body: unknown) => Promise<unknown> } };
  }).client;
  client.messages.create = async (body) => {
    request = body as typeof request;
    return {
      content: [{
        type: "tool_use",
        id: "tool-1",
        name: COMPETITOR_TOOL_NAME,
        input: { type: "click", targetRole: "primary-action", label: "Add to cart" },
      }],
    };
  };

  const decision = await model.decide(INPUT);
  assert.deepEqual(decision, { type: "click", targetRole: "primary-action", label: "Add to cart" });
  assert.equal(request?.tools[0].name, COMPETITOR_TOOL_NAME);
  assert.deepEqual(request?.tools[0].input_schema, COMPETITOR_TOOL_SCHEMA);
});

test("the OpenRouter adapter sends the shared schema and parses a label", async () => {
  const model = new OpenRouterCompetitorDecisionModel({ apiKey: "test-key", model: "openai/gpt-test" });
  let request: { tools: Array<{ function: { name: string; parameters: unknown } }> } | undefined;
  const client = (model as unknown as {
    client: { chat: { completions: { create: (body: unknown) => Promise<unknown> } } };
  }).client;
  client.chat.completions.create = async (body) => {
    request = body as typeof request;
    return {
      usage: { cost: 0 },
      choices: [{
        message: {
          tool_calls: [{
            type: "function",
            function: {
              name: COMPETITOR_TOOL_NAME,
              arguments: JSON.stringify({
                type: "type",
                targetRole: "search",
                text: "monitor",
                label: "Search products",
              }),
            },
          }],
        },
      }],
    };
  };

  const decision = await model.decide(INPUT);
  assert.deepEqual(decision, {
    type: "type",
    targetRole: "search",
    text: "monitor",
    label: "Search products",
  });
  assert.equal(request?.tools[0].function.name, COMPETITOR_TOOL_NAME);
  assert.deepEqual(request?.tools[0].function.parameters, COMPETITOR_TOOL_SCHEMA);
});
