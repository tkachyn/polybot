import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonlRaceEventStore } from "../src/persistence/jsonl-event-store.js";

test("persists and filters append-only race events", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "arena-events-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonlRaceEventStore(join(directory, "events.jsonl"));

  await Promise.all([
    store.append({ id: "1", raceId: "race-1", type: "race_created", occurredAt: 1 }),
    store.append({ id: "2", raceId: "race-2", type: "race_created", occurredAt: 2 }),
    store.append({ id: "3", raceId: "race-1", type: "race_started", occurredAt: 3 }),
  ]);

  assert.deepEqual((await store.list("race-1")).map((event) => event.id), ["1", "3"]);
});
