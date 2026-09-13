import assert from "node:assert/strict";
import test from "node:test";
import type { Browser } from "playwright";
import type Steel from "steel-sdk";
import {
  STEEL_RAW_TRACE_LIMIT,
  STEEL_TRACE_LIMIT,
  collectSteelEvidence,
  fetchSteelAgentTraces,
  fetchSteelHlsPlaylist,
  mergeSteelEvidence,
  normalizeSteelDatasetEvent,
  normalizeSteelTraceEvent,
  parseHlsReplayStart,
  parseSteelTimestamp,
  steelEvidenceComplete,
  type SteelEvidence,
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
  const traces = await fetchSteelAgentTraces(credentials, { fetch: fetchImpl });

  assert.deepEqual(traces?.trace.map((entry) => [entry.type, entry.decoy]), [
    ["navigate", false],
    ["click", true],
    ["click", false],
  ]);
  // The raw events come back exactly as Steel sent them, oldest first.
  assert.deepEqual(traces?.raw, [navigate, clickOnDecoy, clickReal]);
  assert.equal(calls.length, 2);
  assert.equal(`${calls[0].url.origin}${calls[0].url.pathname}`, "https://api.steel.dev/v1/sessions/3f1c-session/agent-traces");
  assert.equal(calls[0].url.searchParams.get("startTime"), null);
  assert.equal(calls[1].url.searchParams.get("startTime"), "2026-09-12T21:11:17.875Z");
  for (const call of calls) {
    assert.equal(call.headers["steel-api-key"], "ste-secret-key");
    assert.ok(!call.url.toString().includes("ste-secret-key"), "the key never travels in the URL");
  }
});

test("caps the normalised trace at 300 events and the raw events at 2,000, oldest first", async () => {
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
  const traces = await fetchSteelAgentTraces(credentials, { fetch: fetchImpl });
  assert.ok(traces);
  assert.equal(traces.trace.length, STEEL_TRACE_LIMIT);
  assert.equal(traces.raw.length, STEEL_RAW_TRACE_LIMIT);
  assert.equal(calls.length, STEEL_RAW_TRACE_LIMIT / 200);
  assert.equal(traces.trace[0].at, base);
  assert.ok(traces.trace.every((entry, index) => index === 0 || entry.at >= traces.trace[index - 1].at));
  const times = traces.raw.map((event) => Date.parse((event as { timestamp: string }).timestamp));
  assert.equal(times[0], base);
  assert.ok(times.every((at, index) => index === 0 || at >= times[index - 1]));
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
  const mixedTraces = await fetchSteelAgentTraces(credentials, { fetch: mixed.fetchImpl });
  assert.deepEqual(mixedTraces?.trace.map((entry) => entry.type), ["navigate"]);
  // Raw events without a timestamp can be neither ordered nor paged past.
  assert.deepEqual(mixedTraces?.raw, [navigate]);
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
  assert.deepEqual(evidence.raw, [clickOnDecoy]);

  const hanging = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;
  const started = Date.now();
  assert.deepEqual(
    await collectSteelEvidence(credentials, { fetch: hanging, timeoutMs: 30 }),
    { trace: null, raw: null, replayAvailable: false, replayStart: null },
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
    { trace: [], raw: [], replayAvailable: false, replayStart: null },
  );
  assert.equal(never.calls.filter((call) => call.url.pathname.endsWith("/hls")).length, 2);
  assert.equal(
    never.calls.filter((call) => call.url.pathname.endsWith("/agent-traces")).length,
    2,
    "a trace with no events is read again",
  );
});

