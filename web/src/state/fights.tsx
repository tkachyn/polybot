/**
 * The fight lobby, shared by every screen.
 *
 *   <FightsProvider> ... </FightsProvider>   mounted once in main.tsx
 *   const { fights, status, error } = useFights();
 *
 * Source: `GET /api/fights/stream` (`fights` on connect and on every change).
 * While the stream is not open, `GET /api/fights` is polled instead. Payloads
 * are ordered by `serverTime`, so a slow REST reply never overwrites a newer
 * stream event. `fights` keeps the server's order: live (newest first), then
 * upcoming (soonest first), then resolved (newest first).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FightListResponse, FightListStreamEvents, FightSummary } from "@contract";
import { ApiFailure, fightsStreamUrl, isAbortError, listFights, toApiFailure } from "../api/client";
import { useEventStream, type StreamStatus } from "../api/stream";

/**
 * - loading: no list yet.
 * - live: the stream is open and delivering.
 * - polling: data comes from the REST fallback while the stream reconnects.
 * - error: no list yet and the last fetch failed. Retries continue.
 */
export type FightsStatus = "loading" | "live" | "polling" | "error";

export type FightsValue = {
  fights: FightSummary[];
  status: FightsStatus;
  /** Null while healthy; the latest REST failure otherwise. */
  error: ApiFailure | null;
  /** True once any list has arrived. */
  loaded: boolean;
  streamStatus: StreamStatus;
  /** serverTime of the list on screen. */
  serverTime: number | null;
  /** Re-fetches over REST. Never rejects. */
  refresh: () => Promise<void>;
};

const FightsContext = createContext<FightsValue | null>(null);

const POLL_MS = 5_000;
const FIRST_POLL_MS = 800;

export function FightsProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<FightListResponse | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const latest = useRef(-Infinity);

  const apply = useCallback((data: FightListResponse) => {
    if (data.serverTime < latest.current) return;
    latest.current = data.serverTime;
    setList(data);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await listFights());
    } catch (err) {
      if (!isAbortError(err)) setError(toApiFailure(err));
    }
  }, [apply]);

  const streamStatus = useEventStream<FightListStreamEvents>(fightsStreamUrl(), { fights: apply });

  useEffect(() => {
    if (streamStatus === "open") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      void refresh().finally(() => {
        timer = setTimeout(tick, POLL_MS);
      });
    };
    timer = setTimeout(tick, latest.current === -Infinity ? FIRST_POLL_MS : POLL_MS);
    return () => clearTimeout(timer);
  }, [streamStatus, refresh]);

  const loaded = list !== null;
  const status: FightsStatus = !loaded ? (error ? "error" : "loading") : streamStatus === "open" ? "live" : "polling";

  const value = useMemo<FightsValue>(
    () => ({
      fights: list?.fights ?? [],
      status,
      error,
      loaded,
      streamStatus,
      serverTime: list?.serverTime ?? null,
      refresh,
    }),
    [list, status, error, loaded, streamStatus, refresh],
  );

  return <FightsContext.Provider value={value}>{children}</FightsContext.Provider>;
}

/** The lobby. Must be inside <FightsProvider>. */
export function useFights(): FightsValue {
  const value = useContext(FightsContext);
  if (!value) throw new Error("useFights() must be used inside <FightsProvider>.");
  return value;
}

/** One fight's summary from the lobby, or null if it is not listed. */
export function useFightSummary(raceId: string | null | undefined): FightSummary | null {
  const { fights } = useFights();
  return useMemo(() => (raceId ? (fights.find((f) => f.raceId === raceId) ?? null) : null), [fights, raceId]);
}
