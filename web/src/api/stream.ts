/**
 * Server-sent events.
 *
 *   const status = useEventStream<FightStreamEvents>(fightStreamUrl(id), {
 *     snapshot: (data) => ..., // data: FightDetailResponse
 *     fight: (data) => ...,
 *     price: (data) => ...,
 *   });
 *
 * - Each event's `data:` is JSON-parsed. Malformed payloads are skipped.
 * - Payloads with a numeric `serverTime` update the server clock.
 * - Handlers are read through a ref: pass inline functions freely, listeners
 *   are not rebound on render. Rebinding (a reconnect) only happens when the
 *   URL or the SET of event names changes.
 * - If the browser gives up (HTTP error, backend restarting behind the dev
 *   proxy) the stream reconnects itself with capped exponential backoff.
 * - Watchdog: the server sends a `ping` event on connect and every few
 *   seconds (src/api/sse.ts). A connection that stays silent for two missed
 *   pings is dead even though the browser has not noticed (half-open TCP
 *   after sleep or Wi-Fi roaming, a hung proxy). It is closed and reopened,
 *   and the status goes to "reconnecting", which puts consumers back on REST
 *   polling until an event arrives again. A new connection that gets no
 *   response at all within `connectTimeoutMs` is replaced the same way.
 * - Every open stream is listed in a registry (`getTrackedStreams`) that the
 *   global connection banner reads (state/connection.ts).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { noteServerTime } from "../state/clock";

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export type StreamHandlers<E> = { [K in keyof E]?: (data: E[K]) => void };

/** The subset of EventSource this module uses (lets tests inject a fake). */
export type EventSourceLike = {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
};

export type EventSourceFactory = (url: string) => EventSourceLike;

const CLOSED = 2;

/** The server's heartbeat event: `{ intervalMs }`, sent on connect and every interval. */
export const PING_EVENT = "ping";
/** Ping interval assumed when a ping does not announce one (the server default). */
export const DEFAULT_PING_INTERVAL_MS = 5_000;
/** Pings a connection may miss before it counts as dead. */
export const HEARTBEAT_MISSED_PINGS = 2;
/** Slack on top of the missed pings, for network jitter and a busy main thread. */
export const HEARTBEAT_GRACE_MS = 2_000;
/** A new connection with no response at all (not even headers) after this long is replaced. */
export const CONNECT_TIMEOUT_MS = 8_000;
export const HIDDEN_GRACE_MS = 10_000;

/** Silence after which a stream whose server pings every `intervalMs` is dead. */
export function heartbeatTimeoutFor(intervalMs: number): number {
  return HEARTBEAT_MISSED_PINGS * intervalMs + HEARTBEAT_GRACE_MS;
}

export type OpenEventStreamOptions = {
  url: string;
  /** Event names to listen for (the `event:` field). */
  events: readonly string[];
  onEvent: (name: string, data: unknown) => void;
  onStatus?: (status: StreamStatus) => void;
  createSource?: EventSourceFactory;
  /** First manual retry delay. Default 1000 ms. */
  retryBaseMs?: number;
  /** Retry delay cap. Default 15000 ms. */
  retryMaxMs?: number;
  /**
   * Page visibility. While hidden for longer than `hiddenGraceMs` the
   * connection is closed, and it reopens as soon as the page is visible again
   * (every stream re-sends full state on connect). Browsers allow only 6
   * HTTP/1.1 connections per host and each tab holds up to 3 streams, so a
   * second tab would otherwise starve frames and orders. Defaults to the
   * document's visibility; null disables pausing.
   */
  visibility?: VisibilitySource | null;
  /** Default 10000 ms. */
  hiddenGraceMs?: number;
  /**
   * Silence (no event and no ping) after which a connection counts as dead
   * and is replaced. Default: two missed pings plus HEARTBEAT_GRACE_MS, from
   * the interval the server announces in its pings. The watchdog arms only
   * once the server has sent a ping, so a server without heartbeats (or a
   * proxy that buffers the body) never trips it.
   */
  heartbeatTimeoutMs?: number;
  /** Default CONNECT_TIMEOUT_MS. */
  connectTimeoutMs?: number;
  /**
   * Browser connectivity. Going offline drops the connection at once rather
   * than after the watchdog; coming back online reconnects without waiting
   * out the backoff. Defaults to the window's online/offline events; null
   * disables.
   */
  network?: NetworkSource | null;
  /** List the stream in the registry the connection banner reads. Default true. */
  track?: boolean;
};

