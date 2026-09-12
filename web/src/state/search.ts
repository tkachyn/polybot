/**
 * Global search. The top-bar input writes `?q=` on the home route ("/"),
 * keeping the home route's other params (e.g. the `status` filter). Screens
 * read the current query with useSearchQuery().
 *
 * URL conventions for "/":
 *   q       free-text search (raw; trim before matching)
 *   status  filter: all | live | upcoming | resolved (owned by the home screen)
 */
import { useCallback, useEffect } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

export const SEARCH_PARAM = "q";
export const HOME_STATUS_PARAM = "status";
export const HOME_PATH = "/";

let lastHomeSearch = "";

/** The current `?q=` value ("" when absent). Untrimmed. */
export function useSearchQuery(): string {
  const [params] = useSearchParams();
  return params.get(SEARCH_PARAM) ?? "";
}

/** Remembers the home route's params so searching from elsewhere keeps the filter. */
export function useTrackHomeSearch(): void {
  const location = useLocation();
  useEffect(() => {
    if (location.pathname === HOME_PATH) lastHomeSearch = location.search;
  }, [location.pathname, location.search]);
}

/**
 * Returns `setQuery(q)`: navigates to "/?q=..." preserving the home route's
 * other params. Replaces history while already on home (no entry per
 * keystroke); pushes when arriving from another route.
 */
export function useSetSearchQuery(): (query: string) => void {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (query: string) => {
      const onHome = location.pathname === HOME_PATH;
      const params = new URLSearchParams(onHome ? location.search : lastHomeSearch);
      if (query) params.set(SEARCH_PARAM, query);
      else params.delete(SEARCH_PARAM);
      const search = params.toString();
      navigate({ pathname: HOME_PATH, search: search ? `?${search}` : "" }, { replace: onHome });
    },
    [location.pathname, location.search, navigate],
  );
}
