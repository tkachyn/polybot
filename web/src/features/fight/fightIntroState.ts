import type { FightStatus } from "@contract";
import { readStorage, writeStorage } from "../../state/storage";

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

export function shouldOpenFightIntro(status: FightStatus, seen: boolean): boolean {
  return status === "live" && !seen;
}
