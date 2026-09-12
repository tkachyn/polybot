/**
 * The refetch policy behind useFightEvaluation: the hook passes
 * `evaluationVersion(fight.evaluation)` to `loader.sync` on every render
 * where it changes, so these tests drive the loader the way the fight
 * stream drives the hook.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationStatus, FightEvaluation, FightEvaluationPointer, FightEvaluationResponse } from "@contract";
import { ApiFailure } from "../../api/client";
import { NO_POINTER_VERSION, createEvaluationLoader, evaluationVersion } from "./evaluationLoader";

type Call = {
  raceId: string;
  signal: AbortSignal;
  resolve: (value: FightEvaluationResponse) => void;
  reject: (error: unknown) => void;
};

const pointer = (updatedAt: number, status: EvaluationStatus = "provisional"): FightEvaluationPointer => ({ status, updatedAt });
const version = (updatedAt: number, status: EvaluationStatus = "provisional") => evaluationVersion(pointer(updatedAt, status));

function evaluationFixture(raceId: string, generatedAt: number, status: EvaluationStatus): FightEvaluation {
  return {
    raceId,
    number: 412,
    title: "Book a table for two",
    task: "Book a table for two at the first available time",
    courseId: "course-1",
    mode: "simulated",
    status,
    generatedAt,
    startedAt: 0,
    finishedAt: null,
    winnerRacerId: null,
    voided: false,
    sabotageSteps: [],
    agents: [],
    findings: [],
  };
}

/** Lets settled promises run their callbacks. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function setup(minIntervalMs = 1_000) {
  const calls: Call[] = [];
  const loader = createEvaluationLoader({
    fetch: (raceId, signal) =>
      new Promise<FightEvaluationResponse>((resolve, reject) => {
        calls.push({ raceId, signal, resolve, reject });
      }),
    minIntervalMs,
  });
  const respond = async (index: number, generatedAt: number, status: EvaluationStatus = "provisional") => {
    const call = calls[index];
    if (!call) throw new Error(`No request #${index}`);
    call.resolve({ serverTime: generatedAt, evaluation: evaluationFixture(call.raceId, generatedAt, status) });
    await flush();
  };
  return { loader, calls, respond };
}

describe("evaluationVersion", () => {
  it("depends only on the pointer's status and updatedAt", () => {
    expect(evaluationVersion(pointer(5))).toBe(evaluationVersion({ status: "provisional", updatedAt: 5 }));
    expect(evaluationVersion(pointer(5))).not.toBe(evaluationVersion(pointer(6)));
    expect(evaluationVersion(pointer(5, "final"))).not.toBe(evaluationVersion(pointer(5)));
    expect(evaluationVersion(null)).toBe(NO_POINTER_VERSION);
    expect(evaluationVersion(undefined)).toBe(NO_POINTER_VERSION);
  });
});

describe("useFightEvaluation refetch policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches on mount, with or without a pointer", async () => {
    const { loader, calls, respond } = setup();
    loader.sync("race-1", evaluationVersion(null));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.raceId).toBe("race-1");
    expect(loader.getState()).toMatchObject({ raceId: "race-1", evaluation: null, loading: true });
    await respond(0, 10);
    expect(loader.getState()).toMatchObject({ loading: false, error: null, version: NO_POINTER_VERSION, serverTime: 10 });
  });

  it("never refetches for the same pointer, however often the stream re-sends it", async () => {
    const { loader, calls, respond } = setup();
    loader.sync("race-1", version(100));
    await respond(0, 100);
    for (let tick = 0; tick < 40; tick += 1) {
      // Every `fight` event carries a new pointer object with the same values.
      loader.sync("race-1", evaluationVersion({ status: "provisional", updatedAt: 100 }));
      vi.advanceTimersByTime(250);
    }
    expect(calls).toHaveLength(1);
    expect(loader.getState()).toMatchObject({ loading: false, version: version(100) });
  });

  it("refetches once when updatedAt changes, keeping the old evaluation meanwhile", async () => {
    const { loader, calls, respond } = setup();
    loader.sync("race-1", version(100));
    await respond(0, 100);
    vi.advanceTimersByTime(5_000);

    loader.sync("race-1", version(200));
    loader.sync("race-1", version(200));
    expect(calls).toHaveLength(2);
    expect(loader.getState().loading).toBe(true);
    expect(loader.getState().evaluation?.generatedAt).toBe(100);

    await respond(1, 200, "final");
    expect(loader.getState()).toMatchObject({ loading: false, version: version(200) });
    expect(loader.getState().evaluation?.status).toBe("final");
  });

  it("refetches when the pointer turns final", async () => {
    const { loader, calls, respond } = setup();
    loader.sync("race-1", version(100));
    await respond(0, 100);
    vi.advanceTimersByTime(5_000);
    loader.sync("race-1", version(100, "final"));
    expect(calls).toHaveLength(2);
  });

  it("collapses pointer changes during a request into one trailing fetch for the newest", async () => {
    const { loader, calls, respond } = setup();
    loader.sync("race-1", version(100));
    loader.sync("race-1", version(200));
    loader.sync("race-1", version(300));
    expect(calls).toHaveLength(1);

    await respond(0, 100);
    // The trailing fetch waits out the minimum interval from the first start.
    expect(calls).toHaveLength(1);
    expect(loader.getState().loading).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(calls).toHaveLength(2);

    await respond(1, 300);
    expect(loader.getState()).toMatchObject({ loading: false, version: version(300) });
    vi.advanceTimersByTime(10_000);
    expect(calls).toHaveLength(2);
  });

  it("spaces pointer-driven fetches by the minimum interval", async () => {
    const { loader, calls, respond } = setup(1_000);
    loader.sync("race-1", version(1));
    await respond(0, 1);
    loader.sync("race-1", version(2));
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(calls).toHaveLength(2);
  });

  it("starts over for another fight and ignores the old fight's late answer", async () => {
    const { loader, calls, respond } = setup();
    loader.sync("race-1", version(1));
    await respond(0, 1);
    loader.sync("race-1", version(2));
    vi.advanceTimersByTime(1_000);
    const stale = calls[1];
    expect(stale?.raceId).toBe("race-1");

    loader.sync("race-2", version(1));
    expect(stale?.signal.aborted).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.raceId).toBe("race-2");
    expect(loader.getState()).toMatchObject({ raceId: "race-2", evaluation: null, loading: true });

    stale?.resolve({ serverTime: 2, evaluation: evaluationFixture("race-1", 2, "provisional") });
    await flush();
    expect(loader.getState().evaluation).toBeNull();
    await respond(2, 3);
    expect(loader.getState().evaluation?.raceId).toBe("race-2");
  });

  it("keeps the last evaluation on failure and does not retry until the pointer changes or a reload", async () => {
    const { loader, calls, respond } = setup();
    loader.sync("race-1", version(1));
    await respond(0, 1);
    vi.advanceTimersByTime(1_000);

    loader.sync("race-1", version(2));
    calls[1]?.reject(new ApiFailure("Upstream unavailable", "server", 503));
    await flush();
    expect(loader.getState()).toMatchObject({ loading: false });
    expect(loader.getState().error?.code).toBe("server");
    expect(loader.getState().evaluation?.generatedAt).toBe(1);

    loader.sync("race-1", version(2));
    vi.advanceTimersByTime(30_000);
    expect(calls).toHaveLength(2);

    loader.reload();
    expect(calls).toHaveLength(3);
    await respond(2, 2);
    expect(loader.getState().error).toBeNull();
    expect(loader.getState().evaluation?.generatedAt).toBe(2);

    loader.sync("race-1", version(3));
    vi.advanceTimersByTime(1_000);
    expect(calls).toHaveLength(4);
  });

  it("reports a missing evaluation as not_found", async () => {
    const { loader, calls } = setup();
    loader.sync("race-1", evaluationVersion(null));
    calls[0]?.reject(new ApiFailure("Not found.", "not_found", 404));
    await flush();
    expect(loader.getState()).toMatchObject({ evaluation: null, loading: false });
    expect(loader.getState().error?.code).toBe("not_found");
  });

  it("aborts on dispose and ignores everything after", async () => {
    const { loader, calls } = setup();
    loader.sync("race-1", version(1));
    loader.dispose();
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.resolve({ serverTime: 1, evaluation: evaluationFixture("race-1", 1, "final") });
    await flush();
    expect(loader.getState().evaluation).toBeNull();
    loader.sync("race-1", version(2));
    loader.reload();
    expect(calls).toHaveLength(1);
  });
});
