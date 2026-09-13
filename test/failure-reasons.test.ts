import assert from "node:assert/strict";
import test from "node:test";
import { closeReasonText, failureCause, failureProblem } from "../src/domain/failure-reasons.js";

test("raw failure reasons map to short readable causes", () => {
  const cases: Array<[string, string]> = [
    // The engine's recovery gate.
    ["racer-1 cannot reach a checkpoint while recovering", "stopped while a sabotage still blocked it"],
    ["racer-3 cannot finish while recovering", "stopped while a sabotage still blocked it"],
    // Model provider: rate limits first, even when wrapped by the runner's retry error.
    ["429 Rate limit exceeded: new-account-rpm/openai/gpt-5.6-luna", "stopped after its model provider rate-limited it"],
    [
      "racer-2 model decision failed after 3 provider/protocol retries: 429 Rate limit exceeded: new-account-rpm/x",
      "stopped after its model provider rate-limited it",
    ],
    ["Too Many Requests", "stopped after its model provider rate-limited it"],
    ["OpenRouter race budget of $5.00 was exhausted", "stopped when the fight's model budget ran out"],
    [
      "OpenRouter model openai/gpt-5.6-luna did not call take_browser_action",
      "stopped when its model returned no usable action",
    ],
    [
      "racer-4 model decision failed after 6 provider/protocol retries: OpenRouter returned invalid tool arguments",
      "stopped when its model returned no usable action",
    ],
    ["Anthropic response did not call take_browser_action", "stopped when its model returned no usable action"],
    ["racer-1 model decision failed after 3 provider/protocol retries: 502 Bad gateway", "stopped after its model provider failed"],
    ["model crashed", "stopped after its model provider failed"],
    ["No competitor model is configured for racer-2", "stopped after its model provider failed"],
    // Runner and browser.
    ["racer-4 exceeded 20 actions", "stopped after using its whole step budget"],
    ["simulated agent crashed: browser context lost", "stopped when its browser crashed"],
    ["browser context lost", "stopped when its browser crashed"],
    ["page.goto: Target page, context or browser has been closed", "stopped when its browser crashed"],
    ["Page crashed", "stopped when its browser crashed"],
    ["No active Steel session for racer-2", "stopped when its browser session was lost"],
    ["locator.click: Timeout 30000ms exceeded.", "stopped after a browser error"],
    ["page.goto: net::ERR_NAME_NOT_RESOLVED at https://shop.test/", "stopped after a browser error"],
    // Progress and lifecycle.
    ["racer-1 must reach checkpoint 3 next", "stopped when its progress could not be verified"],
    ["Course state request failed with 503", "stopped when its progress could not be verified"],
    ["competitor runner exited before completion", "stopped when its agent quit early"],
    ["Unknown racer: racer-9", "stopped after an unexpected error"],
  ];
  for (const [reason, cause] of cases) {
    assert.equal(failureCause(reason), cause, reason);
  }
  for (const reason of [null, undefined, "", "   "]) {
    assert.equal(failureCause(reason), null);
  }
});

test("readable causes never carry raw error text or racer ids", () => {
  const reasons = [
    "racer-1 cannot reach a checkpoint while recovering",
    "429 Rate limit exceeded: new-account-rpm/openai/gpt-5.6-luna",
    "OpenRouter model openai/gpt-5.6-luna did not call take_browser_action",
    "racer-4 exceeded 20 actions",
    "something nobody anticipated for racer-2",
  ];
  for (const reason of reasons) {
    const cause = failureCause(reason);
    assert.ok(cause, reason);
    assert.doesNotMatch(cause, /racer-\d|\d{3}|openrouter|recovering|take_browser_action/i, reason);
    assert.match(cause, /^stopped (?:after|when|while) /);
  }
});

test("close reasons read as plain log lines", () => {
  assert.equal(closeReasonText("absolute_deadline"), "Timed out at the safety cap");
  assert.equal(closeReasonText("all_racers_failed"), "Stopped: every agent failed");
  assert.equal(closeReasonText("start_failed"), "Stopped: the fight could not start");
  assert.equal(closeReasonText("some_new_reason"), "Stopped early");
  assert.equal(closeReasonText(undefined), "Stopped early");
});

test("retry notes get a short problem phrase, never the raw error", () => {
  assert.equal(
    failureProblem("429 Rate limit exceeded: new-account-rpm/openai/gpt-5.6-luna-20260709. Rate limit reached"),
    "the model provider rate-limited it",
  );
  assert.equal(failureProblem("OpenRouter race budget of $0.25 was exhausted"), "the fight's model budget ran out");
  assert.equal(
    failureProblem("OpenRouter model deepseek/deepseek-v4.1-flash did not call take_browser_action"),
    "the model returned no usable action",
  );
  assert.equal(failureProblem("page.title: Target page, context or browser has been closed"), "the browser crashed");
  assert.equal(failureProblem("something nobody anticipated"), "an unexpected error");
  assert.equal(failureProblem("  "), null);
});
