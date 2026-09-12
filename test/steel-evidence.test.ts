import assert from "node:assert/strict";
import test from "node:test";
import type { Browser } from "playwright";
import type Steel from "steel-sdk";
import {
  STEEL_TRACE_LIMIT,
  collectSteelEvidence,
  fetchSteelAgentTraces,
  fetchSteelHlsPlaylist,
  normalizeSteelTraceEvent,
  parseHlsReplayStart,
  parseSteelTimestamp,
} from "../src/infra/steel-evidence.js";
import { SteelSessionManager } from "../src/infra/steel-session-manager.js";

const credentials = { steelSessionId: "3f1c-session", apiKey: "ste-secret-key" };

// Shapes confirmed against a real released session.
const clickOnDecoy = {
  timestamp: "2026-09-12T21:11:17.874Z",
  type: "click",
  page: { url: "https://course.test/shipping", title: "Shipping" },
  target: {
    tagName: "BUTTON",
    role: "button",
    accessibleName: "Continue",
    text: "Continue",
    attributes: { id: "arena-decoy-2", class: "btn primary" },
    selector: { css: "#arena-decoy-2", id: "arena-decoy-2" },
    boundingBox: { x: 10, y: 20, width: 100, height: 30 },
  },
};
const navigate = {
  timestamp: "2026-09-12T21:11:11.990Z",
  type: "navigate",
  navigation: { url: "https://course.test/cart" },
};
const clickReal = {
  timestamp: "2026-09-12T21:11:19.100Z",
  type: "click",
  page: { url: "https://course.test/shipping" },
  target: {
    tagName: "BUTTON",
    role: "button",
    accessibleName: "",
    text: "  Place\n order ",
    attributes: { id: "place-order" },
    selector: { css: "button.primary", id: "place-order" },
  },
};

const PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:6",
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXT-X-PROGRAM-DATE-TIME:2026-09-12T21:11:11.610710862Z",
  "#EXTINF:6.000,",
  "https://storage.steel.dev/recordings/3f1c/segment-0.ts?X-Amz-Signature=abc",
  "#EXT-X-PROGRAM-DATE-TIME:2026-09-12T21:11:17.610710862Z",
  "#EXTINF:6.000,",
  "https://storage.steel.dev/recordings/3f1c/segment-1.ts?X-Amz-Signature=def",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

type Call = { url: URL; headers: Record<string, string> };

