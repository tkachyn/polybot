/**
 * One fight, live: detail plus price history.
 *
 *   const { fight, priceHistory, status, error } = useFightDetail(raceId);
 *
 * Source: `GET /api/fights/:raceId/stream`.
 * - `snapshot` (every connect/reconnect): full replace, including history.
 * - `fight`: replaces the detail if its serverTime is not older.
 * - `price`: appended when its `t` is newer than the last point.
 * While the stream is not open (still connecting, reconnecting, or silent
 * past its heartbeat: see api/stream.ts), `GET /api/fights/:raceId` is
 * polled. A 404 sets status "not_found" and stops both stream and polling.
 *
 * A new frame capture shows up as a bumped `agents[i].frame.seq`; build its
 * image URL with `fightFrameUrl(raceId, racerId, seq)` from api/client.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { FightDetail, FightDetailResponse, FightStreamEvents, PricePoint } from "@contract";
import { ApiFailure, fightStreamUrl, getFight, isAbortError, isApiFailure, toApiFailure } from "../api/client";
import { useEventStream, type StreamStatus } from "../api/stream";
import { needsFallbackPolling, useFallbackPolling } from "./polling";

/** Matches the server's history cap. */
export const MAX_PRICE_POINTS = 2000;

/**
 * - loading: nothing yet.
 * - live: stream open.
 * - polling: data from the REST fallback while the stream reconnects.
 * - error: nothing yet and the last fetch failed (retrying).
 * - not_found: the fight does not exist.
 */
export type FightDetailStatus = "loading" | "live" | "polling" | "error" | "not_found";

export type FightDetailState = {
  fight: FightDetail | null;
  /** Oldest first. */
  priceHistory: PricePoint[];
  status: FightDetailStatus;
  error: ApiFailure | null;
  streamStatus: StreamStatus;
  serverTime: number | null;
  /** Re-fetches over REST. Never rejects. */
  refresh: () => Promise<void>;
};

/** Appends `point` if it is newer than the last one; keeps at most `cap` points. Pure. */
export function appendPricePoint(history: readonly PricePoint[], point: PricePoint, cap = MAX_PRICE_POINTS): PricePoint[] {
  const last = history[history.length - 1];
  if (last && point.t <= last.t) return history as PricePoint[];
  const next = history.length >= cap ? history.slice(history.length - cap + 1) : history.slice();
  next.push(point);
  return next;
}

type State = {
  raceId: string | null;
  fight: FightDetail | null;
  priceHistory: PricePoint[];
  serverTime: number;
  error: ApiFailure | null;
  notFound: boolean;
};

type Action =
  | { type: "reset"; raceId: string | null }
  | { type: "snapshot"; raceId: string; data: FightDetailResponse; force: boolean }
  | { type: "fight"; raceId: string; serverTime: number; fight: FightDetail }
  | { type: "price"; raceId: string; point: PricePoint }
  | { type: "error"; raceId: string; error: ApiFailure };

function initial(raceId: string | null): State {
  return { raceId, fight: null, priceHistory: [], serverTime: -Infinity, error: null, notFound: false };
}

function reducer(state: State, action: Action): State {
  if (action.type === "reset") return initial(action.raceId);
  if (action.raceId !== state.raceId) return state;
  switch (action.type) {
    case "snapshot":
      if (!action.force && action.data.serverTime < state.serverTime) return state;
      return {
        ...state,
        fight: action.data.fight,
        priceHistory: action.data.priceHistory.slice(-MAX_PRICE_POINTS),
        serverTime: action.data.serverTime,
        error: null,
        notFound: false,
      };
    case "fight":
      if (action.serverTime < state.serverTime) return state;
      return { ...state, fight: action.fight, serverTime: action.serverTime, error: null };
    case "price": {
      const priceHistory = appendPricePoint(state.priceHistory, action.point);
      return priceHistory === state.priceHistory ? state : { ...state, priceHistory };
    }
    case "error":
      return { ...state, error: action.error, notFound: isApiFailure(action.error, "not_found") };
  }
}

const POLL_MS = 4_000;
const FIRST_POLL_MS = 800;

export function useFightDetail(raceId: string | null | undefined): FightDetailState {
  const id = raceId || null;
  const [raw, dispatch] = useReducer(reducer, id, initial);
  const state = raw.raceId === id ? raw : initial(id);
  const idRef = useRef(id);
  idRef.current = id;

  useEffect(() => {
    dispatch({ type: "reset", raceId: id });
  }, [id]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const target = idRef.current;
    if (!target) return;
    try {
      const data = await getFight(target, signal);
      dispatch({ type: "snapshot", raceId: target, data, force: false });
    } catch (err) {
      // An aborted poll (the stream came back) says nothing about the fight.
      if (!isAbortError(err) && !signal?.aborted) dispatch({ type: "error", raceId: target, error: toApiFailure(err) });
    }
  }, []);

  const refresh = useCallback(() => load(), [load]);

  const streamStatus = useEventStream<FightStreamEvents>(id && !state.notFound ? fightStreamUrl(id) : null, {
    snapshot: (data) => {
      if (id) dispatch({ type: "snapshot", raceId: id, data, force: true });
    },
    fight: (data) => {
      if (id) dispatch({ type: "fight", raceId: id, serverTime: data.serverTime, fight: data.fight });
    },
    price: (data) => {
      if (id) dispatch({ type: "price", raceId: id, point: data.point });
    },
  });

  // REST fallback while the stream is not delivering.
  useFallbackPolling(Boolean(id) && !state.notFound && needsFallbackPolling(streamStatus), load, {
    intervalMs: POLL_MS,
    firstDelayMs: FIRST_POLL_MS,
  });

  let status: FightDetailStatus;
  if (state.notFound) status = "not_found";
  else if (!state.fight) status = state.error ? "error" : "loading";
  else status = streamStatus === "open" ? "live" : "polling";

  return {
    fight: state.fight,
    priceHistory: state.priceHistory,
    status,
    error: state.error,
    streamStatus,
    serverTime: Number.isFinite(state.serverTime) ? state.serverTime : null,
    refresh,
  };
}
