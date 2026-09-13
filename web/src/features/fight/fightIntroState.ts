import type { FightStatus } from "@contract";
import { readStorage, writeStorage } from "../../state/storage";
import { FIGHT_INTRO_MARGIN_MS, FIGHT_INTRO_MS } from "./introVideo";

const INTRO_SEEN_PREFIX = "sm.fightIntro.";

export function fightIntroSeenKey(raceId: string): string {
  return `${INTRO_SEEN_PREFIX}${raceId}`;
}

export function hasSeenFightIntro(raceId: string): boolean {
  return readStorage(fightIntroSeenKey(raceId)) === "1";
}

export function markFightIntroSeen(raceId: string): void {
  writeStorage(fightIntroSeenKey(raceId), "1");
}

/**
 * Milliseconds until the intro opens, `leadMs` before the fight starts (its
 * length plus the margin it ends by): 0 once that moment has come. Null when
 * there is no start to lead into: no start time yet, or already started.
 */
export function introOpensIn(
  fight: { status: FightStatus; startsAt: number | null },
  now: number,
  leadMs: number = FIGHT_INTRO_MS + FIGHT_INTRO_MARGIN_MS,
): number | null {
  if (fight.status !== "upcoming" || fight.startsAt === null || fight.startsAt <= now) return null;
  return Math.max(0, fight.startsAt - leadMs - now);
}

/** Seconds into the intro to start from so it ends at `endsAt`: 0 when there is time for all of it. */
export function introStartOffset(endsAt: number, now: number, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.max(0, durationSec - Math.max(0, endsAt - now) / 1000);
}