function mockFetch(handler: (url: URL) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return handler(url);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("normalises Agent Traces events and recognises decoys by their target id", () => {
  assert.deepEqual(normalizeSteelTraceEvent(clickOnDecoy), {
    at: Date.parse("2026-09-12T21:11:17.874Z"),
    type: "click",
    label: "Continue",
    role: "button",
    selector: "#arena-decoy-2",
    url: "https://course.test/shipping",
    decoy: true,
  });
  assert.deepEqual(normalizeSteelTraceEvent(navigate), {
    at: Date.parse("2026-09-12T21:11:11.990Z"),
    type: "navigate",
    label: null,
    role: null,
    selector: null,
    url: "https://course.test/cart",
    decoy: false,
  });
  // An empty accessible name falls back to the visible text.
  assert.equal(normalizeSteelTraceEvent(clickReal)?.label, "Place order");
  assert.equal(normalizeSteelTraceEvent(clickReal)?.decoy, false);
  assert.equal(normalizeSteelTraceEvent(null), null);
  assert.equal(normalizeSteelTraceEvent({ type: "click" }), null);
  assert.equal(normalizeSteelTraceEvent({ timestamp: "yesterday", type: "click" }), null);
});

test("parses nanosecond HLS program dates into the replay start", () => {
  assert.equal(parseSteelTimestamp("2026-09-12T21:11:11.610710862Z"), Date.parse("2026-09-12T21:11:11.610Z"));
  assert.equal(parseSteelTimestamp("2026-09-12T21:11:11Z"), Date.parse("2026-09-12T21:11:11.000Z"));
  assert.equal(parseSteelTimestamp("2026-09-12T23:11:11.5+02:00"), Date.parse("2026-09-12T21:11:11.500Z"));
  assert.equal(parseSteelTimestamp("not a date"), null);
  assert.equal(parseHlsReplayStart(PLAYLIST), Date.parse("2026-09-12T21:11:11.610Z"));
  assert.equal(parseHlsReplayStart("#EXTM3U\n#EXTINF:6.0,\nsegment.ts\n"), null);
});

test("pages through agent traces with startTime after the last event, using the creating key", async () => {
  const pageOne = { events: [navigate, clickOnDecoy], total: 3, hasMore: true };
  const pageTwo = { events: [clickReal], total: 3, hasMore: false };
  const { fetchImpl, calls } = mockFetch((url) =>
    Response.json(url.searchParams.has("startTime") ? pageTwo : pageOne));
  const trace = await fetchSteelAgentTraces(credentials, { fetch: fetchImpl });

  assert.deepEqual(trace?.map((entry) => [entry.type, entry.decoy]), [
    ["navigate", false],
    ["click", true],
    ["click", false],
  ]);
  assert.equal(calls.length, 2);
  assert.equal(`${calls[0].url.origin}${calls[0].url.pathname}`, "https://api.steel.dev/v1/sessions/3f1c-session/agent-traces");
  assert.equal(calls[0].url.searchParams.get("startTime"), null);
  assert.equal(calls[1].url.searchParams.get("startTime"), "2026-09-12T21:11:17.875Z");
  for (const call of calls) {
    assert.equal(call.headers["steel-api-key"], "ste-secret-key");
    assert.ok(!call.url.toString().includes("ste-secret-key"), "the key never travels in the URL");
  }
});

test("caps agent traces at 300 events, oldest first", async () => {
  const base = Date.parse("2026-09-12T21:00:00.000Z");
  const { fetchImpl, calls } = mockFetch((url) => {
    const start = url.searchParams.get("startTime");
    const from = start ? Date.parse(start) : base;
    const events = Array.from({ length: 200 }, (_, index) => ({
      timestamp: new Date(from + index).toISOString(),
      type: "scroll",
    }));
    return Response.json({ events, total: 1_000, hasMore: true });
  });
  const trace = await fetchSteelAgentTraces(credentials, { fetch: fetchImpl });
  assert.equal(trace?.length, STEEL_TRACE_LIMIT);
  assert.equal(calls.length, 2);
  assert.equal(trace?.[0].at, base);
  assert.ok(trace?.every((entry, index) => index === 0 || entry.at >= trace[index - 1].at));
});

test("trace failures resolve to null and malformed events are skipped", async () => {
  const notFound = mockFetch(() => Response.json({ error: "session not found" }, { status: 404 }));
  assert.equal(await fetchSteelAgentTraces(credentials, { fetch: notFound.fetchImpl }), null);
  const offline = (async () => {
    throw new Error("getaddrinfo ENOTFOUND api.steel.dev");
  }) as typeof fetch;
  assert.equal(await fetchSteelAgentTraces(credentials, { fetch: offline }), null);
  const html = mockFetch(() => new Response("<html>oops</html>", { status: 200 }));
  assert.equal(await fetchSteelAgentTraces(credentials, { fetch: html.fetchImpl }), null);
  const mixed = mockFetch(() => Response.json({ events: [{ type: "click" }, 42, navigate], hasMore: false }));
  assert.deepEqual((await fetchSteelAgentTraces(credentials, { fetch: mixed.fetchImpl }))?.map((entry) => entry.type), ["navigate"]);
  assert.equal(await fetchSteelAgentTraces({ steelSessionId: "", apiKey: "k" }, { fetch: mixed.fetchImpl }), null);
});

test("fetches the HLS playlist with the creating key; null when there is none", async () => {
  const { fetchImpl, calls } = mockFetch(() =>
    new Response(PLAYLIST, { headers: { "content-type": "application/vnd.apple.mpegurl" } }));
  assert.equal(await fetchSteelHlsPlaylist(credentials, { fetch: fetchImpl }), PLAYLIST);
  assert.equal(calls[0].url.pathname, "/v1/sessions/3f1c-session/hls");
  assert.equal(calls[0].headers["steel-api-key"], "ste-secret-key");

  const missing = mockFetch(() => new Response("not found", { status: 404 }));
  assert.equal(await fetchSteelHlsPlaylist(credentials, { fetch: missing.fetchImpl }), null);
  const notPlaylist = mockFetch(() => new Response("{}", { status: 200 }));
  assert.equal(await fetchSteelHlsPlaylist(credentials, { fetch: notPlaylist.fetchImpl }), null);
});

test("collects traces and the replay start together; a timeout yields nothing", async () => {
  const { fetchImpl } = mockFetch((url) =>
    url.pathname.endsWith("/hls")
      ? new Response(PLAYLIST)
      : Response.json({ events: [clickOnDecoy], total: 1, hasMore: false }));
  const evidence = await collectSteelEvidence(credentials, { fetch: fetchImpl });
  assert.equal(evidence.replayAvailable, true);
  assert.equal(evidence.replayStart, Date.parse("2026-09-12T21:11:11.610Z"));
  assert.deepEqual(evidence.trace?.map((entry) => entry.decoy), [true]);

  const hanging = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;
  const started = Date.now();
  assert.deepEqual(
    await collectSteelEvidence(credentials, { fetch: hanging, timeoutMs: 30 }),
    { trace: null, replayAvailable: false, replayStart: null },
  );
  assert.ok(Date.now() - started < 2_000);
});

test("later attempts fetch only what is still missing and report progress", async () => {
  let hlsCalls = 0;
  let traceCalls = 0;
  const { fetchImpl } = mockFetch((url) => {
    if (url.pathname.endsWith("/hls")) {
      hlsCalls += 1;
      return hlsCalls < 3 ? new Response("not ready", { status: 404 }) : new Response(PLAYLIST);
    }
    traceCalls += 1;
    return Response.json({ events: [clickOnDecoy], total: 1, hasMore: false });
  });
  const progress: boolean[] = [];
  const evidence = await collectSteelEvidence(credentials, {
    fetch: fetchImpl,
    attempts: 5,
    retryMs: 5,
    onProgress: (next) => progress.push(next.replayAvailable),
  });
  assert.equal(evidence.replayAvailable, true);
  assert.equal(evidence.replayStart, Date.parse("2026-09-12T21:11:11.610Z"));
  assert.equal(hlsCalls, 3);
  assert.equal(traceCalls, 1, "traces are not fetched again once read");
  assert.deepEqual(progress, [false, false, true]);

  const never = mockFetch((url) =>
    url.pathname.endsWith("/hls")
      ? new Response("nope", { status: 404 })
      : Response.json({ events: [], total: 0, hasMore: false }));
  assert.deepEqual(
    await collectSteelEvidence(credentials, { fetch: never.fetchImpl, attempts: 2, retryMs: 5 }),
    { trace: [], replayAvailable: false, replayStart: null },
  );
  assert.equal(never.calls.filter((call) => call.url.pathname.endsWith("/hls")).length, 2);
});

test("the session manager remembers each racer's session and creating key after release", async () => {
  const released: string[] = [];
  const client = {
    sessions: {
      async create() {
        return {
          id: "steel-session-1",
          websocketUrl: "wss://connect.steel.dev?sessionId=steel-session-1",
          debugUrl: "https://app.steel.dev/sessions/steel-session-1/debug",
        };
      },
      async release(id: string) {
        released.push(id);
        return {};
      },
    },
  } as unknown as Steel;
  const page = {};
  const browser = {
    contexts: () => [{ pages: () => [page], newPage: async () => page }],
    close: async () => undefined,
  } as unknown as Browser;
  const endpoints: string[] = [];
  const manager = new SteelSessionManager({
    apiKeys: ["key-a"],
    createClient: () => client,
    connectOverCDP: async (endpoint) => {
      endpoints.push(endpoint);
      return browser;
    },
  });

  assert.equal(manager.evidence("racer-1"), null);
  const session = await manager.create("racer-1");
  assert.equal(session.steelSessionId, "steel-session-1");
  assert.deepEqual(endpoints, ["wss://connect.steel.dev?sessionId=steel-session-1&apiKey=key-a"]);
  assert.deepEqual(manager.evidence("racer-1"), { steelSessionId: "steel-session-1", apiKey: "key-a" });

  await manager.releaseAll();
  assert.deepEqual(released, ["steel-session-1"]);
  assert.throws(() => manager.get("racer-1"), /No active Steel session/);
  const evidence = manager.evidence("racer-1");
  assert.deepEqual(evidence, { steelSessionId: "steel-session-1", apiKey: "key-a" });
  if (evidence) evidence.apiKey = "tampered";
  assert.equal(manager.evidence("racer-1")?.apiKey, "key-a");
});