export type VisibilitySource = {
  isHidden(): boolean;
  subscribe(listener: () => void): () => void;
};

export type NetworkSource = {
  isOnline(): boolean;
  subscribe(listener: () => void): () => void;
};

function documentVisibility(): VisibilitySource | null {
  if (typeof document === "undefined") return null;
  return {
    isHidden: () => document.visibilityState === "hidden",
    subscribe(listener) {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

/** `navigator.onLine` and the window's online/offline events; null outside a browser. */
export function browserNetwork(): NetworkSource | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  return {
    isOnline: () => navigator.onLine !== false,
    subscribe(listener) {
      window.addEventListener("online", listener);
      window.addEventListener("offline", listener);
      return () => {
        window.removeEventListener("online", listener);
        window.removeEventListener("offline", listener);
      };
    },
  };
}

const defaultFactory: EventSourceFactory = (url) => new EventSource(url) as unknown as EventSourceLike;

// ---------------------------------------------------------------------------
// Registry: every open stream, for the global connection banner.
// ---------------------------------------------------------------------------

export type TrackedStream = { readonly id: number; readonly url: string; readonly status: StreamStatus };

type RegistryEntry = { url: string; status: StreamStatus; reconnect: () => void };

const registry = new Map<number, RegistryEntry>();
const registryListeners = new Set<() => void>();
let registrySnapshot: readonly TrackedStream[] = [];
let nextStreamId = 1;

function publishRegistry(): void {
  registrySnapshot = Array.from(registry, ([id, entry]) => ({ id, url: entry.url, status: entry.status }));
  for (const listener of [...registryListeners]) listener();
}

/** Every open stream and its status. The same array until something changes. */
export function getTrackedStreams(): readonly TrackedStream[] {
  return registrySnapshot;
}

/** Called whenever a stream opens, closes or changes status. Returns unsubscribe. */
export function subscribeTrackedStreams(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

/** Reconnects every stream that is not delivering right now, skipping its backoff. */
export function reconnectStreams(): void {
  for (const entry of [...registry.values()]) {
    if (entry.status !== "open") entry.reconnect();
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * Framework-free stream connection with reconnect. Returns `close()`.
 * `useEventStream` wraps this; use it directly outside React.
 */
export function openEventStream(options: OpenEventStreamOptions): () => void {
  const create = options.createSource ?? defaultFactory;
  const baseMs = options.retryBaseMs ?? 1000;
  const maxMs = options.retryMaxMs ?? 15_000;
  const connectMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const consumerWantsPing = options.events.includes(PING_EVENT);

  let source: EventSourceLike | null = null;
  let closed = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let status: StreamStatus | null = null;
  // Watchdog deadline. `heartbeatMs` stays null until the server has shown
  // it sends heartbeats (its first ping); until then only a connection that
  // never answers is timed out.
  let heartbeatMs: number | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const visibility = options.visibility === undefined ? documentVisibility() : options.visibility;
  const graceMs = options.hiddenGraceMs ?? HIDDEN_GRACE_MS;
  // Paused = closed because the page is hidden. The status is left as it was:
  // nobody sees a hidden tab, and a status change would start REST polling.
  let paused = false;
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  const network = options.network === undefined ? browserNetwork() : options.network;
  const trackedId = nextStreamId++;
  const tracked: RegistryEntry | null =
    options.track === false ? null : { url: options.url, status: "connecting", reconnect: () => reconnectNow() };

  const setStatus = (next: StreamStatus) => {
    if (status === next) return;
    status = next;
    if (tracked) {
      tracked.status = next;
      if (registry.has(trackedId)) publishRegistry();
    }
    options.onStatus?.(next);
  };

  const disarm = () => {
    if (deadline !== undefined) clearTimeout(deadline);
    deadline = undefined;
  };

  const arm = (ms: number) => {
    disarm();
    deadline = setTimeout(onDeadline, ms);
  };

  /** The connection delivered something, so it is alive. */
  const noteActivity = () => {
    attempt = 0;
    if (heartbeatMs === null) disarm();
    else arm(heartbeatMs);
  };

  const drop = () => {
    disarm();
    source?.close();
    source = null;
  };

  const scheduleRetry = () => {
    if (closed || paused) return;
    disarm();
    setStatus("reconnecting");
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    const delay = Math.min(maxMs, baseMs * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(connect, delay);
  };

  function onDeadline() {
    deadline = undefined;
    if (closed || paused || !source) return;
    // Silent past its deadline: dead, even if the browser has not noticed.
    drop();
    scheduleRetry();
  }

  const dispatch = (name: string, raw: unknown) => {
    if (typeof raw !== "string") return;
    // Even a malformed payload proves the connection is alive.
    noteActivity();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      console.warn(`[stream] ignored malformed "${name}" payload from ${options.url}`);
      return;
    }
    if (typeof data === "object" && data !== null) {
      const serverTime = (data as { serverTime?: unknown }).serverTime;
      if (typeof serverTime === "number") noteServerTime(serverTime);
    }
    // A proxy can acknowledge an EventSource request while buffering its
    // response body indefinitely. Only call the stream open after an actual
    // application event arrives, so consumers keep their REST polling
    // fallback active behind tunnels that buffer SSE.
    setStatus("open");
    options.onEvent(name, data);
  };

  const onPing = (raw: unknown) => {
    let intervalMs = DEFAULT_PING_INTERVAL_MS;
    if (typeof raw === "string") {
      try {
        const announced = (JSON.parse(raw) as { intervalMs?: unknown } | null)?.intervalMs;
        if (typeof announced === "number" && Number.isFinite(announced) && announced > 0) intervalMs = announced;
      } catch {
        // A ping without a readable interval still proves the connection works.
      }
    }
    heartbeatMs = options.heartbeatTimeoutMs ?? heartbeatTimeoutFor(intervalMs);
    noteActivity();
  };

  const connect = () => {
    if (closed || paused) return;
    retryTimer = undefined;
    let es: EventSourceLike;
    try {
      es = create(options.url);
    } catch {
      scheduleRetry();
      return;
    }
    source = es;
    // No response at all within the connect timeout: replace it.
    arm(connectMs);
    es.onopen = () => {
      if (closed || source !== es) return;
      // Answered. Once the server is known to ping, data must follow within
      // a heartbeat; otherwise (an older server, or a proxy that buffers the
      // body) the open connection is trusted.
      if (heartbeatMs === null) disarm();
      else arm(heartbeatMs);
    };
    es.onerror = () => {
      if (closed || source !== es) return;
      if (es.readyState === CLOSED) {
        // The browser will not retry (HTTP error or wrong content type).
        drop();
        scheduleRetry();
      } else {
        // The browser is retrying on its own (server sent `retry: 2000`).
        // Take over if that attempt hangs.
        setStatus("reconnecting");
        arm(connectMs);
      }
    };
    for (const name of options.events) {
      if (name === PING_EVENT) continue;
      es.addEventListener(name, (event) => {
        if (closed || source !== es) return;
        dispatch(name, event.data);
      });
    }
    es.addEventListener(PING_EVENT, (event) => {
      if (closed || source !== es) return;
      onPing(event.data);
      if (consumerWantsPing) dispatch(PING_EVENT, event.data);
    });
  };

  /** Replaces the connection now, skipping any backoff. */
  const reconnectNow = () => {
    if (closed || paused) return;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    drop();
    attempt = 0;
    connect();
  };

  const onNetwork = () => {
    if (closed || paused || !network) return;
    if (!network.isOnline()) {
      // No network at all: the connection is gone. Say so now rather than
      // after the watchdog; the backoff runs until the network is back.
      if (source) {
        drop();
        scheduleRetry();
      }
      return;
    }
    // Back online: reconnect now instead of waiting out the backoff.
    if (status !== "open") reconnectNow();
  };

  const pause = () => {
    pauseTimer = undefined;
    if (closed || paused || !visibility?.isHidden()) return;
    paused = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    drop();
  };

  const onVisibility = () => {
    if (closed || !visibility) return;
    if (visibility.isHidden()) {
      if (!paused && pauseTimer === undefined) pauseTimer = setTimeout(pause, graceMs);
      return;
    }
    if (pauseTimer !== undefined) clearTimeout(pauseTimer);
    pauseTimer = undefined;
    if (paused) {
      paused = false;
      attempt = 0;
      connect();
    }
  };

  setStatus("connecting");
  if (tracked) {
    registry.set(trackedId, tracked);
    publishRegistry();
  }
  connect();
  const unsubscribeNetwork = network?.subscribe(onNetwork);
  const unsubscribeVisibility = visibility?.subscribe(onVisibility);
  if (visibility?.isHidden()) onVisibility();

  return () => {
    if (closed) return;
    closed = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    if (pauseTimer !== undefined) clearTimeout(pauseTimer);
    unsubscribeVisibility?.();
    unsubscribeNetwork?.();
    drop();
    if (tracked && registry.delete(trackedId)) publishRegistry();
    setStatus("closed");
  };
}

export type UseEventStreamOptions = {
  createSource?: EventSourceFactory;
  /**
   * Changing this value closes and reopens the stream immediately, skipping
   * any pending backoff (e.g. after re-creating a user the stream 404'd on).
   */
  reconnectKey?: string | number;
};

/**
 * Subscribes to an SSE stream while `url` is non-null. Returns the
 * connection status. Closes on unmount and on URL change.
 */
export function useEventStream<E extends Record<string, unknown>>(
  url: string | null,
  handlers: StreamHandlers<E>,
  options: UseEventStreamOptions = {},
): StreamStatus {
  const handlersRef = useRef(handlers);
  useLayoutEffect(() => {
    handlersRef.current = handlers;
  });
  const factoryRef = useRef(options.createSource);
  factoryRef.current = options.createSource;

  const eventKey = Object.keys(handlers).sort().join("\n");
  const reconnectKey = options.reconnectKey;
  const [status, setStatus] = useState<StreamStatus>(url ? "connecting" : "closed");

  useEffect(() => {
    if (!url) {
      setStatus("closed");
      return undefined;
    }
    const events = eventKey ? eventKey.split("\n") : [];
    return openEventStream({
      url,
      events,
      createSource: factoryRef.current,
      onStatus: setStatus,
      onEvent: (name, data) => {
        const handler = handlersRef.current[name as keyof E];
        handler?.(data as E[keyof E]);
      },
    });
  }, [url, eventKey, reconnectKey]);

  return url ? status : "closed";
}

/** Combines several stream statuses into one for an indicator. */
export function combineStreamStatus(statuses: readonly StreamStatus[]): StreamStatus {
  const active = statuses.filter((s) => s !== "closed");
  if (active.length === 0) return "closed";
  if (active.some((s) => s === "reconnecting")) return "reconnecting";
  if (active.some((s) => s === "connecting")) return "connecting";
  return "open";
}
