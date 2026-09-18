/**
 * Which primary tab a URL belongs to. A tab is active only on the routes it
 * owns (see App.tsx), so a mistyped address under a section, such as
 * /portfolio/extra, highlights nothing, like any other unknown page.
 */
import { matchPath } from "react-router-dom";

/** Route patterns per tab, keyed by the tab's `to`. */
export const NAV_ROUTE_PATTERNS: Readonly<Record<string, readonly string[]>> = {
  "/fights": ["/fights", "/fights/:raceId", "/fights/:raceId/standings"],
  "/portfolio": ["/portfolio"],
  "/evaluations": ["/evaluations"],
  "/resolved": ["/resolved"],
  "/wallet": ["/wallet"],
};

/** True when `pathname` is one of the routes behind the tab at `to`. */
export function isNavTabActive(to: string, pathname: string): boolean {
  const patterns = NAV_ROUTE_PATTERNS[to] ?? [to];
  return patterns.some((path) => matchPath({ path, end: true }, pathname) !== null);
}
