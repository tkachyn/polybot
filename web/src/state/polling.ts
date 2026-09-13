/**
 * REST stand-in for a live stream. While a stream is not delivering (still
 * connecting, reconnecting after a drop, or silent past its heartbeat), the
 * state hooks poll its REST twin so the screen keeps moving. Polling stops,
 * aborting any fetch in flight, as soon as the stream is open again.
 *
 *   useFallbackPolling(needsFallbackPolling(streamStatus), load, { intervalMs: 4_000, firstDelayMs: 800 });
 */
import { useEffect } from "react";
import type { StreamStatus } from "../api/stream";

/** True while REST polling has to stand in for the stream. */
export function needsFallbackPolling(status: StreamStatus): boolean {
  return status !== "open";
}

export type PollingOptions = {
  /** One fetch. The signal aborts when polling stops. Rejections are ignored. */
  load: (signal: AbortSignal) => Promise<unknown>;
  /** Pause between the end of one fetch and the start of the next. */
  intervalMs: number;
  /** Delay before the first fetch. Default `intervalMs`. */
  firstDelayMs?: number;
};

/**
 * Calls `load` after `firstDelayMs`, then again `intervalMs` after each call
 * settles (never two at once), until the returned `stop()` is called. `stop()`
 * aborts a fetch in flight, so a reply that lands after the stream recovered
 * cannot overwrite fresher stream data or leave a stale error behind.
 */
export function startPolling({ load, intervalMs, firstDelayMs = intervalMs }: PollingOptions): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    timer = undefined;
    let pending: Promise<unknown>;
    try {
      pending = load(controller.signal);
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending
      .catch(() => undefined)
      .then(() => {
        if (!controller.signal.aborted) timer = setTimeout(tick, intervalMs);
      });
  };
  timer = setTimeout(tick, firstDelayMs);
  return () => {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
}

/**
 * Polls with `load` while `active`. Restarts only when `active` flips (or
 * `load` changes), so a stream moving between "connecting" and
 * "reconnecting" does not reset the rhythm.
 */
export function useFallbackPolling(
  active: boolean,
  load: (signal: AbortSignal) => Promise<unknown>,
  { intervalMs, firstDelayMs }: { intervalMs: number; firstDelayMs?: number },
): void {
  useEffect(() => {
    if (!active) return undefined;
    return startPolling({ load, intervalMs, firstDelayMs });
  }, [active, load, intervalMs, firstDelayMs]);
}
