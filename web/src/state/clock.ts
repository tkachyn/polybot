/**
 * Server clock. Every REST response and SSE payload carries `serverTime`;
 * api/client.ts and api/stream.ts feed it here so clocks, countdowns and
 * relative times use server time, not a skewed local clock.
 *
 *   serverNow()        server-corrected epoch ms, outside React
 *   useNow(ms = 1000)  server-corrected now that re-renders every `ms`
 */
import { useCallback, useRef, useSyncExternalStore } from "react";

/** Samples further than this from the current estimate replace it outright. */
const RESYNC_THRESHOLD_MS = 5_000;
/** Weight of a new sample in the running estimate. */
const SMOOTHING = 0.3;

let offsetMs = 0;
let synced = false;

/**
 * Records a server timestamp. With `sentAt` (request start, local ms) the
 * sample is taken at the request midpoint, cancelling symmetric latency.
 */
export function noteServerTime(serverTime: number, sentAt?: number, receivedAt: number = Date.now()): void {
  if (!Number.isFinite(serverTime)) return;
  const localMidpoint = sentAt !== undefined && Number.isFinite(sentAt) ? (sentAt + receivedAt) / 2 : receivedAt;
  const sample = serverTime - localMidpoint;
  if (!synced || Math.abs(sample - offsetMs) > RESYNC_THRESHOLD_MS) {
    offsetMs = sample;
  } else {
    offsetMs += (sample - offsetMs) * SMOOTHING;
  }
  synced = true;
}

/** Server minus local, in ms. 0 until the first sample. */
export function getClockOffset(): number {
  return offsetMs;
}

export function isClockSynced(): boolean {
  return synced;
}

/** Server-corrected epoch milliseconds. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/** Test helper. */
export function resetClock(): void {
  offsetMs = 0;
  synced = false;
  for (const ticker of tickers.values()) clearTimeout(ticker.timer);
  tickers.clear();
}

// ---------------------------------------------------------------------------
// Shared tickers: one timer per interval, aligned to interval boundaries, so
// every clock on screen ticks together.
// ---------------------------------------------------------------------------

type Ticker = {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const tickers = new Map<number, Ticker>();

function tickerFor(intervalMs: number): Ticker {
  let ticker = tickers.get(intervalMs);
  if (!ticker) {
    ticker = { now: serverNow(), listeners: new Set(), timer: undefined };
    tickers.set(intervalMs, ticker);
  }
  return ticker;
}

function schedule(intervalMs: number, ticker: Ticker): void {
  const now = serverNow();
  // Fire just after the next boundary so a floored clock never repeats a second.
  const delay = intervalMs - (((now % intervalMs) + intervalMs) % intervalMs) + 5;
  ticker.timer = setTimeout(() => {
    ticker.now = serverNow();
    for (const listener of [...ticker.listeners]) listener();
    if (ticker.listeners.size > 0) schedule(intervalMs, ticker);
  }, delay);
}

/** Current tick value for an interval (stable between ticks). */
export function getNowSnapshot(intervalMs: number): number {
  return tickerFor(intervalMs).now;
}

/** Subscribes to ticks of an interval. Returns the unsubscribe function. */
export function subscribeNow(intervalMs: number, listener: () => void): () => void {
  const ticker = tickerFor(intervalMs);
  if (ticker.listeners.size === 0) {
    ticker.now = serverNow();
    schedule(intervalMs, ticker);
  }
  ticker.listeners.add(listener);
  return () => {
    ticker.listeners.delete(listener);
    if (ticker.listeners.size === 0) {
      clearTimeout(ticker.timer);
      ticker.timer = undefined;
      if (tickers.get(intervalMs) === ticker) tickers.delete(intervalMs);
    }
  };
}

const noopUnsubscribe = () => {};

/**
 * Server-corrected now, re-rendering every `intervalMs` (default 1000). Ticks
 * are shared and aligned, so all clocks change on the same frame. Pass
 * `enabled = false` to freeze (e.g. a finished fight) without breaking hook
 * order. Call it in small leaf components (ElapsedClock, Countdown) rather
 * than whole screens, so a tick re-renders only the figure that changes.
 */
export function useNow(intervalMs: number = 1000, enabled: boolean = true): number {
  const interval = Math.max(16, Math.floor(intervalMs));
  const frozen = useRef<number | null>(null);
  const subscribe = useCallback(
    (onChange: () => void) => (enabled ? subscribeNow(interval, onChange) : noopUnsubscribe),
    [interval, enabled],
  );
  const getSnapshot = useCallback(() => {
    if (enabled) return getNowSnapshot(interval);
    if (frozen.current === null) frozen.current = serverNow();
    return frozen.current;
  }, [interval, enabled]);
  const now = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (enabled) frozen.current = now;
  return now;
}
