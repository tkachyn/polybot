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
// Shared tickers: one timer per interval and phase, firing just after each
// boundary. A clock passes the phase of the timestamp it counts from or to
// (a fight's startedAt, freezesAt...), so its figure turns over when the
// server's would rather than up to a second late on the next whole
// wall-clock second. Clocks that share a phase (every clock of one fight)
// still tick together.
// ---------------------------------------------------------------------------

type Ticker = {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const tickers = new Map<string, Ticker>();

/** Fire this long after a boundary, so a floored clock never repeats a second. */
const TICK_LAG_MS = 5;

/** Where `atMs` falls within an interval: its phase, in [0, intervalMs). */
export function tickPhase(atMs: number, intervalMs: number): number {
  if (!Number.isFinite(atMs)) return 0;
  return ((Math.round(atMs) % intervalMs) + intervalMs) % intervalMs;
}

/** Delay from `now` until just after the next boundary at `phaseMs` past a multiple of `intervalMs`. */
export function nextTickDelay(now: number, intervalMs: number, phaseMs = 0): number {
  const into = (((now - phaseMs) % intervalMs) + intervalMs) % intervalMs;
  return intervalMs - into + TICK_LAG_MS;
}

function tickerKey(intervalMs: number, phaseMs: number): string {
  return `${intervalMs}:${phaseMs}`;
}

function tickerFor(intervalMs: number, phaseMs: number): Ticker {
  const key = tickerKey(intervalMs, phaseMs);
  let ticker = tickers.get(key);
  if (!ticker) {
    ticker = { now: serverNow(), listeners: new Set(), timer: undefined };
    tickers.set(key, ticker);
  }
  return ticker;
}

function schedule(intervalMs: number, phaseMs: number, ticker: Ticker): void {
  ticker.timer = setTimeout(() => {
    ticker.now = serverNow();
    for (const listener of [...ticker.listeners]) listener();
    if (ticker.listeners.size > 0) schedule(intervalMs, phaseMs, ticker);
  }, nextTickDelay(serverNow(), intervalMs, phaseMs));
}

/** Current tick value for an interval and phase (stable between ticks). */
export function getNowSnapshot(intervalMs: number, phaseMs = 0): number {
  return tickerFor(intervalMs, tickPhase(phaseMs, intervalMs)).now;
}

/** Subscribes to ticks of an interval at a phase. Returns the unsubscribe function. */
export function subscribeNow(intervalMs: number, listener: () => void, phaseMs = 0): () => void {
  const phase = tickPhase(phaseMs, intervalMs);
  const key = tickerKey(intervalMs, phase);
  const ticker = tickerFor(intervalMs, phase);
  if (ticker.listeners.size === 0) {
    ticker.now = serverNow();
    schedule(intervalMs, phase, ticker);
  }
  ticker.listeners.add(listener);
  return () => {
    ticker.listeners.delete(listener);
    if (ticker.listeners.size === 0) {
      clearTimeout(ticker.timer);
      ticker.timer = undefined;
      if (tickers.get(key) === ticker) tickers.delete(key);
    }
  };
}

const noopUnsubscribe = () => {};

/**
 * Server-corrected now, re-rendering every `intervalMs` (default 1000). Ticks
 * are shared: every clock with the same interval and phase changes on the
 * same frame. `phaseMs` is any timestamp the clock counts from or to; it
 * lines the ticks up with that timestamp's own second boundaries. Pass
 * `enabled = false` to freeze (e.g. a finished fight) without breaking hook
 * order. Call it in small leaf components (ElapsedClock, Countdown) rather
 * than whole screens, so a tick re-renders only the figure that changes.
 */
export function useNow(intervalMs: number = 1000, enabled: boolean = true, phaseMs: number = 0): number {
  const interval = Math.max(16, Math.floor(intervalMs));
  const phase = tickPhase(phaseMs, interval);
  const frozen = useRef<number | null>(null);
  const subscribe = useCallback(
    (onChange: () => void) => (enabled ? subscribeNow(interval, onChange, phase) : noopUnsubscribe),
    [interval, enabled, phase],
  );
  const getSnapshot = useCallback(() => {
    if (enabled) return getNowSnapshot(interval, phase);
    if (frozen.current === null) frozen.current = serverNow();
    return frozen.current;
  }, [interval, enabled, phase]);
  const now = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (enabled) frozen.current = now;
  return now;
}
