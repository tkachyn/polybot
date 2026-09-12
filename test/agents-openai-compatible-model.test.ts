import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicCompetitorDecisionModel } from "../src/agents/anthropic-models.js";
import {
  OpenAICompatibleCompetitorDecisionModel,
  OPENAI_COMPATIBLE_PRESETS,
  createCompetitorModel,
} from "../src/agents/openai-compatible-model.js";
import type { CompetitorDecisionInput } from "../src/agents/competitor-decision.js";

type Captured = { url: string; init: RequestInit };

const INPUT: CompetitorDecisionInput = {
  task: "Buy a monitor",
  racerId: "racer-1",
  observation: { url: "https://course.test/", title: "Course", bodyText: "", controls: [] },
  history: [],
};

function toolResponse(args: unknown): Response {
  return Response.json({
    choices: [{
      message: {
        tool_calls: [{
          type: "function",
          function: { name: "take_browser_action", arguments: args },
        }],
      },
    }],
  });
}

async function withFetch<T>(
  respond: (captured: Captured) => Response | Promise<Response>,
  body: (calls: Captured[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const captured = { url: String(url), init: init ?? {} };
    calls.push(captured);
    return respond(captured);
  }) as typeof fetch;
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function model(options: Partial<ConstructorParameters<typeof OpenAICompatibleCompetitorDecisionModel>[0]> = {}) {
  return new OpenAICompatibleCompetitorDecisionModel({
    baseUrl: "https://llm.test/v1/",
    apiKey: "sk-test",
    model: "gpt-test",
    ...options,
  });
}

test("posts a forced tool call and parses the decision", async () => {
  await withFetch(
    () => toolResponse(JSON.stringify({ type: "click", targetRole: "add-to-cart" })),
    async (calls) => {
      const decision = await model().decide(INPUT);
      assert.deepEqual(decision, { type: "click", targetRole: "add-to-cart" });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://llm.test/v1/chat/completions");
      assert.equal(calls[0].init.method, "POST");
      const headers = calls[0].init.headers as Record<string, string>;
      assert.equal(headers.authorization, "Bearer sk-test");
      assert.equal(headers["content-type"], "application/json");
      assert.ok(calls[0].init.signal instanceof AbortSignal);

      const body = JSON.parse(String(calls[0].init.body));
      assert.equal(body.model, "gpt-test");
      assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ["system", "user"]);
      assert.deepEqual(JSON.parse(body.messages[1].content), INPUT);
      assert.equal(body.tools.length, 1);
      assert.equal(body.tools[0].type, "function");
      assert.equal(body.tools[0].function.name, "take_browser_action");
      assert.equal(body.tools[0].function.parameters.additionalProperties, false);
      assert.deepEqual(body.tool_choice, {
        type: "function",
        function: { name: "take_browser_action" },
      });
    },
  );
});

test("loose schema and required tool choice for picky endpoints", async () => {
  await withFetch(
    () => toolResponse({ type: "finish" }),
    async (calls) => {
      const decision = await model({ toolChoice: "required", looseSchema: true }).decide(INPUT);
      assert.deepEqual(decision, { type: "finish" });
      const body = JSON.parse(String(calls[0].init.body));
      assert.equal(body.tool_choice, "required");
      assert.equal("additionalProperties" in body.tools[0].function.parameters, false);
    },
  );
});

test("throws clear errors for HTTP failures and malformed responses", async () => {
  await withFetch(
    () => new Response('{"error":{"message":"bad key"}}', { status: 401 }),
    async () => {
      await assert.rejects(model({ label: "OpenAI" }).decide(INPUT), /OpenAI request failed with HTTP 401: .*bad key/);
    },
  );
  await withFetch(
    () => Response.json({ choices: [{ message: { content: "hi" } }] }),
    async () => {
      await assert.rejects(model().decide(INPUT), /did not call take_browser_action/);
    },
  );
  await withFetch(
    () => toolResponse("{not json"),
    async () => {
      await assert.rejects(model().decide(INPUT), /invalid tool arguments JSON/);
    },
  );
  await withFetch(
    () => toolResponse(JSON.stringify({ type: "click" })),
    async () => {
      await assert.rejects(model().decide(INPUT), /click requires targetRole/);
    },
  );
  await withFetch(
    () => { throw new TypeError("connect ECONNREFUSED"); },
    async () => {
      await assert.rejects(model().decide(INPUT), /request failed: connect ECONNREFUSED/);
    },
  );
});

test("createCompetitorModel maps providers to presets and keys", async () => {
  const env = {
    OPENAI_API_KEY: "sk-openai",
    GEMINI_API_KEY: "gm-key",
    XAI_API_KEY: "xai-key",
    ANTHROPIC_API_KEY: "sk-ant",
  };
  const expectations = [
    { provider: "openai", url: "https://api.openai.com/v1/chat/completions", key: "sk-openai" },
    {
      provider: "google",
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      key: "gm-key",
    },
    { provider: "xai", url: "https://api.x.ai/v1/chat/completions", key: "xai-key" },
  ];
  await withFetch(
    () => toolResponse({ type: "inspect" }),
    async (calls) => {
      for (const expected of expectations) {
        const created = createCompetitorModel({ provider: expected.provider, model: "m-1", env });
        assert.ok(created instanceof OpenAICompatibleCompetitorDecisionModel);
        await created.decide(INPUT);
        const call = calls.at(-1)!;
        assert.equal(call.url, expected.url);
        assert.equal((call.init.headers as Record<string, string>).authorization, `Bearer ${expected.key}`);
        assert.equal(JSON.parse(String(call.init.body)).model, "m-1");
      }
    },
  );
  assert.equal(OPENAI_COMPATIBLE_PRESETS.google.apiKeyEnv, "GEMINI_API_KEY");

  const anthropic = createCompetitorModel({ provider: "anthropic", model: "claude-test", env });
  assert.ok(anthropic instanceof AnthropicCompetitorDecisionModel);
});

test("createCompetitorModel rejects missing keys, models and unknown providers", () => {
  assert.throws(
    () => createCompetitorModel({ provider: "xai", model: "grok", env: {} }),
    /XAI_API_KEY is required for provider xai/,
  );
  assert.throws(
    () => createCompetitorModel({ provider: "anthropic", model: "claude", env: {} }),
    /ANTHROPIC_API_KEY is required/,
  );
  assert.throws(
    () => createCompetitorModel({ provider: "openai", model: "", env: { OPENAI_API_KEY: "k" } }),
    /A model is required for provider openai/,
  );
  assert.throws(
    () => createCompetitorModel({ provider: "mistral", model: "m", env: {} }),
    /Unsupported competitor provider "mistral"/,
  );
});
