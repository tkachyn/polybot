/**
 * Is the live data on screen current? Drives the global connection banner
 * (components/ConnectionBanner.tsx), which the app shell renders once.
 *
 *   const banner = useConnectionBanner();
 *   // { kind: "hidden" } | { kind: "stale", offline, everLive } | { kind: "resumed", firstConnection }
 *
 * Live data is stale while any open stream is reconnecting (it dropped, or
 * went silent past its heartbeat: api/stream.ts) or the browser reports no
 * network. The banner appears once that has lasted BANNER_SHOW_DELAY_MS, so
 * a sub-second blip never flashes; it stays until every stream delivers
 * again, then says so for BANNER_RESUMED_MS and hides.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { browserNetwork, getTrackedStreams, subscribeTrackedStreams, type StreamStatus } from "../api/stream";

export type LiveHealth = {
  /** Some live data on screen may be out of date. */
  stale: boolean;
  /** The browser reports no network at all. */
  offline: boolean;
  /** At least one stream is delivering. */
  live: boolean;
};

/** Health of the live data, from the open streams and the browser's network state. Pure. */
export function liveHealth(streams: readonly { status: StreamStatus }[], online: boolean): LiveHealth {
  return {
    stale: !online || streams.some((s) => s.status === "reconnecting"),
    offline: !online,
    live: streams.some((s) => s.status === "open"),
  };
}

export type ConnectionBannerState =
  | { kind: "hidden" }
  | {
      kind: "stale";
      /** The browser has no network (rather than the server or the path to it failing). */
      offline: boolean;
      /** Live data arrived earlier in this visit (rather than never, so far). */
      everLive: boolean;
    }
  | {
      kind: "resumed";
      /** The first connection of the visit succeeded late (nothing was live before). */
      firstConnection: boolean;
    };

export const BANNER_SHOW_DELAY_MS = 1_000;
export const BANNER_RESUMED_MS = 3_000;

export type ConnectionBannerModel = {
  /** Feeds the latest health. */
  update(health: LiveHealth): void;
  getState(): ConnectionBannerState;
  subscribe(listener: () => void): () => void;
  /** Cancels pending timers; the next update re-arms what is needed. */
  stop(): void;
};

const HIDDEN: ConnectionBannerState = { kind: "hidden" };

function sameState(a: ConnectionBannerState, b: ConnectionBannerState): boolean {
  if (a.kind === "stale" && b.kind === "stale") return a.offline === b.offline && a.everLive === b.everLive;
  if (a.kind === "resumed" && b.kind === "resumed") return a.firstConnection === b.firstConnection;
  return a.kind === b.kind;
}

/** The banner's state machine, framework-free (timers only). */
export function createConnectionBanner({
  showDelayMs = BANNER_SHOW_DELAY_MS,
  resumedMs = BANNER_RESUMED_MS,
}: { showDelayMs?: number; resumedMs?: number } = {}): ConnectionBannerModel {
  let state: ConnectionBannerState = HIDDEN;
  let health: LiveHealth = { stale: false, offline: false, live: false };
  let everLive = false;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  const set = (next: ConnectionBannerState) => {
    if (sameState(next, state)) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const clearShow = () => {
    if (showTimer !== undefined) clearTimeout(showTimer);
    showTimer = undefined;
  };
  const clearHide = () => {
    if (hideTimer !== undefined) clearTimeout(hideTimer);
    hideTimer = undefined;
  };
  const showStale = () => set({ kind: "stale", offline: health.offline, everLive });

  return {
    update(next) {
      health = next;
      if (next.live) everLive = true;
      if (next.stale) {
        clearHide();
        // Already on screen: switch or refresh the copy at once.
        if (state.kind !== "hidden") {
          showStale();
          return;
        }
        if (showTimer === undefined) {
          showTimer = setTimeout(() => {
            showTimer = undefined;
            if (health.stale) showStale();
          }, showDelayMs);
        }
        return;
      }
      clearShow();
      if (state.kind === "stale") set({ kind: "resumed", firstConnection: !state.everLive });
      if (state.kind === "resumed" && hideTimer === undefined) {
        hideTimer = setTimeout(() => {
          hideTimer = undefined;
          set(HIDDEN);
        }, resumedMs);
      }
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop() {
      clearShow();
      clearHide();
    },
  };
}

/** The global banner's state, fed by the stream registry and the browser's network events. */
export function useConnectionBanner(): ConnectionBannerState {
  const [model] = useState(createConnectionBanner);
  useEffect(() => {
    const network = browserNetwork();
    const sync = () => model.update(liveHealth(getTrackedStreams(), network ? network.isOnline() : true));
    sync();
    const unsubscribeStreams = subscribeTrackedStreams(sync);
    const unsubscribeNetwork = network?.subscribe(sync);
    return () => {
      unsubscribeStreams();
      unsubscribeNetwork?.();
      model.stop();
    };
  }, [model]);
  return useSyncExternalStore(model.subscribe, model.getState, model.getState);
}
