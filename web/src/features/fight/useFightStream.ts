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
 */
import type { FightDetail, PricePoint } from "@contract";
import type { ApiFailure } from "../../api/client";
import type { StreamStatus } from "../../api/stream";
import { useFightDetail, type FightDetailStatus } from "../../state/fight";

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
  return {
    fight: detail.fight,
    priceHistory: detail.priceHistory,
    status: detail.status,
    error: detail.error,
    notFound: detail.status === "not_found",
    streamStatus: detail.streamStatus,
    refresh: detail.refresh,
  };
}