test("a trace with no events is read again until Steel publishes it; the best read is kept", async () => {
  let traceCalls = 0;
  let hlsCalls = 0;
  const { fetchImpl } = mockFetch((url) => {
    if (url.pathname.endsWith("/hls")) {
      hlsCalls += 1;
      return new Response(PLAYLIST);
    }
    traceCalls += 1;
    // A released session's traces read as empty until Steel publishes them.
    return Response.json(traceCalls < 3
      ? { events: [], total: 0, hasMore: false }
      : { events: [navigate, clickOnDecoy], total: 2, hasMore: false });
  });
  const progress: Array<number | null> = [];
  const evidence = await collectSteelEvidence(credentials, {
    fetch: fetchImpl,
    attempts: 5,
    retryMs: 5,
    onProgress: (next) => progress.push(next.raw?.length ?? null),
  });
  assert.deepEqual(evidence.raw, [navigate, clickOnDecoy]);
  assert.deepEqual(evidence.trace?.map((entry) => [entry.type, entry.decoy]), [["navigate", false], ["click", true]]);
  assert.equal(traceCalls, 3);
  assert.equal(hlsCalls, 1, "the recording is not fetched again once read");
  assert.deepEqual(progress, [0, 0, 2]);

  // A failed read never replaces an empty one: the trace stays readable.
  let flakyCalls = 0;
  const flaky = mockFetch((url) => {
    if (url.pathname.endsWith("/hls")) return new Response(PLAYLIST);
    flakyCalls += 1;
    return flakyCalls === 1
      ? Response.json({ events: [], total: 0, hasMore: false })
      : new Response("unavailable", { status: 503 });
  });
  assert.deepEqual(
    await collectSteelEvidence(credentials, { fetch: flaky.fetchImpl, attempts: 3, retryMs: 5 }),
    { trace: [], raw: [], replayAvailable: true, replayStart: Date.parse("2026-09-12T21:11:11.610Z") },
  );
  assert.equal(flakyCalls, 3);
});

test("merging two reads of a session keeps the trace with more events and a readable recording", () => {
  const failed: SteelEvidence = { trace: null, raw: null, replayAvailable: false, replayStart: null };
  const empty: SteelEvidence = { trace: [], raw: [], replayAvailable: true, replayStart: 5 };
  const entry = normalizeSteelTraceEvent(clickOnDecoy);
  assert.ok(entry);
  const published: SteelEvidence = { trace: [entry], raw: [clickOnDecoy], replayAvailable: false, replayStart: null };

  assert.equal(mergeSteelEvidence(empty, failed), empty, "a failed read adds nothing");
  assert.equal(mergeSteelEvidence(empty, { ...empty }), empty);
  assert.equal(mergeSteelEvidence(undefined, failed), undefined);
  assert.deepEqual(mergeSteelEvidence(undefined, empty), empty);
  const merged = mergeSteelEvidence(empty, published);
  assert.deepEqual(merged, { trace: [entry], raw: [clickOnDecoy], replayAvailable: true, replayStart: 5 });
  assert.equal(mergeSteelEvidence(merged, empty), merged, "never downgraded");

  assert.equal(steelEvidenceComplete(undefined), false);
  assert.equal(steelEvidenceComplete(empty), false, "no events yet");
  assert.equal(steelEvidenceComplete(published), false, "no recording yet");
  assert.equal(steelEvidenceComplete(merged), true);
});

// Full Agent Traces shapes, as verified against real Steel sessions on 2026-09-12.
const clickWithPointer = {
  ...clickOnDecoy,
  pointer: { x: 60, y: 35, button: "left", clickCount: 1 },
};
const emailInput = {
  timestamp: "2026-09-12T21:11:13.000Z",
  endTimestamp: "2026-09-12T21:11:13.900Z",
  type: "input",
  page: { url: "https://course.test/login" },
  target: {
    tagName: "INPUT",
    role: "textbox",
    accessibleName: "Email",
    text: "",
    attributes: { id: "email" },
    selector: { css: "#email", id: "email" },
    boundingBox: { x: 40, y: 140, width: 320, height: 44 },
  },
  value: { inputType: "email", valueLength: 17 },
};
const passwordChange = {
  timestamp: "2026-09-12T21:11:14.100Z",
  endTimestamp: "2026-09-12T21:11:15.350Z",
  type: "change",
  page: { url: "https://course.test/login" },
  target: {
    tagName: "INPUT",
    role: "textbox",
    accessibleName: "Password",
    text: "",
    attributes: { id: "password" },
    selector: { css: "#password", id: "password" },
    boundingBox: { x: 40, y: 200, width: 320, height: 44 },
  },
  value: { inputType: "password", valueLength: 14, redacted: true },
};
const enterKey = {
  timestamp: "2026-09-12T21:11:15.400Z",
  type: "keyPress",
  page: { url: "https://course.test/login" },
  keyboard: { key: "Enter", code: "Enter" },
};
const formSubmit = {
  timestamp: "2026-09-12T21:11:15.410Z",
  type: "submit",
  page: { url: "https://course.test/login" },
  target: {
    tagName: "FORM",
    role: "form",
    accessibleName: "Sign in",
    attributes: { id: "login-form" },
    selector: { css: "#login-form", id: "login-form" },
    boundingBox: { x: 20, y: 100, width: 360, height: 260 },
  },
};

