/**
 * Fetch policy for one fight's evaluation (GET /api/fights/:raceId/evaluation).
 *
 * The fight stream re-sends `fight.evaluation` ({ status, updatedAt }) inside
 * every `fight` event, several times a second. The evaluation is refetched
 * only when that pointer's version changes, never on a plain tick:
 *
 * - `sync(raceId, version)` declares what the screen wants. The first sync for
 *   a fight fetches at once (on mount, with or without a pointer).
 * - Re-declaring the same version does nothing, however often it happens.
 * - A new version fetches once. At most one request is in flight: versions
 *   that change during a request collapse into one trailing fetch for the
 *   newest, and pointer-driven fetches start at least `minIntervalMs` apart.
 * - A new raceId aborts the old request and starts over with no data.
 * - A failure keeps the last good evaluation and sets `error`. It is not
 *   retried on its own: the next version change, or `reload()`, tries again.
 *
 * Framework-free so it can be tested without a DOM; `useFightEvaluation`
 * wraps it for React.
 */
import type { FightEvaluation, FightEvaluationPointer, FightEvaluationResponse } from "@contract";
import { isAbortError, toApiFailure, type ApiFailure } from "../../api/client";

/** Minimum gap between two pointer-driven fetches. */
export const DEFAULT_MIN_INTERVAL_MS = 1_000;

/** Version used while the fight carries no pointer (not started, or an older backend). */
export const NO_POINTER_VERSION = "none";

/** A pointer's version. Equal pointers (re-sent on every stream tick) give equal versions. */
export function evaluationVersion(pointer: FightEvaluationPointer | null | undefined): string {
  return pointer ? `${pointer.status}:${pointer.updatedAt}` : NO_POINTER_VERSION;
}

export type EvaluationLoadState = {
  raceId: string | null;
  evaluation: FightEvaluation | null;
  /** serverTime of the response on screen. */
  serverTime: number | null;
  /** The latest failure; cleared by the next success. */
  error: ApiFailure | null;
  /** A request is in flight or scheduled. */
  loading: boolean;
  /** The version the evaluation on screen was fetched for. */
  version: string | null;
};

export function initialEvaluationState(raceId: string | null): EvaluationLoadState {
  return { raceId, evaluation: null, serverTime: null, error: null, loading: raceId !== null, version: null };
}

export type EvaluationFetcher = (raceId: string, signal: AbortSignal) => Promise<FightEvaluationResponse>;

export type EvaluationLoaderOptions = {
  fetch: EvaluationFetcher;
  /** Called with a new state object on every change. */
  onChange?: (state: EvaluationLoadState) => void;
  /** Default {@link DEFAULT_MIN_INTERVAL_MS}. */
  minIntervalMs?: number;
  /** Clock for the interval (default Date.now). */
  now?: () => number;
};

export type EvaluationLoader = {
  /** Declares the wanted fight and pointer version (see {@link evaluationVersion}). */
  sync(raceId: string | null, version: string): void;
  /** Fetches again now, whatever the version (a user retry). */
  reload(): void;
  getState(): EvaluationLoadState;
  /** Aborts any request; later results and calls are ignored. */
  dispose(): void;
};

export function createEvaluationLoader(options: EvaluationLoaderOptions): EvaluationLoader {
  const minInterval = Math.max(0, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
  const now = options.now ?? Date.now;

  let state = initialEvaluationState(null);
  /** The version the screen wants. */
  let wanted: string = NO_POINTER_VERSION;
  /** The version the latest request (finished or not) was started for. */
  let requested: string | null = null;
  let inFlight: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastStartAt = Number.NEGATIVE_INFINITY;
  let disposed = false;

  const replace = (next: EvaluationLoadState) => {
    state = next;
    options.onChange?.(state);
  };
  const patch = (changes: Partial<EvaluationLoadState>) => replace({ ...state, ...changes });

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const start = () => {
    const raceId = state.raceId;
    if (disposed || raceId === null) return;
    clearTimer();
    const version = wanted;
    const controller = new AbortController();
    inFlight = controller;
    requested = version;
    lastStartAt = now();
    if (!state.loading) patch({ loading: true });

    let pending: Promise<FightEvaluationResponse>;
    try {
      pending = options.fetch(raceId, controller.signal);
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (response) => {
        if (inFlight !== controller || controller.signal.aborted) return;
        inFlight = null;
        patch({ evaluation: response.evaluation, serverTime: response.serverTime, error: null, loading: false, version });
        pump();
      },
      (error: unknown) => {
        if (inFlight !== controller || controller.signal.aborted || isAbortError(error)) return;
        inFlight = null;
        patch({ error: toApiFailure(error), loading: false });
        pump();
      },
    );
  };

  /** Starts, schedules or skips a fetch for the wanted version. */
  const pump = () => {
    if (disposed || state.raceId === null || inFlight || timer !== undefined) return;
    if (wanted === requested) return;
    const wait = lastStartAt + minInterval - now();
    if (wait <= 0) {
      start();
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      pump();
    }, wait);
    if (!state.loading) patch({ loading: true });
  };

  return {
    sync(raceId, version) {
      if (disposed) return;
      wanted = version;
      if (raceId !== state.raceId) {
        inFlight?.abort();
        inFlight = null;
        clearTimer();
        requested = null;
        lastStartAt = Number.NEGATIVE_INFINITY;
        replace(initialEvaluationState(raceId));
      }
      pump();
    },
    reload() {
      if (disposed || state.raceId === null) return;
      inFlight?.abort();
      inFlight = null;
      start();
    },
    getState: () => state,
    dispose() {
      if (disposed) return;
      disposed = true;
      inFlight?.abort();
      inFlight = null;
      clearTimer();
    },
  };
}
