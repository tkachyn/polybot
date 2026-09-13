import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  combineStreamStatus,
  getTrackedStreams,
  heartbeatTimeoutFor,
  openEventStream,
  reconnectStreams,
  subscribeTrackedStreams,
  type NetworkSource,
  type OpenEventStreamOptions,
  type StreamStatus,
  type VisibilitySource,
} from "./stream";
import { FakeSource } from "./testing";

describe("openEventStream", () => {
  let sources: FakeSource[];
  let statuses: StreamStatus[];
  let events: Array<[string, unknown]>;
  let closers: Array<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    sources = [];
    statuses = [];
    events = [];
    closers = [];
  });

  afterEach(() => {
    for (const close of closers) close();
    vi.useRealTimers();
  });

  const start = (extra: Partial<OpenEventStreamOptions> = {}) => {
    const close = openEventStream({
      url: "/api/fights/stream",
      events: ["fights"],
      onEvent: (name, data) => events.push([name, data]),
      onStatus: (s) => statuses.push(s),
      createSource: (url) => {
        const s = new FakeSource(url);
        sources.push(s);
        return s;
      },
      retryBaseMs: 100,
      retryMaxMs: 400,
      ...extra,
    });
    closers.push(close);
    return close;
  };

  const deliver = (source: FakeSource | undefined) => source?.emit("fights", JSON.stringify({ serverTime: 1, fights: [] }));

  it("closes while the page is hidden and reopens when it is visible again", () => {
    let hidden = false;
    const listeners = new Set<() => void>();
    const visibility: VisibilitySource = {
      isHidden: () => hidden,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const setHidden = (next: boolean) => {
      hidden = next;
      for (const listener of listeners) listener();
    };
    const close = start({ visibility, hiddenGraceMs: 1000 });
    sources[0]?.open();
    sources[0]?.emit("fights", JSON.stringify({ serverTime: 1, fights: [] }));

    setHidden(true);
    vi.advanceTimersByTime(999);
    expect(sources[0]?.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sources[0]?.closed).toBe(true);
    // Status is left alone so consumers do not start polling.
    expect(statuses.at(-1)).toBe("open");
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);

    setHidden(false);
    expect(sources).toHaveLength(2);
    sources[1]?.open();

    // A hide shorter than the grace period keeps the connection.
    setHidden(true);
    vi.advanceTimersByTime(500);
    setHidden(false);
    vi.advanceTimersByTime(5000);
    expect(sources).toHaveLength(2);
    expect(sources[1]?.closed).toBe(false);

    close();
    expect(listeners.size).toBe(0);
  });

  it("dispatches parsed events and reports status", () => {
    const close = start();
    expect(statuses).toEqual(["connecting"]);
    sources[0]?.open();
    sources[0]?.emit("fights", JSON.stringify({ serverTime: 1, fights: [] }));
    sources[0]?.emit("fights", "not json");
    expect(events).toEqual([["fights", { serverTime: 1, fights: [] }]]);
    expect(statuses).toEqual(["connecting", "open"]);
    close();
    expect(sources[0]?.closed).toBe(true);
    expect(statuses.at(-1)).toBe("closed");
  });

  it("marks browser-driven retries as reconnecting", () => {
    start();
    sources[0]?.open();
    sources[0]?.fail(false);
    expect(statuses.at(-1)).toBe("reconnecting");
    sources[0]?.open();
    expect(statuses.at(-1)).toBe("reconnecting");
    sources[0]?.emit("fights", JSON.stringify({ serverTime: 1, fights: [] }));
    expect(statuses.at(-1)).toBe("open");
    expect(sources).toHaveLength(1);
  });

  it("reconnects itself with backoff when the browser gives up", () => {
    const close = start();
    sources[0]?.fail(true);
    expect(statuses.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(99);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(2);
    sources[1]?.fail(true);
    vi.advanceTimersByTime(199);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(3);
    sources[2]?.open();
    sources[2]?.emit("fights", JSON.stringify({ serverTime: 1, fights: [] }));
    expect(statuses.at(-1)).toBe("open");
    close();
    vi.advanceTimersByTime(10_000);
    expect(sources).toHaveLength(3);
  });

  it("ignores events from a replaced source", () => {
    start();
    const first = sources[0];
    first?.fail(true);
    vi.advanceTimersByTime(100);
    first?.emit("fights", JSON.stringify({ stale: true }));
    expect(events).toEqual([]);
  });

  it("keeps polling fallback active until an application event arrives", () => {
    start();
    sources[0]?.open();
    expect(statuses.at(-1)).toBe("connecting");
    sources[0]?.emit("fights", JSON.stringify({ serverTime: 1, fights: [] }));
    expect(statuses.at(-1)).toBe("open");
  });

  describe("watchdog", () => {
    // The server pings every second here: dead after 2 missed pings + 2 s grace.
    const PING_MS = 1_000;
    const DEAD_AFTER_MS = heartbeatTimeoutFor(PING_MS);

    /** Answers, pings once and delivers, like a healthy server on connect. */
    const live = (source: FakeSource | undefined) => {
      source?.open();
      source?.ping(PING_MS);
      deliver(source);
    };

    it("allows two missed pings plus a grace", () => {
      expect(DEAD_AFTER_MS).toBe(4_000);
      expect(heartbeatTimeoutFor(5_000)).toBe(12_000);
    });

    it("replaces a connection that goes silent without an error", () => {
      start();
      live(sources[0]);
      expect(statuses).toEqual(["connecting", "open"]);
      vi.advanceTimersByTime(DEAD_AFTER_MS - 1);
      expect(sources[0]?.closed).toBe(false);
      vi.advanceTimersByTime(1);
      expect(sources[0]?.closed).toBe(true);
      expect(statuses.at(-1)).toBe("reconnecting");
      vi.advanceTimersByTime(100);
      expect(sources).toHaveLength(2);
      live(sources[1]);
      expect(statuses).toEqual(["connecting", "open", "reconnecting", "open"]);
    });

    it("keeps a quiet connection while pings arrive, without passing them on", () => {
      start();
      live(sources[0]);
      for (let i = 0; i < 30; i += 1) {
        vi.advanceTimersByTime(PING_MS);
        sources[0]?.ping(PING_MS);
      }
      expect(sources).toHaveLength(1);
      expect(statuses).toEqual(["connecting", "open"]);
      expect(events.map(([name]) => name)).toEqual(["fights"]);
    });

    it("hands pings to a consumer that asks for them", () => {
      start({ events: ["fights", "ping"] });
      sources[0]?.ping(PING_MS);
      expect(events).toEqual([["ping", { intervalMs: PING_MS }]]);
    });

    it("counts application events as signs of life too", () => {
      start();
      live(sources[0]);
      for (let i = 0; i < 10; i += 1) {
        vi.advanceTimersByTime(DEAD_AFTER_MS - 1);
        deliver(sources[0]);
      }
      expect(sources).toHaveLength(1);
      expect(statuses.at(-1)).toBe("open");
    });

    it("never trips on a server that does not ping", () => {
      start();
      sources[0]?.open();
      deliver(sources[0]);
      vi.advanceTimersByTime(120_000);
      expect(sources).toHaveLength(1);
      expect(statuses.at(-1)).toBe("open");
    });

    it("replaces a connection that never answers", () => {
      start({ connectTimeoutMs: 5_000 });
      vi.advanceTimersByTime(4_999);
      expect(sources[0]?.closed).toBe(false);
      vi.advanceTimersByTime(1);
      expect(sources[0]?.closed).toBe(true);
      expect(statuses.at(-1)).toBe("reconnecting");
      vi.advanceTimersByTime(100);
      expect(sources).toHaveLength(2);
    });

    it("trusts an answered connection that has sent nothing yet (a proxy buffering the body)", () => {
      start({ connectTimeoutMs: 5_000 });
      sources[0]?.open();
      vi.advanceTimersByTime(120_000);
      expect(sources).toHaveLength(1);
      // Not open until data arrives, so REST polling keeps standing in.
      expect(statuses).toEqual(["connecting"]);
    });

    it("after a stall, also replaces a reconnect that answers but stays silent, backing off", () => {
      start();
      live(sources[0]);
      vi.advanceTimersByTime(DEAD_AFTER_MS);
      vi.advanceTimersByTime(100);
      expect(sources).toHaveLength(2);
      sources[1]?.open();
      vi.advanceTimersByTime(DEAD_AFTER_MS);
      expect(sources[1]?.closed).toBe(true);
      // Nothing got through, so the next wait doubles.
      vi.advanceTimersByTime(199);
      expect(sources).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(sources).toHaveLength(3);
      expect(statuses.at(-1)).toBe("reconnecting");
    });

    it("takes over when the browser's own retry hangs", () => {
      start({ connectTimeoutMs: 5_000 });
      live(sources[0]);
      sources[0]?.fail(false);
      expect(statuses.at(-1)).toBe("reconnecting");
      vi.advanceTimersByTime(4_999);
      expect(sources[0]?.closed).toBe(false);
      vi.advanceTimersByTime(1);
      expect(sources[0]?.closed).toBe(true);
      vi.advanceTimersByTime(100);
      expect(sources).toHaveLength(2);
    });

    it("stands down while the page is hidden", () => {
      let hidden = false;
      const listeners = new Set<() => void>();
      const visibility: VisibilitySource = {
        isHidden: () => hidden,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      start({ visibility, hiddenGraceMs: 1_000 });
      live(sources[0]);
      hidden = true;
      for (const listener of listeners) listener();
      vi.advanceTimersByTime(60_000);
      expect(sources).toHaveLength(1);
      expect(statuses.at(-1)).toBe("open");
    });
  });

  describe("network", () => {
    const fakeNetwork = () => {
      let online = true;
      const listeners = new Set<() => void>();
      const network: NetworkSource = {
        isOnline: () => online,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      const setOnline = (next: boolean) => {
        online = next;
        for (const listener of [...listeners]) listener();
      };
      return { network, setOnline, listeners };
    };

    it("drops the connection when the browser goes offline and reconnects at once when it is back", () => {
      const { network, setOnline } = fakeNetwork();
      start({ network });
      sources[0]?.open();
      deliver(sources[0]);
      setOnline(false);
      expect(sources[0]?.closed).toBe(true);
      expect(statuses.at(-1)).toBe("reconnecting");
      setOnline(true);
      // No backoff wait.
      expect(sources).toHaveLength(2);
      sources[1]?.open();
      deliver(sources[1]);
      expect(statuses.at(-1)).toBe("open");
    });

    it("leaves a healthy connection alone when the network reports online", () => {
      const { network, setOnline, listeners } = fakeNetwork();
      const close = start({ network });
      sources[0]?.open();
      deliver(sources[0]);
      setOnline(true);
      expect(sources).toHaveLength(1);
      close();
      expect(listeners.size).toBe(0);
    });
  });
});

describe("stream registry", () => {
  let sources: FakeSource[];

  beforeEach(() => {
    vi.useFakeTimers();
    sources = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const open = (url: string, extra: Partial<OpenEventStreamOptions> = {}) =>
    openEventStream({
      url,
      events: ["fights"],
      onEvent: () => {},
      createSource: (u) => {
        const s = new FakeSource(u);
        sources.push(s);
        return s;
      },
      retryBaseMs: 100,
      network: null,
      visibility: null,
      ...extra,
    });

  it("lists every open stream with its status and reconnects only the stalled ones", () => {
    let changes = 0;
    const unsubscribe = subscribeTrackedStreams(() => {
      changes += 1;
    });
    const closeA = open("/a");
    const closeB = open("/b");
    const view = () => getTrackedStreams().map((s) => `${s.url}:${s.status}`);
    expect(view()).toEqual(["/a:connecting", "/b:connecting"]);
    const snapshot = getTrackedStreams();
    expect(getTrackedStreams()).toBe(snapshot);

    sources[0]?.open();
    sources[0]?.emit("fights", "{}");
    sources[1]?.fail(true);
    expect(view()).toEqual(["/a:open", "/b:reconnecting"]);
    expect(changes).toBeGreaterThan(0);

    reconnectStreams();
    // Only the stalled stream reconnects, without waiting out its backoff.
    expect(sources.map((s) => s.url)).toEqual(["/a", "/b", "/b"]);

    closeA();
    closeB();
    expect(getTrackedStreams()).toEqual([]);
    unsubscribe();
  });

  it("leaves out streams opened with track: false", () => {
    const close = open("/quiet", { track: false });
    expect(getTrackedStreams()).toEqual([]);
    close();
  });
});

describe("combineStreamStatus", () => {
  it("reports the worst active status", () => {
    expect(combineStreamStatus(["open", "open"])).toBe("open");
    expect(combineStreamStatus(["open", "connecting"])).toBe("connecting");
    expect(combineStreamStatus(["connecting", "reconnecting"])).toBe("reconnecting");
    expect(combineStreamStatus(["closed", "open"])).toBe("open");
    expect(combineStreamStatus(["closed"])).toBe("closed");
  });
});
