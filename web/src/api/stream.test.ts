import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { combineStreamStatus, openEventStream, type EventSourceLike, type OpenEventStreamOptions, type StreamStatus, type VisibilitySource } from "./stream";

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent);
  }

  fail(closed: boolean): void {
    this.readyState = closed ? 2 : 0;
    this.onerror?.(new Event("error"));
  }
}

describe("openEventStream", () => {
  let sources: FakeSource[];
  let statuses: StreamStatus[];
  let events: Array<[string, unknown]>;

  beforeEach(() => {
    vi.useFakeTimers();
    sources = [];
    statuses = [];
    events = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const start = (extra: Partial<OpenEventStreamOptions> = {}) =>
    openEventStream({
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
