/**
 * Pure lobby helpers: status filter, free-text search and summaries.
 * Shared by the home (Fights) and Resolved screens.
 */
import type { FightStatus, FightSummary } from "@contract";
import { fightNumberDigits } from "../../lib/format";

export type FightFilter = "all" | FightStatus;

export const FIGHT_FILTERS: readonly FightFilter[] = ["all", "live", "upcoming", "resolved"];

/** URL search param holding the home filter (`/?filter=live`). Absent = all. */
export const FILTER_PARAM = "filter";

export function isFightFilter(value: unknown): value is FightFilter {
  return typeof value === "string" && (FIGHT_FILTERS as readonly string[]).includes(value);
}

/** Unknown or missing values read as "all". */
export function parseFightFilter(value: string | null | undefined): FightFilter {
  const v = value?.trim().toLowerCase();
  return isFightFilter(v) ? v : "all";
}

/**
 * Case-insensitive match on the task title, the fight number ("412", "0412",
 * "#0412", "fight 412") or an agent's name. An empty query matches everything.
 */
export function matchesFightQuery(fight: FightSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (fight.title.toLowerCase().includes(q)) return true;
  const numberQuery = q.replace(/^(fight\s*)?#?\s*/, "");
  if (/^\d+$/.test(numberQuery) && fightNumberDigits(fight.number).includes(numberQuery)) return true;
  return fight.agents.some((a) => a.agent.name.toLowerCase().includes(q));
}

export function filterFights(fights: readonly FightSummary[], filter: FightFilter, query: string): FightSummary[] {
  return fights.filter((f) => (filter === "all" || f.status === filter) && matchesFightQuery(f, query));
}

export function countByFilter(fights: readonly FightSummary[]): Record<FightFilter, number> {
  const counts: Record<FightFilter, number> = { all: fights.length, live: 0, upcoming: 0, resolved: 0 };
  for (const f of fights) counts[f.status] += 1;
  return counts;
}

function resolvedAt(fight: FightSummary): number {
  return fight.finishedAt ?? fight.startedAt ?? fight.createdAt;
}

/** Resolved fights only, newest resolution first (ties: higher number first). */
export function resolvedNewestFirst(fights: readonly FightSummary[]): FightSummary[] {
  return fights
    .filter((f) => f.status === "resolved")
    .sort((a, b) => resolvedAt(b) - resolvedAt(a) || b.number - a.number);
}

export function totalVolume(fights: readonly FightSummary[]): number {
  return fights.reduce((sum, f) => sum + (Number.isFinite(f.volume) ? f.volume : 0), 0);
}

/** Display name of the winning agent, or null (void, or not resolved yet). */
export function winnerName(fight: Pick<FightSummary, "winnerRacerId" | "agents">): string | null {
  if (!fight.winnerRacerId) return null;
  return fight.agents.find((a) => a.racerId === fight.winnerRacerId)?.agent.name ?? null;
}
