/**
 * One-off REST data (leaderboard, my-fight settlement, ...).
 *
 *   const board = useApiResource((signal) => getLeaderboard(signal), [], { pollMs: 30_000 });
 *   const mine = useApiResource(userId ? (s) => getMyFight(raceId, userId, s) : null, [raceId, userId]);
 *
 * - `load` is re-run when `deps` change (like useEffect). Pass null to idle.
 * - The previous request is aborted on change/unmount; aborts are ignored.
 * - `data` is kept while reloading (no flash back to a skeleton).
 * - Polling pauses while the tab is hidden and resumes on return.
 */
import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { ApiFailure, isAbortError, toApiFailure } from "../api/client";

export type ApiResource<T> = {
  data: T | null;
  error: ApiFailure | null;
  /** True while a request is in flight. */
  loading: boolean;
  /** Re-runs the loader now. */
  reload: () => void;
  /** Replace or update the data locally (e.g. after a mutation response). */
  setData: (next: T | null | ((prev: T | null) => T | null)) => void;
};

export type ApiResourceOptions = {
  /** Re-fetch every N ms while mounted and the tab is visible. */
  pollMs?: number;
};

export function useApiResource<T>(
  load: ((signal: AbortSignal) => Promise<T>) | null,
  deps: DependencyList,
  options: ApiResourceOptions = {},
): ApiResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(load !== null);
  const [token, setToken] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const enabled = load !== null;
  const { pollMs } = options;

  useEffect(() => {
    const run = loadRef.current;
    if (!run) {
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    run(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        setError(toApiFailure(err));
        setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-supplied deps
  }, [enabled, token, ...deps]);

  useEffect(() => {
    if (!enabled || !pollMs || pollMs <= 0) return undefined;
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") setToken((n) => n + 1);
    }, pollMs);
    return () => clearInterval(timer);
  }, [enabled, pollMs]);

  const reload = useCallback(() => setToken((n) => n + 1), []);

  return { data, error, loading, reload, setData };
}
