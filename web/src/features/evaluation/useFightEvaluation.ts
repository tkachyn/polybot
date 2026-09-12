/**
 * One fight's evaluation, refetched only when the fight's evaluation pointer
 * changes (see ./evaluationLoader for the policy).
 *
 *   const { evaluation, status, error, updating, reload } = useFightEvaluation(fight.raceId, fight.evaluation);
 *
 * `pointer` is `FightDetail.evaluation`, which rides on the fight stream. Its
 * object identity changes on every stream tick; only `status` and
 * `updatedAt` matter, so passing it straight from the stream is fine.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { FightEvaluation, FightEvaluationPointer } from "@contract";
import { getFightEvaluation, isApiFailure, type ApiFailure } from "../../api/client";
import { createEvaluationLoader, evaluationVersion, initialEvaluationState, type EvaluationLoader, type EvaluationLoadState } from "./evaluationLoader";

/**
 * - idle: no fight.
 * - loading: nothing yet.
 * - ready: an evaluation is on screen (it may be refreshing: see `updating`).
 * - not_found: the server has no evaluation for this fight (404).
 * - error: nothing yet and the last request failed.
 */
export type FightEvaluationStatus = "idle" | "loading" | "ready" | "not_found" | "error";

export type FightEvaluationState = {
  evaluation: FightEvaluation | null;
  status: FightEvaluationStatus;
  /** The latest failure, also set while an older evaluation stays on screen. */
  error: ApiFailure | null;
  /** A refetch is running while an evaluation is already on screen. */
  updating: boolean;
  /** Fetches again now. */
  reload: () => void;
};

export function useFightEvaluation(raceId: string | null | undefined, pointer: FightEvaluationPointer | null | undefined): FightEvaluationState {
  const id = raceId || null;
  const version = evaluationVersion(pointer);
  const [raw, setRaw] = useState<EvaluationLoadState>(() => initialEvaluationState(id));
  const loaderRef = useRef<EvaluationLoader | null>(null);
  const wantedRef = useRef({ id, version });
  wantedRef.current = { id, version };

  useEffect(() => {
    const loader = createEvaluationLoader({ fetch: getFightEvaluation, onChange: setRaw });
    loaderRef.current = loader;
    loader.sync(wantedRef.current.id, wantedRef.current.version);
    return () => {
      loader.dispose();
      if (loaderRef.current === loader) loaderRef.current = null;
    };
  }, []);

  // A string and a nullable id: re-rendering with an equal pointer is a no-op.
  useEffect(() => {
    loaderRef.current?.sync(id, version);
  }, [id, version]);

  const reload = useCallback(() => {
    loaderRef.current?.reload();
  }, []);

  const state = raw.raceId === id ? raw : initialEvaluationState(id);
  let status: FightEvaluationStatus;
  if (!id) status = "idle";
  else if (state.evaluation) status = "ready";
  else if (state.error) status = isApiFailure(state.error, "not_found") ? "not_found" : "error";
  else status = "loading";

  return {
    evaluation: state.evaluation,
    status,
    error: state.error,
    updating: state.loading && state.evaluation !== null,
    reload,
  };
}