test("normalises full Agent Traces events for the dataset", () => {
  assert.deepEqual(normalizeSteelDatasetEvent(clickWithPointer), {
    at: Date.parse("2026-09-12T21:11:17.874Z"),
    endAt: null,
    type: "click",
    label: "Continue",
    role: "button",
    tag: "button",
    selector: "#arena-decoy-2",
    url: "https://course.test/shipping",
    bbox: [10, 20, 100, 30],
    pointer: { x: 60, y: 35, button: "left" },
    input: null,
    key: null,
    decoy: true,
  });
  assert.deepEqual(normalizeSteelDatasetEvent(emailInput), {
    at: Date.parse("2026-09-12T21:11:13.000Z"),
    endAt: Date.parse("2026-09-12T21:11:13.900Z"),
    type: "input",
    label: "Email",
    role: "textbox",
    tag: "input",
    selector: "#email",
    url: "https://course.test/login",
    bbox: [40, 140, 320, 44],
    pointer: null,
    input: { inputType: "email", length: 17, redacted: false },
    key: null,
    decoy: false,
  });
  const password = normalizeSteelDatasetEvent(passwordChange);
  assert.deepEqual(password?.input, { inputType: "password", length: 14, redacted: true });
  assert.deepEqual(
    [password?.type, password?.label, password?.endAt],
    ["change", "Password", Date.parse("2026-09-12T21:11:15.350Z")],
  );
  const enter = normalizeSteelDatasetEvent(enterKey);
  assert.deepEqual([enter?.type, enter?.key, enter?.label, enter?.tag], ["keyPress", { key: "Enter", code: "Enter" }, null, null]);
  const submit = normalizeSteelDatasetEvent(formSubmit);
  assert.deepEqual(
    [submit?.type, submit?.tag, submit?.role, submit?.label, submit?.selector, submit?.bbox],
    ["submit", "form", "form", "Sign in", "#login-form", [20, 100, 360, 260]],
  );
  assert.deepEqual(normalizeSteelDatasetEvent(navigate), {
    at: Date.parse("2026-09-12T21:11:11.990Z"),
    endAt: null,
    type: "navigate",
    label: null,
    role: null,
    tag: null,
    selector: null,
    url: "https://course.test/cart",
    bbox: null,
    pointer: null,
    input: null,
    key: null,
    decoy: false,
  });
});

test("the dataset normaliser never keeps typed characters and tolerates odd shapes", () => {
  // A single-character key would be a typed character.
  assert.equal(normalizeSteelDatasetEvent({ ...enterKey, keyboard: { key: "a", code: "KeyA" } })?.key, null);
  // A string value is never an input episode.
  const typed = normalizeSteelDatasetEvent({ ...emailInput, value: "tester@arena.test" });
  assert.equal(typed?.input, null);
  assert.doesNotMatch(JSON.stringify(typed), /tester@arena/);
  // A navigation's own URL wins over the page it started from.
  assert.equal(
    normalizeSteelDatasetEvent({ ...navigate, page: { url: "https://course.test/shipping" } })?.url,
    "https://course.test/cart",
  );
  // DOM button codes read as names; a box with a missing side is dropped.
  const odd = normalizeSteelDatasetEvent({
    ...clickWithPointer,
    pointer: { x: 1, y: 2, button: 2 },
    target: { ...clickWithPointer.target, boundingBox: { x: 1, y: 2, width: 3 } },
  });
  assert.deepEqual(odd?.pointer, { x: 1, y: 2, button: "right" });
  assert.equal(odd?.bbox, null);
  assert.equal(normalizeSteelDatasetEvent(null), null);
  assert.equal(normalizeSteelDatasetEvent({ type: "click" }), null);
  assert.equal(normalizeSteelDatasetEvent({ timestamp: "2026-09-12T21:11:11Z" }), null);
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
