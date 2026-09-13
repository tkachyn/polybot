import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openEventStream, type StreamStatus } from "../api/stream";
import { FakeSource } from "../api/testing";
import { needsFallbackPolling, startPolling } from "./polling";

describe("startPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the first delay, then polls one fetch at a time", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const stop = startPolling({
      load: () => {
        calls += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      intervalMs: 1_000,
      firstDelayMs: 200,
    });
    await vi.advanceTimersByTimeAsync(199);
    expect(calls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(1);
    // A slow fetch is never overlapped by the next one.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(1);
    release?.();
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    stop();
  });

  it("keeps polling after failed fetches", async () => {
    const load = vi.fn(() => Promise.reject(new Error("offline")));
    const stop = startPolling({ load, intervalMs: 1_000, firstDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(load).toHaveBeenCalledTimes(4);
    stop();
  });

  it("stops, aborting the fetch in flight", async () => {
    let signal: AbortSignal | undefined;
    const load = vi.fn((s: AbortSignal) => {
      signal = s;
      return new Promise<void>(() => {});
    });
    const stop = startPolling({ load, intervalMs: 1_000, firstDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    stop();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("REST fallback behind a live stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The state hooks' wiring: poll while the stream is not open (useFallbackPolling). */
  function follow(sources: FakeSource[]) {
    let polls = 0;
    let stop: (() => void) | undefined;
    const onStatus = (status: StreamStatus) => {
      const active = needsFallbackPolling(status) && status !== "closed";
      if (active && !stop) {
        stop = startPolling({
          load: async () => {
            polls += 1;
          },
          intervalMs: 1_000,
          firstDelayMs: 100,
        });
      } else if (!active && stop) {
        stop();
        stop = undefined;
      }
    };
    const close = openEventStream({
      url: "/api/fights/race-1/stream",
      events: ["snapshot"],
      onEvent: () => {},
      onStatus,
      createSource: (url) => {
        const source = new FakeSource(url);
        sources.push(source);
        return source;
      },
      retryBaseMs: 100,
      connectTimeoutMs: 5_000,
      network: null,
      visibility: null,
    });
    return { close, polls: () => polls, polling: () => stop !== undefined };
  }

  it("polls while connecting, stops on the first event", async () => {
    const sources: FakeSource[] = [];
    const feed = follow(sources);
    expect(feed.polling()).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(feed.polls()).toBe(1);
    sources[0]?.open();
    sources[0]?.ping(1_000);
    // A ping alone is not data: the fallback keeps going.
    expect(feed.polling()).toBe(true);
    sources[0]?.emit("snapshot", "{}");
    expect(feed.polling()).toBe(false);
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      sources[0]?.ping(1_000);
    }
    expect(feed.polls()).toBe(1);
    feed.close();
  });

  it("resumes polling when a stalled stream is declared dead, and stops once it delivers again", async () => {
    const sources: FakeSource[] = [];
    const feed = follow(sources);
    sources[0]?.open();
    sources[0]?.ping(1_000);
    sources[0]?.emit("snapshot", "{}");
    expect(feed.polling()).toBe(false);

    // The connection goes half-open: nothing arrives, no error either. Two
    // missed 1 s pings plus the 2 s grace later, the watchdog gives up on it.
    await vi.advanceTimersByTimeAsync(3_999);
    expect(feed.polling()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources[0]?.closed).toBe(true);
    expect(feed.polling()).toBe(true);

    // REST stands in while the replacement connection is still stuck.
    await vi.advanceTimersByTimeAsync(2_100);
    expect(feed.polls()).toBe(3);
    expect(sources).toHaveLength(2);

    // The network is back: the stream delivers and polling stops.
    sources[1]?.open();
    sources[1]?.ping(1_000);
    sources[1]?.emit("snapshot", "{}");
    expect(feed.polling()).toBe(false);
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      sources[1]?.ping(1_000);
    }
    expect(feed.polls()).toBe(3);
    feed.close();
  });
});
