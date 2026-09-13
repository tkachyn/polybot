/**
 * What "/fights/:raceId" shows. The lobby keeps a bounded, in-memory list of
 * fights, so a fight can leave it (pruned, or lost to a server restart) while
 * its final evaluation stays in the store. Then its report opens, read-only.
 * "Not found" only when neither the fight nor its report exists.
 */
import type { FightStatus } from "@contract";
import type { FightEvaluationStatus } from "../evaluation/useFightEvaluation";

export type FightRouteView =
  /** Neither the fight nor its evaluation exists (or there is no raceId). */
  | "not_found"
  /** Waiting for the fight. */
  | "loading"
  /** The fight has left the lobby; looking for its stored report. */
  | "archive_loading"
  /** The fight has left the lobby and its report couldn't be loaded (retryable). */
  | "archive_error"
  /** The fight has left the lobby; its final report is on screen. */
  | "archived"
  /** The settled screen. */
  | "resolved"
  /** The fight screen (live or upcoming). */
  | "live";

export type FightRouteInput = {
  raceId: string | null | undefined;
  /** The fight detail answered 404: the lobby doesn't have it. */
  fightNotFound: boolean;
  /** The fight's status once loaded; null while loading. */
  fightStatus: FightStatus | null;
  /** The stored evaluation's status, looked up only once the fight is not found. */
  archive: FightEvaluationStatus;
};

export function fightRouteView({ raceId, fightNotFound, fightStatus, archive }: FightRouteInput): FightRouteView {
  if (!raceId) return "not_found";
  if (fightNotFound) {
    if (archive === "ready") return "archived";
    if (archive === "not_found") return "not_found";
    if (archive === "error") return "archive_error";
    // "loading", or "idle" for the one render before the lookup starts.
    return "archive_loading";
  }
  if (fightStatus === null) return "loading";
  return fightStatus === "resolved" ? "resolved" : "live";
}
