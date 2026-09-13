import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicCompetitorDecisionModel } from "../src/agents/anthropic-models.js";
import {
  COMPETITOR_SYSTEM_PROMPT,
  COMPETITOR_TOOL_NAME,
  COMPETITOR_TOOL_SCHEMA,
  DECISION_TYPES,
  REASONING_MAX_LENGTH,
  competitorPromptInput,
  competitorUserMessage,
  datasetAction,
  describeDecision,
  normalizeReasoning,
  parseDecision,
  withoutReasoning,
} from "../src/agents/competitor-decision.js";
import {
  OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS,
  OpenRouterCompetitorDecisionModel,
} from "../src/agents/openrouter-models.js";

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
  assert.deepEqual(parseDecision({ type: "evaluate", script: "window.__arenaRecoverDisruptions?.()" }), {
    type: "evaluate",
    script: "window.__arenaRecoverDisruptions?.()",
  });
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
  assert.equal(COMPETITOR_TOOL_SCHEMA.properties.script.maxLength, 2_000);
});

test("the tool offers a one-sentence reasoning and the prompt asks for it", () => {
  const reasoning = COMPETITOR_TOOL_SCHEMA.properties.reasoning;
  assert.equal(reasoning.type, "string");
  assert.equal(reasoning.maxLength, 400);
  assert.equal(reasoning.description, "One short sentence: why you chose this action.");
  assert.deepEqual(COMPETITOR_TOOL_SCHEMA.required, ["type"], "reasoning stays optional");
  assert.match(COMPETITOR_SYSTEM_PROMPT, /one-sentence reasoning/);
});

test("parseDecision keeps the reasoning on any decision, collapsed and clipped", () => {
  assert.deepEqual(
    parseDecision({ type: "click", targetRole: "primary-action", reasoning: "  The label\n matches the task. " }),
    { type: "click", targetRole: "primary-action", reasoning: "The label matches the task." },
  );
  assert.deepEqual(parseDecision({ type: "finish", reasoning: "All done." }), { type: "finish", reasoning: "All done." });
  // A blank or non-string reasoning is dropped instead of failing the turn.
  for (const reasoning of ["", "   ", null, 42, { why: "x" }]) {
    assert.deepEqual(parseDecision({ type: "inspect", reasoning }), { type: "inspect" });
  }
  const long = parseDecision({ type: "wait", durationMs: 500, reasoning: `${"r".repeat(399)} tail` });
  assert.equal(long.reasoning, "r".repeat(399));
  assert.equal(REASONING_MAX_LENGTH, 400);
  assert.equal(normalizeReasoning("  a \t b  "), "a b");
});

test("history, signatures and dataset actions leave the reasoning out", () => {
  const decision = parseDecision({
    type: "type",
    targetRole: "search",
    text: "1 TB SSD",
    label: "Search",
    reasoning: "Search first.",
  });
  assert.deepEqual(withoutReasoning(decision), { type: "type", targetRole: "search", text: "1 TB SSD", label: "Search" });
  assert.equal(decision.reasoning, "Search first.", "the original decision is untouched");
  assert.deepEqual(datasetAction(decision), {
    type: "type",
    targetRole: "search",
    label: "Search",
    text: "1 TB SSD",
    textLength: 8,
  });
  assert.deepEqual(datasetAction(decision, { redactText: true }), {
    type: "type",
    targetRole: "search",
    label: "Search",
    text: "[redacted]",
    textLength: 8,
  });
  assert.deepEqual(datasetAction({ type: "evaluate", script: "x()", reasoning: "r" }), { type: "evaluate", script: "x()" });
  assert.deepEqual(datasetAction({ type: "checkpoint", checkpoint: 2 }), { type: "checkpoint", checkpoint: 2 });
  assert.deepEqual(datasetAction({ type: "navigate", url: "/cart" }), { type: "navigate", url: "/cart" });
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
  assert.equal(
    describeDecision({ type: "evaluate", script: "window.__arenaRecoverDisruptions?.()" }),
    "Evaluated a bounded same-page DOM recovery script",
  );
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
        input: { type: "click", targetRole: "primary-action", label: "Add to cart", reasoning: "It is the next step." },
      }],
    };
  };

  const decision = await model.decide(INPUT);
  assert.deepEqual(decision, {
    type: "click",
    targetRole: "primary-action",
    label: "Add to cart",
    reasoning: "It is the next step.",
  });
  assert.equal(request?.tools[0].name, COMPETITOR_TOOL_NAME);
  assert.deepEqual(request?.tools[0].input_schema, COMPETITOR_TOOL_SCHEMA);
  const schema = request?.tools[0].input_schema as { properties: Record<string, unknown> } | undefined;
  assert.ok(schema?.properties.reasoning, "the adapter offers the reasoning field");
});

