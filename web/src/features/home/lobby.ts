/**
 * What the lobby shows for a filter and a search: the featured (hero) card,
 * one section of fight cards per status, and the counts on the filter row.
 * Pure, so every rule here is covered by lobby.test.ts.
 *
 *   All       featured · every other live fight · upcoming · latest resolved
 *   Live      featured (when live) · every other live fight
 *   Upcoming  every upcoming fight
 *   Resolved  every resolved fight, newest first
 *
 * Live includes fights whose trading is frozen: they are still running. A
 * search narrows every part, the featured card included.
 */
import type { FightStatus, FightSummary } from "@contract";
import { countByFilter, matchesFightQuery, resolvedNewestFirst, type FightFilter } from "./filter";

/** Resolved fights shown in the All view; the Resolved filter lists every one. */
export const ALL_VIEW_RESOLVED_LIMIT = 4;

export type LobbySection = {
  status: FightStatus;
  fights: FightSummary[];
  /** Fights in the section, before the All view's cap. */
  total: number;
};

export type Lobby = {
  /** The featured card, when it belongs in this view. */
  hero: FightSummary | null;
  /** In display order. A section can be empty. */
  sections: LobbySection[];
  /** Fights per filter, after the search. */
  counts: Record<FightFilter, number>;
};

export type LobbyInput = {
  fights: readonly FightSummary[];
  featured: FightSummary | null;
  filter: FightFilter;
  query: string;
};

export function buildLobby({ fights, featured, filter, query }: LobbyInput): Lobby {
  const q = query.trim();
  const matching = q ? fights.filter((f) => matchesFightQuery(f, q)) : [...fights];
  const shows = (status: FightStatus) => filter === "all" || filter === status;
  const hero = featured && shows(featured.status) && matchesFightQuery(featured, q) ? featured : null;
  const rest = hero ? matching.filter((f) => f.raceId !== hero.raceId) : matching;

  const sections: LobbySection[] = [];
  if (shows("live")) {
    const live = rest.filter((f) => f.status === "live");
    sections.push({ status: "live", fights: live, total: live.length });
  }
  if (shows("upcoming")) {
    const upcoming = rest.filter((f) => f.status === "upcoming");
    sections.push({ status: "upcoming", fights: upcoming, total: upcoming.length });
  }
  if (shows("resolved")) {
    const resolved = resolvedNewestFirst(rest);
    const shown = filter === "all" ? resolved.slice(0, ALL_VIEW_RESOLVED_LIMIT) : resolved;
    sections.push({ status: "resolved", fights: shown, total: resolved.length });
  }
  return { hero, sections, counts: countByFilter(matching) };
}

export type Rail = {
  /** Scheduled fights. Null while the lobby is loading. */
  upcoming: FightSummary[] | null;
  /** Newest first. Null while the lobby is loading. */
  resolved: FightSummary[] | null;
};

/** The rail's Upcoming and Past fights lists. The filter and the search do not apply: the rail is a fixed summary. */
export function buildRail({ fights, loaded }: { fights: readonly FightSummary[]; loaded: boolean }): Rail {
  if (!loaded) return { upcoming: null, resolved: null };
  return {
    upcoming: fights.filter((f) => f.status === "upcoming"),
    resolved: resolvedNewestFirst(fights),
  };
}
