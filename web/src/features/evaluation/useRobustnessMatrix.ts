import { useEffect, useMemo, useRef } from "react";
import type { FightSummary, RobustnessMatrixResponse } from "@contract";
import { getRobustnessMatrix, type EvaluationMode } from "../../api/client";
import { useFights } from "../../state/fights";
import { useApiResource, type ApiResource } from "../../state/resource";

/** Slow background refresh while the page is open (paused while the tab is hidden). */
export const MATRIX_POLL_MS = 60_000;
/** A fight's evaluation is finalised just after it resolves; wait briefly before reloading. */
const RESOLVE_RELOAD_DELAY_MS = 1_500;

/** Changes whenever a fight resolves: the number of resolved fights and the latest finish. */
export function resolvedFightsKey(fights: readonly FightSummary[]): string {
  let count = 0;
  let latest = 0;
  for (const fight of fights) {
    if (fight.status !== "resolved") continue;
    count += 1;
    if (fight.finishedAt !== null && fight.finishedAt > latest) latest = fight.finishedAt;
  }
  return `${count}:${latest}`;
}

/**
 * GET /api/evaluations/matrix for a window and mode (null = the server's
 * mode). Reloads when the window or mode changes, when a fight resolves, and
 * every minute.
 */
export function useRobustnessMatrix(days: number, mode: EvaluationMode | null): ApiResource<RobustnessMatrixResponse> {
  const resource = useApiResource((signal) => getRobustnessMatrix({ days, mode: mode ?? undefined }, signal), [days, mode], {
    pollMs: MATRIX_POLL_MS,
  });
  const { fights, loaded } = useFights();
  const key = useMemo(() => (loaded ? resolvedFightsKey(fights) : null), [fights, loaded]);
  const previous = useRef<string | null>(null);
  const { reload } = resource;

  useEffect(() => {
    if (key === null) return undefined;
    const before = previous.current;
    previous.current = key;
    // The first lobby list only sets the baseline; the resource already loaded.
    if (before === null || before === key) return undefined;
    const timer = setTimeout(reload, RESOLVE_RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [key, reload]);

  return resource;
}
