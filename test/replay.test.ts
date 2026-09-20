import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActionReport, CapturedFrame, CompetitorContext } from "../src/application/contracts.js";
import type { DatasetStore } from "../src/dataset/store.js";
import type { FightDatasetRecord, StoredDatasetFile } from "../src/dataset/types.js";
import { InMemoryDatasetStore } from "../src/dataset/store.js";
import { ReplayLibrary, isReplayable } from "../src/replay/library.js";
import { ReplayCompetitorRunner, timelineFor } from "../src/replay/runner.js";
import { replayCourseId, sourceRaceIdOf, isReplayInput } from "../src/replay/course-id.js";
import { goldenFiles, goldenRecord } from "./dataset-fixtures.js";

function recordWith(overrides: Partial<FightDatasetRecord>): FightDatasetRecord {
  return { ...goldenRecord(), ...overrides };
}

test("a replayable recording needs a winner and enough steps", () => {
  const record = goldenRecord();
  assert.equal(isReplayable(record, 8), true);

  const voided = recordWith({ evaluation: { ...record.evaluation, voided: true } });
  assert.equal(isReplayable(voided, 8), false);

  const noWinner = recordWith({ evaluation: { ...record.evaluation, winnerRacerId: null } });
  assert.equal(isReplayable(noWinner, 8), false);

  // The golden record's steps are real but few; a high bar excludes it.
  assert.equal(isReplayable(record, 10_000), false);
});

test("the library keeps replayable fights and cycles through them without repeating", async () => {
  const store = new InMemoryDatasetStore();
  for (const raceId of ["race-a", "race-b", "race-c"]) {
    const record = goldenRecord();
    record.raceId = raceId;
    record.evaluation = { ...record.evaluation, raceId };
    await store.put(record, []);
  }
  // A void fight has no result to settle against, so it never replays.
  const voided = goldenRecord();
  voided.raceId = "race-void";
  voided.evaluation = { ...voided.evaluation, raceId: "race-void", voided: true, winnerRacerId: null };
  await store.put(voided, []);

  let seed = 7;
  const library = new ReplayLibrary(store, {
    minSteps: 1,
    // Deterministic shuffle, so the test never flakes on ordering.
    random: () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648),
  });
  assert.equal(await library.load(goldenRecord().finishedAt ?? Date.now()), 3);
  assert.equal(library.size, 3);
  assert.equal(library.find("race-void"), null);
  assert.ok(library.find("race-b"));

  const firstCycle = [library.next(), library.next(), library.next()].map((r) => r?.raceId);
  assert.deepEqual([...firstCycle].sort(), ["race-a", "race-b", "race-c"]);
  // A fourth draw reshuffles rather than running dry.
  assert.ok(library.next());
});

test("the timeline reports a step before the checkpoint it earned", () => {
  const record = goldenRecord();
  const agent = record.agents[0];
  const entries = timelineFor(record as never, agent);
  assert.ok(entries.length > agent.steps.length, "checkpoints and the finish join the steps");
  for (let i = 1; i < entries.length; i += 1) {
    assert.ok(entries[i].at >= entries[i - 1].at, "entries run forward in time");
  }
  const finish = entries.at(-1);
  assert.equal(finish?.kind, "finish", "the finish is last");
});

test("the runner replays a recorded racer's steps, screenshots and progress in order", async () => {
  const store = new InMemoryDatasetStore();
  const record = goldenRecord();
  await store.put(record, goldenFiles());

  const runner = new ReplayCompetitorRunner({
    recording: record as never,
    store,
    // The golden record spans 40 s; run it fast so the test stays quick.
    timeScale: 10_000,
  });

  const actions: AgentActionReport[] = [];
  const frames: CapturedFrame[] = [];
  const checkpoints: number[] = [];
  let finished = 0;
  let recoveries = 0;

  const racerId = record.agents[0].racerId;
  const context: CompetitorContext = {
    raceId: "replay-1",
    racerId,
    courseId: replayCourseId(record.raceId),
    seed: record.task.seed,
    checkpointCount: record.task.checkpointCount,
    session: { racerId, steelSessionId: "sim-1" },
    reportCheckpoint: async (checkpoint) => {
      checkpoints.push(checkpoint);
      return true;
    },
    reportFinish: async () => {
      finished += 1;
      return true;
    },
    reportRecovery: async () => {
      recoveries += 1;
    },
    reportAction: (report) => actions.push(report),
    reportFrame: (frame) => frames.push(frame),
  };

  await runner.prepare(context);
  await runner.run(context);

  const recorded = record.agents[0].steps;
  // prepare() opens with a note, then every recorded step is reported in order.
  assert.equal(actions[0].kind, "note");
  assert.deepEqual(
    actions.slice(1).map((a) => a.step),
    recorded.map((s) => s.step),
  );
  assert.equal(actions[1].text, recorded[0].text);
  assert.equal(actions[1].reasoning, recorded[0].reasoning ?? undefined);
  assert.deepEqual(checkpoints, [...checkpoints].sort((a, b) => a - b), "checkpoints climb");
  assert.equal(finished, 1, "the recorded winner finishes once");
  assert.ok(recoveries >= 0);
  assert.ok(frames.length > 0, "recorded screenshots are pushed as frames");
  assert.ok(frames.every((f) => f.contentType.startsWith("image/")));
});

test("the runner stops promptly when the fight is stopped", async () => {
  const record = goldenRecord();
  const runner = new ReplayCompetitorRunner({ recording: record as never, timeScale: 1 });
  const racerId = record.agents[0].racerId;
  let finished = 0;
  const context: CompetitorContext = {
    raceId: "replay-2",
    racerId,
    courseId: replayCourseId(record.raceId),
    seed: record.task.seed,
    checkpointCount: record.task.checkpointCount,
    session: { racerId, steelSessionId: "sim-2" },
    reportCheckpoint: async () => true,
    reportFinish: async () => {
      finished += 1;
      return true;
    },
  };
  const running = runner.run(context);
  await runner.stop(racerId);
  await running;
  assert.equal(finished, 0, "a stopped replay never claims the finish");
});

test("replay course ids round-trip and are told apart from real courses", () => {
  assert.equal(sourceRaceIdOf(replayCourseId("shop-123")), "shop-123");
  assert.equal(sourceRaceIdOf("arena-shop"), null);
  assert.equal(isReplayInput({ courseId: replayCourseId("shop-123") }), true);
  assert.equal(isReplayInput({ courseId: "arena-shop" }), false);
});

test("a replay store read failure leaves the replay running without frames", async () => {
  const failing: DatasetStore = {
    put: async () => undefined,
    list: async () => [],
    readFile: async (): Promise<StoredDatasetFile | null> => {
      throw new Error("disk gone");
    },
  };
  const record = goldenRecord();
  const runner = new ReplayCompetitorRunner({
    recording: record as never,
    store: failing,
    timeScale: 10_000,
  });
  const racerId = record.agents[0].racerId;
  const frames: CapturedFrame[] = [];
  let finished = 0;
  const context: CompetitorContext = {
    raceId: "replay-3",
    racerId,
    courseId: replayCourseId(record.raceId),
    seed: record.task.seed,
    checkpointCount: record.task.checkpointCount,
    session: { racerId, steelSessionId: "sim-3" },
    reportCheckpoint: async () => true,
    reportFinish: async () => {
      finished += 1;
      return true;
    },
    reportFrame: (frame) => frames.push(frame),
  };
  await runner.run(context);
  assert.equal(frames.length, 0);
  assert.equal(finished, 1, "the replay still finishes");
});
