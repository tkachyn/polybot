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
 * search narrows every part, the featured card included. Preview fights
 * (./placeholders) stand in only for upcoming fights, only when the backend
 * has none, and never in search results.
 */
import type { FightStatus, FightSummary } from "@contract";
import { countByFilter, matchesFightQuery, resolvedNewestFirst, type FightFilter } from "./filter";

/** Resolved fights shown in the All view; the Resolved filter lists every one. */
export const ALL_VIEW_RESOLVED_LIMIT = 4;

export type LobbySection = {
  status: FightStatus;
  fights: FightSummary[];
  /** The cards are placeholder previews, not real fights. */
  preview: boolean;
  /** Fights represented in the section, before the All view's cap. */
  total: number;
};

export type Lobby = {
  /** The featured card, when it belongs in this view. */
  hero: FightSummary | null;
  /** In display order. A section can be empty. */
  sections: LobbySection[];
  /** Fights represented per filter, including visible upcoming previews. */
  counts: Record<FightFilter, number>;
};

export type LobbyInput = {
  fights: readonly FightSummary[];
  featured: FightSummary | null;
  filter: FightFilter;
  query: string;
  /** Placeholder fights allowed on screen right now (empty when they are not). */
  previews: readonly FightSummary[];
};

export function buildLobby({ fights, featured, filter, query, previews }: LobbyInput): Lobby {
  const q = query.trim();
  const matching = q ? fights.filter((f) => matchesFightQuery(f, q)) : [...fights];
  const noneScheduled = !fights.some((f) => f.status === "upcoming");
  const upcomingPreviews = noneScheduled && !q
    ? previews.filter((fight) => fight.status === "upcoming")
    : [];
  const counts = countByFilter(matching);
  if (upcomingPreviews.length > 0) {
    counts.upcoming += upcomingPreviews.length;
    counts.all += upcomingPreviews.length;
  }
  const shows = (status: FightStatus) => filter === "all" || filter === status;
  const hero = featured && shows(featured.status) && matchesFightQuery(featured, q) ? featured : null;
  const rest = hero ? matching.filter((f) => f.raceId !== hero.raceId) : matching;

  const sections: LobbySection[] = [];
  if (shows("live")) {
    const live = rest.filter((f) => f.status === "live");
    sections.push({ status: "live", fights: live, preview: false, total: live.length });
  }
  if (shows("upcoming")) {
    const upcoming = rest.filter((f) => f.status === "upcoming");
    sections.push(
      upcomingPreviews.length > 0
        ? { status: "upcoming", fights: upcomingPreviews, preview: true, total: upcomingPreviews.length }
        : { status: "upcoming", fights: upcoming, preview: false, total: upcoming.length },
    );
  }
  if (shows("resolved")) {
    const resolved = resolvedNewestFirst(rest);
    const shown = filter === "all" ? resolved.slice(0, ALL_VIEW_RESOLVED_LIMIT) : resolved;
    sections.push({ status: "resolved", fights: shown, preview: false, total: resolved.length });
  }
  return { hero, sections, counts };
}

/** One rail list. `preview`: the rows are placeholders. */
export type RailList = { fights: FightSummary[]; preview: boolean };

export type Rail = {
  /** Null while the lobby is loading. */
  upcoming: RailList | null;
  /** Newest first. Null while the lobby is loading. */
  resolved: RailList | null;
};

/**
 * The rail's Upcoming and Past fights lists. Real fights always win; previews
 * fill a list only when the backend has none of that status. The filter and
 * the search do not apply: the rail is a fixed summary.
 */
export function buildRail({
  fights,
  loaded,
  previews,
}: {
  fights: readonly FightSummary[];
  loaded: boolean;
  previews: readonly FightSummary[];
}): Rail {
  if (!loaded) return { upcoming: null, resolved: null };
  const list = (real: FightSummary[], status: FightStatus): RailList => {
    if (real.length > 0) return { fights: real, preview: false };
    const standIns = previews.filter((f) => f.status === status);
    return { fights: standIns, preview: standIns.length > 0 };
  };
  return {
    upcoming: list(
      fights.filter((f) => f.status === "upcoming"),
      "upcoming",
    ),
    resolved: list(resolvedNewestFirst(fights), "resolved"),
  };
}
