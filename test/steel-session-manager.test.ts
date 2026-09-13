import assert from "node:assert/strict";
import test from "node:test";
import type { Browser } from "playwright";
import type Steel from "steel-sdk";
import { DEFAULT_ABSOLUTE_DURATION_MS } from "../src/domain/race-engine.js";
import {
  MIN_STEEL_SESSION_TIMEOUT_SECONDS,
  raceSessionTimeoutSeconds,
  STEEL_SESSION_MARGIN_SECONDS,
  SteelSessionManager,
} from "../src/infra/steel-session-manager.js";

/** A Steel client that records the options each session was created with. */
function fakeSteel() {
  const created: Array<{ timeout?: number }> = [];
  const client = {
    sessions: {
      async create(options: { timeout?: number }) {
        created.push(options);
        const id = `steel-session-${created.length}`;
        return {
          id,
          websocketUrl: `wss://connect.steel.dev?sessionId=${id}`,
          debugUrl: `https://app.steel.dev/sessions/${id}/debug`,
        };
      },
      async release() {
        return {};
      },
    },
  } as unknown as Steel;
  const page = {};
  const browser = {
    contexts: () => [{ pages: () => [page], newPage: async () => page }],
    close: async () => undefined,
  } as unknown as Browser;
  return { created, client, browser };
}

function manager(sessionTimeoutSeconds?: number) {
  const steel = fakeSteel();
  const sessions = new SteelSessionManager({
    apiKeys: ["key-a"],
    ...(sessionTimeoutSeconds === undefined ? {} : { sessionTimeoutSeconds }),
    createClient: () => steel.client,
    connectOverCDP: async () => steel.browser,
  });
  return { sessions, created: steel.created };
}

test("race sessions outlive the race's safety cap by the preparation margin", async () => {
  // In shop-mtzaxsks-cacac3 the sessions started 2.5-3.2 s after the race's
  // start time and Steel closed them 240 s later, inside the 300 s cap: racer-3
  // died at 243.9 s with "Target page, context or browser has been closed".
  const { sessions, created } = manager(raceSessionTimeoutSeconds(300_000));
  await sessions.create("racer-3");
  const timeoutMs = created[0]?.timeout ?? 0;
  assert.equal(timeoutMs, 480_000);
  assert.ok(timeoutMs >= 300_000 + STEEL_SESSION_MARGIN_SECONDS * 1_000);

  // Without an explicit timeout the manager still outlives the default race.
  const fallback = manager();
  await fallback.sessions.create("racer-1");
  assert.ok((fallback.created[0]?.timeout ?? 0) > DEFAULT_ABSOLUTE_DURATION_MS + 60_000);
});

test("the Steel timeout always exceeds the race's absolute duration, with a floor", () => {
  for (const absoluteMs of [1, 30_000, 240_000, 300_000, 301_500, 600_000, 3_600_000]) {
    const seconds = raceSessionTimeoutSeconds(absoluteMs);
    assert.ok(seconds * 1_000 >= absoluteMs + STEEL_SESSION_MARGIN_SECONDS * 1_000, `${absoluteMs} ms`);
    assert.ok(seconds >= MIN_STEEL_SESSION_TIMEOUT_SECONDS, `${absoluteMs} ms`);
  }
  // A race without its own cap runs the engine's default one.
  assert.equal(raceSessionTimeoutSeconds(), raceSessionTimeoutSeconds(DEFAULT_ABSOLUTE_DURATION_MS));
  assert.equal(raceSessionTimeoutSeconds(Number.NaN), raceSessionTimeoutSeconds());
});
