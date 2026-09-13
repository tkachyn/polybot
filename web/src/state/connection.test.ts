import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTrackedStreams, openEventStream, subscribeTrackedStreams } from "../api/stream";
import { FakeSource } from "../api/testing";
import { BANNER_RESUMED_MS, BANNER_SHOW_DELAY_MS, createConnectionBanner, liveHealth, type LiveHealth } from "./connection";

const LIVE: LiveHealth = { stale: false, offline: false, live: true };
const CONNECTING: LiveHealth = { stale: false, offline: false, live: false };
const STALLED: LiveHealth = { stale: true, offline: false, live: false };
const PARTLY_STALLED: LiveHealth = { stale: true, offline: false, live: true };
const OFFLINE: LiveHealth = { stale: true, offline: true, live: false };

describe("liveHealth", () => {
  it("is stale while any stream is reconnecting or the browser is offline", () => {
    expect(liveHealth([{ status: "open" }, { status: "open" }], true)).toEqual(LIVE);
    expect(liveHealth([{ status: "open" }, { status: "reconnecting" }], true)).toEqual(PARTLY_STALLED);
    // Still connecting is loading, not stale: screens show skeletons for that.
    expect(liveHealth([{ status: "connecting" }], true)).toEqual(CONNECTING);
    expect(liveHealth([], true)).toEqual(CONNECTING);
    expect(liveHealth([{ status: "open" }], false)).toEqual({ stale: true, offline: true, live: true });
  });
});

describe("connection banner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays hidden through a blip shorter than the show delay", () => {
    const banner = createConnectionBanner();
    banner.update(LIVE);
    banner.update(STALLED);
    vi.advanceTimersByTime(BANNER_SHOW_DELAY_MS - 1);
    banner.update(LIVE);
    vi.advanceTimersByTime(60_000);
    expect(banner.getState()).toEqual({ kind: "hidden" });
  });

  it("shows while live data is stale and clears itself after recovery", () => {
    const banner = createConnectionBanner();
    const seen: string[] = [];
    banner.subscribe(() => seen.push(banner.getState().kind));
    banner.update(LIVE);
    banner.update(STALLED);
    vi.advanceTimersByTime(BANNER_SHOW_DELAY_MS);
    expect(banner.getState()).toEqual({ kind: "stale", offline: false, everLive: true });
    vi.advanceTimersByTime(120_000);
    expect(banner.getState().kind).toBe("stale");

    banner.update(LIVE);
    expect(banner.getState()).toEqual({ kind: "resumed", firstConnection: false });
    vi.advanceTimersByTime(BANNER_RESUMED_MS - 1);
    expect(banner.getState().kind).toBe("resumed");
    vi.advanceTimersByTime(1);
    expect(banner.getState()).toEqual({ kind: "hidden" });
    expect(seen).toEqual(["stale", "resumed", "hidden"]);
  });

  it("stays up while any stream is still reconnecting", () => {
    const banner = createConnectionBanner();
    banner.update(LIVE);
    banner.update(STALLED);
    vi.advanceTimersByTime(BANNER_SHOW_DELAY_MS);
    banner.update(PARTLY_STALLED);
    vi.advanceTimersByTime(60_000);
    expect(banner.getState().kind).toBe("stale");
  });

  it("says when the browser is offline, and when nothing has been live yet", () => {
    const banner = createConnectionBanner();
    banner.update(OFFLINE);
    vi.advanceTimersByTime(BANNER_SHOW_DELAY_MS);
    expect(banner.getState()).toEqual({ kind: "stale", offline: true, everLive: false });
    // The network is back but the server is not reachable yet.
    banner.update(STALLED);
    expect(banner.getState()).toEqual({ kind: "stale", offline: false, everLive: false });
    banner.update(LIVE);
    expect(banner.getState()).toEqual({ kind: "resumed", firstConnection: true });
  });

  it("goes straight back to stale if data stalls again while it says resumed", () => {
    const banner = createConnectionBanner();
    banner.update(LIVE);
    banner.update(STALLED);
    vi.advanceTimersByTime(BANNER_SHOW_DELAY_MS);
    banner.update(LIVE);
    banner.update(STALLED);
    expect(banner.getState().kind).toBe("stale");
    vi.advanceTimersByTime(BANNER_RESUMED_MS * 2);
    expect(banner.getState().kind).toBe("stale");
  });

  it("never shows for a first connection that simply takes a moment", () => {
    const banner = createConnectionBanner();
    banner.update(CONNECTING);
    vi.advanceTimersByTime(10_000);
    banner.update(LIVE);
    vi.advanceTimersByTime(10_000);
    expect(banner.getState()).toEqual({ kind: "hidden" });
  });

  it("follows the stream registry: a stalled stream raises it, recovery clears it", () => {
    const sources: FakeSource[] = [];
    const banner = createConnectionBanner();
    const sync = () => banner.update(liveHealth(getTrackedStreams(), true));
    const unsubscribe = subscribeTrackedStreams(sync);
    const close = openEventStream({
      url: "/api/users/user-0001/stream",
      events: ["portfolio"],
      onEvent: () => {},
      createSource: (url) => {
        const source = new FakeSource(url);
        sources.push(source);
        return source;
      },
      retryBaseMs: 100,
      network: null,
      visibility: null,
    });
    sources[0]?.open();
    sources[0]?.ping(1_000);
    sources[0]?.emit("portfolio", "{}");
    expect(banner.getState().kind).toBe("hidden");

    // Half-open: silent past two missed pings plus the grace (4 s).
    vi.advanceTimersByTime(4_000);
    expect(banner.getState().kind).toBe("hidden");
    vi.advanceTimersByTime(BANNER_SHOW_DELAY_MS);
    expect(banner.getState()).toEqual({ kind: "stale", offline: false, everLive: true });

    // The replacement connection delivers.
    sources[1]?.open();
    sources[1]?.ping(1_000);
    sources[1]?.emit("portfolio", "{}");
    expect(banner.getState().kind).toBe("resumed");
    vi.advanceTimersByTime(BANNER_RESUMED_MS);
    expect(banner.getState().kind).toBe("hidden");

    close();
    unsubscribe();
    banner.stop();
  });
});
