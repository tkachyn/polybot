import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FightEvaluation } from "../src/api/dto.js";
import {
  InMemoryEvaluationStore,
  JsonlEvaluationStore,
  evaluationTime,
} from "../src/evaluation/store.js";

function evaluation(raceId: string, overrides: Partial<FightEvaluation> = {}): FightEvaluation {
  return {
    raceId,
    number: 1,
    title: `Fight ${raceId}`,
    task: "Buy the blue mug",
    courseId: "course-mug",
    mode: "live",
    status: "final",
    generatedAt: 5_000,
    startedAt: 1_000,
    finishedAt: 4_000,
    winnerRacerId: "racer-1",
    voided: false,
    sabotageSteps: [],
    agents: [],
    findings: [],
    ...overrides,
  };
}

async function tempFile(context: { after(fn: () => Promise<void>): void }, name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "arena-evaluations-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "nested", "deeper", name);
}

test("list filters on finishedAt, falling back to generatedAt", () => {
  assert.equal(evaluationTime(evaluation("a")), 4_000);
  assert.equal(evaluationTime(evaluation("a", { finishedAt: null })), 5_000);
});

test("the in-memory store keeps the latest evaluation per race and filters by time and mode", async () => {
  const store = new InMemoryEvaluationStore();
  assert.equal(await store.get("a"), null);
  assert.deepEqual(await store.list(), []);

  await store.put(evaluation("a", { status: "provisional", finishedAt: 3_000 }));
  await store.put(evaluation("b", { finishedAt: null, generatedAt: 2_000, mode: "simulated" }));
  await store.put(evaluation("a", { finishedAt: 6_000 }));

  assert.equal((await store.get("a"))?.finishedAt, 6_000);
  assert.equal((await store.get("a"))?.status, "final");
  assert.deepEqual((await store.list()).map((item) => item.raceId), ["b", "a"]);
  assert.deepEqual((await store.list({ since: 2_000 })).map((item) => item.raceId), ["b", "a"]);
  assert.deepEqual((await store.list({ since: 2_001 })).map((item) => item.raceId), ["a"]);
  assert.deepEqual((await store.list({ mode: "simulated" })).map((item) => item.raceId), ["b"]);
  assert.deepEqual(await store.list({ mode: "live", since: 7_000 }), []);

  // Stored copies are isolated from callers.
  const fetched = await store.get("a");
  assert.ok(fetched);
  fetched.title = "mutated";
  const input = evaluation("c");
  await store.put(input);
  input.title = "mutated";
  assert.equal((await store.get("a"))?.title, "Fight a");
  assert.equal((await store.get("c"))?.title, "Fight c");
  await assert.rejects(store.put({} as FightEvaluation), /raceId/);
});

test("the JSONL store appends, tolerates a missing file and keeps the latest line per race", async (context) => {
  const file = await tempFile(context, "evaluations.jsonl");
  const store = new JsonlEvaluationStore(file);
  assert.equal(await store.get("race-0"), null);
  assert.deepEqual(await store.list(), []);

  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    store.put(evaluation(`race-${index}`, { finishedAt: 1_000 + index }))));
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 20);
  for (const line of lines) assert.equal(typeof JSON.parse(line).raceId, "string");

  await store.put(evaluation("race-3", { title: "again", finishedAt: 50_000 }));
  assert.equal((await store.get("race-3"))?.title, "again");
  assert.equal((await store.list()).length, 20);
  assert.equal((await store.list()).at(-1)?.raceId, "race-3");

  const reopened = new JsonlEvaluationStore(file);
  assert.equal((await reopened.get("race-3"))?.title, "again");
  assert.deepEqual(
    (await reopened.list({ since: 1_010 })).map((item) => item.raceId),
    [...Array.from({ length: 10 }, (_, index) => `race-${index + 10}`), "race-3"],
  );
  assert.deepEqual(await reopened.list({ mode: "simulated" }), []);
  assert.throws(() => new JsonlEvaluationStore(""), /required/);
});

test("the JSONL store skips a torn line and sees another writer's appends", async (context) => {
  const file = await tempFile(context, "evaluations.jsonl");
  const first = new JsonlEvaluationStore(file);
  await first.put(evaluation("a"));
  // A crash mid-append leaves a line without its newline.
  await writeFile(file, `${await readFile(file, "utf8")}{"raceId":"torn","agen`, "utf8");

  const second = new JsonlEvaluationStore(file);
  assert.deepEqual((await second.list()).map((item) => item.raceId), ["a"]);
  await second.put(evaluation("b", { finishedAt: 4_500 }));
  assert.deepEqual((await second.list()).map((item) => item.raceId), ["a", "b"]);

  // `first` cached the file before; the size change makes it re-read.
  assert.deepEqual((await first.list()).map((item) => item.raceId), ["a", "b"]);
  assert.equal((await new JsonlEvaluationStore(file).get("b"))?.finishedAt, 4_500);
});
