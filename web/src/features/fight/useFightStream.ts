/**
 * Live state for one fight on the fight screen.
 *
 *   const { fight, priceHistory, status, error, notFound } = useFightStream(raceId);
 *
 * A thin view over the foundation hook `useFightDetail` (state/fight.ts), which
 * already implements the contract:
 * - subscribes to `GET /api/fights/:raceId/stream`: `snapshot` replaces
 *   everything, `fight` replaces the detail, `price` appends a point when its
 *   `t` is newer than the last one (history capped at 2000 points);
 * - falls back to polling `GET /api/fights/:raceId` while the stream is down;
 * - a 404 stops both and reports not found.
 * The server clock is fed by api/client.ts (REST) and api/stream.ts (every SSE
 * payload with `serverTime`), so countdowns here use server time.
 *
 * Finish moment: when a fight this screen showed live resolves, `fight` keeps
 * `status: "live"` for FINISH_HOLD_MS while every other field is the resolved
 * detail (winner, phases, market). The route therefore keeps the arena up and
 * the winner's pane reads "Finished" before the settled view replaces it. Only
 * on the fight's own route: the lobby's featured card flips at once.
 */
import { useEffect, useState } from "react";
import { useMatch } from "react-router-dom";
import type { FightDetail, FightStatus, PricePoint } from "@contract";
import type { ApiFailure } from "../../api/client";
import type { StreamStatus } from "../../api/stream";
import { useFightDetail, type FightDetailStatus } from "../../state/fight";
import { startsFinishHold } from "./fightView";

/** How long a fight that just resolved keeps its arena on screen. */
export const FINISH_HOLD_MS = 5_000;

export type FightStream = {
  fight: FightDetail | null;
  /** Oldest first. */
  priceHistory: PricePoint[];
  status: FightDetailStatus;
  error: ApiFailure | null;
  /** The fight does not exist (404). */
  notFound: boolean;
  streamStatus: StreamStatus;
  /** Re-fetches over REST. Never rejects. */
  refresh: () => Promise<void>;
};

export function useFightStream(raceId: string | null | undefined): FightStream {
  const detail = useFightDetail(raceId);
  const route = useMatch("/fights/:raceId");
  const fight = useFinishHold(detail.fight, route !== null && route.params.raceId === raceId);
  return {
    fight,
    priceHistory: detail.priceHistory,
    status: detail.status,
    error: detail.error,
    notFound: detail.status === "not_found",
    streamStatus: detail.streamStatus,
    refresh: detail.refresh,
  };
}

type Seen = { raceId: string; status: FightStatus };

function useFinishHold(fight: FightDetail | null, enabled: boolean): FightDetail | null {
  const [seen, setSeen] = useState<Seen | null>(null);
  const [held, setHeld] = useState<string | null>(null);

  // Decided during render, not in an effect: the resolved detail must never
  // commit first, or the route would swap in the settled view for a frame
  // and remount the arena when the hold began.
  if (fight && (seen?.raceId !== fight.raceId || seen.status !== fight.status)) {
    const previous = seen?.raceId === fight.raceId ? seen.status : null;
    setSeen({ raceId: fight.raceId, status: fight.status });
    if (enabled && startsFinishHold(previous, fight.status)) setHeld(fight.raceId);
  }

  useEffect(() => {
    if (held === null) return;
    const timer = setTimeout(() => setHeld(null), FINISH_HOLD_MS);
    return () => clearTimeout(timer);
  }, [held]);

  if (fight && held === fight.raceId && fight.status === "resolved") return { ...fight, status: "live" };
  return fight;
}
