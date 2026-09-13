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
};

export type VisibilitySource = {
  isHidden(): boolean;
  subscribe(listener: () => void): () => void;
};

export const HIDDEN_GRACE_MS = 10_000;

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

const defaultFactory: EventSourceFactory = (url) => new EventSource(url) as unknown as EventSourceLike;

/**
 * Framework-free stream connection with reconnect. Returns `close()`.
 * `useEventStream` wraps this; use it directly outside React.
 */
export function openEventStream(options: OpenEventStreamOptions): () => void {
  const create = options.createSource ?? defaultFactory;
  const baseMs = options.retryBaseMs ?? 1000;
  const maxMs = options.retryMaxMs ?? 15_000;

  let source: EventSourceLike | null = null;
  let closed = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let status: StreamStatus | null = null;
  const visibility = options.visibility === undefined ? documentVisibility() : options.visibility;
  const graceMs = options.hiddenGraceMs ?? HIDDEN_GRACE_MS;
  // Paused = closed because the page is hidden. The status is left as it was:
  // nobody sees a hidden tab, and a status change would start REST polling.
  let paused = false;
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;

  const setStatus = (next: StreamStatus) => {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  };

  const dispatch = (name: string, raw: unknown) => {
    if (typeof raw !== "string") return;
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
    attempt = 0;
    setStatus("open");
    options.onEvent(name, data);
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
    es.onopen = () => {
      if (closed || source !== es) return;
      attempt = 0;
    };
    es.onerror = () => {
      if (closed || source !== es) return;
      if (es.readyState === CLOSED) {
        // The browser will not retry (HTTP error or wrong content type).
        es.close();
        source = null;
        scheduleRetry();
      } else {
        // The browser is retrying on its own (server sent `retry: 2000`).
        setStatus("reconnecting");
      }
    };
    for (const name of options.events) {
      es.addEventListener(name, (event) => {
        if (closed || source !== es) return;
        dispatch(name, event.data);
      });
    }
  };

  const scheduleRetry = () => {
    if (closed || paused) return;
    setStatus("reconnecting");
    const delay = Math.min(maxMs, baseMs * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(connect, delay);
  };

  const onOnline = () => {
    if (!closed && !source && retryTimer !== undefined) {
      clearTimeout(retryTimer);
      attempt = 0;
      connect();
    }
  };

  const pause = () => {
    pauseTimer = undefined;
    if (closed || paused || !visibility?.isHidden()) return;
    paused = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    source?.close();
    source = null;
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
  connect();
  const win = typeof window === "undefined" ? undefined : window;
  win?.addEventListener("online", onOnline);
  const unsubscribeVisibility = visibility?.subscribe(onVisibility);
  if (visibility?.isHidden()) onVisibility();

  return () => {
    if (closed) return;
    closed = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    if (pauseTimer !== undefined) clearTimeout(pauseTimer);
    unsubscribeVisibility?.();
    source?.close();
    source = null;
    win?.removeEventListener("online", onOnline);
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
