/**
 * Which fight the lobby features, and keeping that choice put.
 *
 * The featured card is the fight a spectator is watching, so it must never
 * swap under them mid-race:
 *
 *   1. The featured fight stays while it is live, with trading open or frozen.
 *   2. When it resolves it stays for FEATURED_RESULT_HOLD_MS, long enough to
 *      read the result, and then the lobby moves on.
 *   3. A fight about to start (inside FEATURED_INTRO_WINDOW_MS of it) takes
 *      the card from anything but a live featured fight, even a result on
 *      hold: its intro plays there (./FeaturedIntro).
 *   4. A fresh pick is the live fight with open trading and the most volume
 *      (ties: the earlier start, then the lower number). Failing that, a
 *      frozen live fight, then the soonest upcoming fight, then the most
 *      recently resolved one.
 *
 * An upcoming or resolved fallback gives way as soon as a fight is live.
 */
import { useEffect, useState } from "react";
import type { FightSummary } from "@contract";
import { serverNow } from "../../state/clock";
import { FIGHT_INTRO_LEAD_MS, FIGHT_INTRO_PRIME_MS } from "../fight/introVideo";
import { resolvedNewestFirst } from "./filter";

/** How long a featured fight that has just resolved stays up with its result. */
export const FEATURED_RESULT_HOLD_MS = 15_000;

/** An upcoming fight takes the card this long before it starts: from when its intro starts loading. */
export const FEATURED_INTRO_WINDOW_MS = FIGHT_INTRO_LEAD_MS + FIGHT_INTRO_PRIME_MS;

/** Upcoming with its start near. One past its start time is still about to start: the server ticks it live. */
function inIntroWindow(fight: FightSummary, now: number): boolean {
  return fight.status === "upcoming" && fight.startsAt !== null && fight.startsAt - now <= FEATURED_INTRO_WINDOW_MS;
}

function volumeOf(fight: FightSummary): number {
  return Number.isFinite(fight.volume) ? fight.volume : 0;
}

/** Most volume first; ties go to the earlier start, then the lower number. */
function compareLive(a: FightSummary, b: FightSummary): number {
  const byVolume = volumeOf(b) - volumeOf(a);
  if (byVolume !== 0) return byVolume;
  const byStart = (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER);
  if (byStart !== 0) return byStart;
  return a.number - b.number;
}

function soonestFirst(a: FightSummary, b: FightSummary): number {
  return (a.startsAt ?? a.createdAt) - (b.startsAt ?? b.createdAt) || a.number - b.number;
}

/** The soonest upcoming fight about to play its intro, if any. */
export function introDueFight(fights: readonly FightSummary[], now: number): FightSummary | null {
  return fights.filter((f) => inIntroWindow(f, now)).sort(soonestFirst)[0] ?? null;
}

/** When the next upcoming fight comes inside its intro window; null when none is still to. */
export function nextIntroWindowAt(fights: readonly FightSummary[], now: number): number | null {
  let next: number | null = null;
  for (const fight of fights) {
    if (fight.status !== "upcoming" || fight.startsAt === null) continue;
    const at = fight.startsAt - FEATURED_INTRO_WINDOW_MS;
    if (at > now && (next === null || at < next)) next = at;
  }
  return next;
}

/** The fight to feature when nothing is featured yet, or the featured one is done. */
export function bestFeaturedCandidate(fights: readonly FightSummary[]): FightSummary | null {
  const live = fights.filter((f) => f.status === "live");
  const open = live.filter((f) => f.marketStatus === "open");
  const pool = open.length > 0 ? open : live;
  if (pool.length > 0) return [...pool].sort(compareLive)[0] ?? null;
  const upcoming = fights.filter((f) => f.status === "upcoming").sort(soonestFirst);
  if (upcoming.length > 0) return upcoming[0] ?? null;
  return resolvedNewestFirst(fights)[0] ?? null;
}

/**
 * The featured fight, given the one already on screen (`currentId`) and the
 * server clock. Pure: the same inputs always give the same fight.
 */
export function pickFeatured(
  fights: readonly FightSummary[],
  currentId: string | null,
  now: number,
  holdMs: number = FEATURED_RESULT_HOLD_MS,
): FightSummary | null {
  const current = currentId === null ? undefined : fights.find((f) => f.raceId === currentId);
  if (current?.status === "live") return current;
  const starting = introDueFight(fights, now);
  if (starting) return starting;
  const best = bestFeaturedCandidate(fights);
  if (!current) return best;
  if (current.status === "resolved" && current.finishedAt !== null && now - current.finishedAt < holdMs) {
    return current;
  }
  // A fallback yields to a live fight; a resolved one also to a fight still to come.
  if (best && (best.status === "live" || (current.status === "resolved" && best.status === "upcoming"))) return best;
  return current;
}

/**
 * The fight on screen, kept across visits: leaving the lobby for a fight and
 * coming back must not re-pick it.
 */
let rememberedFeaturedId: string | null = null;

/** The lobby's featured fight, stable per the rules above. */
export function useFeaturedFight(fights: readonly FightSummary[]): FightSummary | null {
  const [, wake] = useState(0);
  const featured = pickFeatured(fights, rememberedFeaturedId, serverNow());
  const featuredId = featured?.raceId ?? null;

  useEffect(() => {
    rememberedFeaturedId = featuredId;
  }, [featuredId]);

  // A held result has to give way even when the lobby goes quiet.
  const holdEndsAt =
    featured?.status === "resolved" && featured.finishedAt !== null ? featured.finishedAt + FEATURED_RESULT_HOLD_MS : null;
  useEffect(() => {
    if (holdEndsAt === null) return;
    const delay = holdEndsAt - serverNow();
    if (delay <= 0) return;
    const timer = setTimeout(() => wake((n) => n + 1), delay + 50);
    return () => clearTimeout(timer);
  }, [holdEndsAt]);

  // So must a fight coming inside its intro window.
  const introAt = nextIntroWindowAt(fights, serverNow());
  useEffect(() => {
    if (introAt === null) return;
    const timer = setTimeout(() => wake((n) => n + 1), Math.max(0, introAt - serverNow()) + 50);
    return () => clearTimeout(timer);
  }, [introAt]);

  return featured;
}
