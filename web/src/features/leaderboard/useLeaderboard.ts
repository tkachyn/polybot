import { useEffect, useMemo, useRef } from "react";
import type { FightSummary, LeaderboardResponse } from "@contract";
import { getLeaderboard } from "../../api/client";
import { useFights } from "../../state/fights";
import { useApiResource, type ApiResource } from "../../state/resource";

/** Interval refresh while the page is open (paused while the tab is hidden). */
export const LEADERBOARD_POLL_MS = 15_000;

/**
 * A signature that changes whenever a fight resolves: the number of resolved
 * fights in the lobby plus the latest finish time among them.
 */
export function resolvedSignature(fights: readonly FightSummary[]): string {
  let count = 0;
  let latest = 0;
  for (const fight of fights) {
    if (fight.status !== "resolved") continue;
    count += 1;
    if (fight.finishedAt !== null && fight.finishedAt > latest) latest = fight.finishedAt;
  }
  return `${count}:${latest}`;
}

/** GET /api/leaderboard, polled every 15 s and reloaded when a fight resolves. */
export function useLeaderboard(): ApiResource<LeaderboardResponse> {
  const resource = useApiResource((signal) => getLeaderboard(signal), [], { pollMs: LEADERBOARD_POLL_MS });
  const { fights, loaded } = useFights();
  const signature = useMemo(() => (loaded ? resolvedSignature(fights) : null), [fights, loaded]);
  const previous = useRef<string | null>(null);
  const { reload } = resource;

  useEffect(() => {
    if (signature === null) return;
    const before = previous.current;
    previous.current = signature;
    // The first lobby list only establishes the baseline; the resource already loaded.
    if (before !== null && before !== signature) reload();
  }, [signature, reload]);

  return resource;
}
