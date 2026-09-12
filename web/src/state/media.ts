/**
 * Media queries in JS, for layout decisions CSS alone cannot make.
 * Prefer CSS media queries for styling; the breakpoints match tokens.css.
 */
import { useCallback, useSyncExternalStore } from "react";

/** Below this width everything reflows (flexible tracks, wrapping rows). */
export const BREAKPOINT_REFLOW = "(max-width: 999px)";
/** Below this width the layout tightens. */
export const BREAKPOINT_COMPACT = "(max-width: 759px)";

function mql(query: string): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

/** True while `query` matches; re-renders on change. False during SSR/tests. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = mql(query);
      if (!list) return () => {};
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  const get = () => mql(query)?.matches ?? false;
  return useSyncExternalStore(subscribe, get, () => false);
}