test("the OpenRouter adapter sends the shared schema and parses a label", async () => {
  const model = new OpenRouterCompetitorDecisionModel({ apiKey: "test-key", model: "openai/gpt-test" });
  let request: { max_tokens?: number; tools: Array<{ function: { name: string; parameters: unknown } }> } | undefined;
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
                reasoning: "Searching narrows the catalogue.",
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
    reasoning: "Searching narrows the catalogue.",
  });
  assert.equal(request?.tools[0].function.name, COMPETITOR_TOOL_NAME);
  assert.deepEqual(request?.tools[0].function.parameters, COMPETITOR_TOOL_SCHEMA);
  // Room for the whole tool call, reasoning included: truncated arguments cannot be parsed.
  assert.equal(request?.max_tokens, OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS, 400);
});

test("adapters send only the task, racer, observation and history; the signal goes to the request", async () => {
  const controller = new AbortController();
  const input = {
    ...INPUT,
    history: [{ decision: { type: "click" as const, targetRole: "primary-action", reasoning: "It is next." } }],
    signal: controller.signal,
  };
  const expected = {
    task: INPUT.task,
    racerId: INPUT.racerId,
    observation: INPUT.observation,
    history: [{ decision: { type: "click", targetRole: "primary-action" } }],
  };
  assert.deepEqual(competitorPromptInput(input), expected);
  assert.equal(competitorUserMessage(input), JSON.stringify(expected));

  const anthropic = new AnthropicCompetitorDecisionModel({ apiKey: "test-key", model: "claude-test" });
  let anthropicBody: { messages: Array<{ content: string }> } | undefined;
  let anthropicOptions: { signal?: AbortSignal } | undefined;
  (anthropic as unknown as {
    client: { messages: { create: (body: unknown, options?: unknown) => Promise<unknown> } };
  }).client.messages.create = async (body, options) => {
    anthropicBody = body as typeof anthropicBody;
    anthropicOptions = options as typeof anthropicOptions;
    return { content: [{ type: "tool_use", id: "tool-1", name: COMPETITOR_TOOL_NAME, input: { type: "inspect" } }] };
  };
  await anthropic.decide(input);

  const openRouter = new OpenRouterCompetitorDecisionModel({ apiKey: "test-key", model: "openai/gpt-test" });
  let openRouterBody: { messages: Array<{ role: string; content: string }> } | undefined;
  let openRouterOptions: { signal?: AbortSignal } | undefined;
  (openRouter as unknown as {
    client: { chat: { completions: { create: (body: unknown, options?: unknown) => Promise<unknown> } } };
  }).client.chat.completions.create = async (body, options) => {
    openRouterBody = body as typeof openRouterBody;
    openRouterOptions = options as typeof openRouterOptions;
    return {
      usage: { cost: 0 },
      choices: [{
        message: {
          tool_calls: [{
            type: "function",
            function: { name: COMPETITOR_TOOL_NAME, arguments: JSON.stringify({ type: "inspect" }) },
          }],
        },
      }],
    };
  };
  await openRouter.decide(input);

  const sent = [
    anthropicBody?.messages[0].content,
    openRouterBody?.messages.find((message) => message.role === "user")?.content,
  ];
  for (const content of sent) {
    assert.equal(content, JSON.stringify(expected));
    const parsed = JSON.parse(content ?? "{}") as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ["task", "racerId", "observation", "history"]);
    assert.ok(!("signal" in parsed), "the abort signal never reaches the prompt");
  }
  assert.equal(anthropicOptions?.signal, controller.signal);
  assert.equal(openRouterOptions?.signal, controller.signal);
});
