import assert from "node:assert/strict";
import test from "node:test";
import { buildApi } from "../src/api/server.js";
import type {
  BrowserSessionSnapshot,
  SteelBrowserSessionService,
} from "../src/infra/steel-browser-session-service.js";
import {
  DefaultSteelBrowserSessionService,
  validateBrowserUrl,
} from "../src/infra/steel-browser-session-service.js";
import { buildSteelViewerUrl } from "../src/infra/steel-session-manager.js";
import { createFactory } from "./api-fixtures.js";

const liveSnapshot: BrowserSessionSnapshot = {
  sessionId: "session-1",
  status: "live",
  viewerUrl: "https://api.steel.dev/v1/sessions/debug?interactive=false&showControls=false",
  pageUrl: "https://example.com/",
  pageTitle: "Example Domain",
  createdAt: 1,
  updatedAt: 1,
};

test("browser-session routes create, inspect, navigate and release through one service", async () => {
  const calls: string[] = [];
  const service: SteelBrowserSessionService = {
    async create(url) {
      calls.push(`create:${url}`);
      return liveSnapshot;
    },
    async get(sessionId) {
      calls.push(`get:${sessionId}`);
      return liveSnapshot;
    },
    async navigate(sessionId, url) {
      calls.push(`navigate:${sessionId}:${url}`);
      return { ...liveSnapshot, pageUrl: url };
    },
    async release(sessionId) {
      calls.push(`release:${sessionId}`);
      return { ...liveSnapshot, status: "released", viewerUrl: null };
    },
    async releaseAll() {
      calls.push("releaseAll");
    },
  };
  const { factory } = createFactory();
  const app = buildApi({
    coordinatorFactory: factory,
    browserSessionService: service,
    enableTicker: false,
  });

  const created = await app.inject({
    method: "POST",
    url: "/api/browser-sessions",
    payload: { url: "https://example.com/" },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().viewerUrl, liveSnapshot.viewerUrl);

  const inspected = await app.inject({
    method: "GET",
    url: "/api/browser-sessions/session-1",
  });
  assert.equal(inspected.statusCode, 200);

  const navigated = await app.inject({
    method: "POST",
    url: "/api/browser-sessions/session-1/navigate",
    payload: { url: "https://example.org/" },
  });
  assert.equal(navigated.statusCode, 200);
  assert.equal(navigated.json().pageUrl, "https://example.org/");

  const released = await app.inject({
    method: "DELETE",
    url: "/api/browser-sessions/session-1",
  });
  assert.equal(released.statusCode, 200);
  assert.equal(released.json().status, "released");

  await app.close();
  assert.deepEqual(calls, [
    "create:https://example.com/",
    "get:session-1",
    "navigate:session-1:https://example.org/",
    "release:session-1",
    "releaseAll",
  ]);
});

test("browser sessions validate HTTP(S) URLs without requiring a Steel key", async () => {
  assert.doesNotThrow(() => validateBrowserUrl("https://example.com"));
  assert.throws(
    () => validateBrowserUrl("file:///tmp/page.html"),
    /must use http or https/,
  );

  const service = new DefaultSteelBrowserSessionService();
  await assert.rejects(
    service.create("file:///tmp/page.html"),
    /must use http or https/,
  );
});

test("Steel viewer URLs are read-only and hide viewer controls", () => {
  assert.equal(
    buildSteelViewerUrl("https://api.steel.dev/v1/sessions/debug?session_id=one"),
    "https://api.steel.dev/v1/sessions/debug?session_id=one&interactive=false&showControls=false",
  );
});
