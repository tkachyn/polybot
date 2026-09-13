import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import type {
  DatasetEpisode,
  DatasetManifest,
  DatasetPreference,
  DatasetSftExample,
  DatasetStep,
} from "../src/api/dto.js";
import { buildApi, defaultDatasetStore } from "../src/api/server.js";
import { InMemoryDatasetStore, JsonlDatasetStore } from "../src/dataset/store.js";
import { InMemoryEvaluationStore } from "../src/evaluation/index.js";
import { createFactory } from "./api-fixtures.js";
import {
  DAY,
  NOW,
  RAW_TRACE,
  SCREENSHOTS,
  TRACES,
  goldenFiles,
  goldenRecord,
  jpeg,
  variant,
} from "./dataset-fixtures.js";

const INVALID_QUERIES = [
  "?days=0", "?days=366", "?days=1.5", "?days=abc", "?days=-1", "?days=1e2", "?days=10&days=20",
  "?mode=bogus", "?mode=LIVE",
];
const MISSING_SHOT = "assets/sim-1/racer-1/step-0001.svg";

function jsonl<T>(bytes: Uint8Array | string | undefined): T[] {
  const text = typeof bytes === "string" ? bytes : strFromU8(bytes ?? new Uint8Array());
  assert.ok(text === "" || text.endsWith("\n"));
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as T);
}

/** The golden live fight with its files, a simulated fight naming a missing file, and an old live fight. */
async function seededStore(): Promise<InMemoryDatasetStore> {
  const store = new InMemoryDatasetStore();
  await store.put(goldenRecord(), goldenFiles());
  const sim = variant("sim-1", NOW - 2 * DAY, "simulated");
  sim.agents[0].screenshots = { 1: MISSING_SHOT };
  await store.put(sim, []);
  await store.put(variant("live-old", NOW - 40 * DAY, "live"), []);
  return store;
}

async function app(store = undefined as InMemoryDatasetStore | undefined) {
  return buildApi({
    coordinatorFactory: createFactory().factory,
    enableTicker: false,
    evaluationStore: new InMemoryEvaluationStore(),
    datasetStore: store ?? await seededStore(),
    now: () => NOW,
  });
}

test("export.zip bundles the manifest, the four JSON Lines files, screenshots and Steel traces", async () => {
  const api = await app();
  try {
    const response = await api.inject({ method: "GET", url: "/api/datasets/export.zip" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "application/zip");
    assert.equal(response.headers["content-disposition"], 'attachment; filename="sabotage-markets-dataset-2026-09-12.zip"');
    assert.equal(response.headers["cache-control"], "no-store");

    const bundle = unzipSync(new Uint8Array(response.rawPayload));
    assert.deepEqual(Object.keys(bundle).sort(), [
      SCREENSHOTS.r1s1, SCREENSHOTS.r1s2, SCREENSHOTS.r1s3, SCREENSHOTS.r3s2,
      "episodes.jsonl", "manifest.json", "preferences.jsonl", "sft.jsonl",
      TRACES.r1, TRACES.r2, "steps.jsonl",
    ].sort());
    const manifest = JSON.parse(strFromU8(bundle["manifest.json"])) as DatasetManifest;
    assert.deepEqual(manifest.filters, { days: 30, mode: "live" }, "the server's mode by default");
    assert.deepEqual(manifest.counts, {
      fights: 1, episodes: 4, steps: 18, sft: 4, preferences: 3, screenshots: 4, steelTraces: 2,
    });
    assert.equal(manifest.generatedAt, NOW);

    const episodes = jsonl<DatasetEpisode>(bundle["episodes.jsonl"]);
    const steps = jsonl<DatasetStep>(bundle["steps.jsonl"]);
    const sft = jsonl<DatasetSftExample>(bundle["sft.jsonl"]);
    const preferences = jsonl<DatasetPreference>(bundle["preferences.jsonl"]);
    assert.deepEqual([episodes.length, steps.length, sft.length, preferences.length], [4, 18, 4, 3]);
    assert.deepEqual(manifest.files.slice(0, 4).map((file) => file.rows), [4, 18, 4, 3]);
    for (const step of steps) {
      if (step.screenshot !== null) assert.ok(bundle[step.screenshot], `${step.screenshot} is bundled`);
    }
    for (const episode of episodes) {
      if (episode.steelTraceFile !== null) assert.ok(bundle[episode.steelTraceFile]);
    }
    assert.deepEqual(Buffer.from(bundle[SCREENSHOTS.r1s2]), jpeg(2));
    assert.equal(strFromU8(bundle[SCREENSHOTS.r3s2]), "<svg>racer-3 step 2</svg>");
    assert.deepEqual(JSON.parse(strFromU8(bundle[TRACES.r1])), RAW_TRACE);

    // The same request yields the same archive.
    const again = await api.inject({ method: "GET", url: "/api/datasets/export.zip" });
    assert.deepEqual(again.rawPayload, response.rawPayload);
  } finally {
    await api.close();
  }
});

test("a listed file missing from storage is left out, counted and nulled", async () => {
  const api = await app();
  try {
    const response = await api.inject({ method: "GET", url: "/api/datasets/export.zip?mode=all" });
    const bundle = unzipSync(new Uint8Array(response.rawPayload));
    const manifest = JSON.parse(strFromU8(bundle["manifest.json"])) as DatasetManifest;
    assert.deepEqual([manifest.counts.fights, manifest.byMode], [2, { live: 1, simulated: 1 }]);
    assert.equal(manifest.counts.screenshots, 4);
    assert.match(manifest.notes.at(-1) ?? "", /^1 listed file was missing from storage/);
    assert.equal(bundle[MISSING_SHOT], undefined);
    const steps = jsonl<DatasetStep>(bundle["steps.jsonl"]);
    assert.equal(steps.find((step) => step.id === "sim-1:racer-1:1")?.screenshot, null);

    const manifestOnly = (await api.inject({ method: "GET", url: "/api/datasets/manifest.json?mode=all" })).json() as DatasetManifest;
    assert.equal(manifestOnly.counts.screenshots, 5, "the manifest route lists what the rows name");
    const year = (await api.inject({ method: "GET", url: "/api/datasets/manifest.json?mode=all&days=365" })).json() as DatasetManifest;
    assert.equal(year.counts.fights, 3);
  } finally {
    await api.close();
  }
});

test("manifest.json and each JSON Lines file are served on their own", async () => {
  const api = await app();
  try {
    const manifest = await api.inject({ method: "GET", url: "/api/datasets/manifest.json" });
    assert.equal(manifest.statusCode, 200);
    assert.match(String(manifest.headers["content-type"]), /^application\/json/);
    const body = manifest.json() as DatasetManifest;
    assert.deepEqual([body.name, body.filters.mode, body.counts.fights], ["sabotage-markets", "live", 1]);
    assert.equal(body.tool.name, "take_browser_action");

    const expected = { episodes: 4, steps: 18, sft: 4, preferences: 3 } as const;
    for (const [file, rows] of Object.entries(expected)) {
      const response = await api.inject({ method: "GET", url: `/api/datasets/${file}.jsonl` });
      assert.equal(response.statusCode, 200, file);
      assert.match(String(response.headers["content-type"]), /^application\/x-ndjson(;|$)/);
      assert.equal(
        response.headers["content-disposition"],
        `attachment; filename="sabotage-markets-${file}-2026-09-12.jsonl"`,
      );
      assert.equal(jsonl(response.body).length, rows, file);
    }
    const simulated = await api.inject({ method: "GET", url: "/api/datasets/episodes.jsonl?mode=simulated" });
    assert.deepEqual(jsonl<DatasetEpisode>(simulated.body).map((episode) => episode.raceId), Array(4).fill("sim-1"));
    const empty = await api.inject({ method: "GET", url: "/api/datasets/steps.jsonl?mode=simulated&days=1" });
    assert.deepEqual([empty.statusCode, empty.body], [200, ""]);
  } finally {
    await api.close();
  }
});

test("dataset params are validated; unknown files and the old export are not found", async () => {
  const api = await app();
  try {
    for (const route of ["/api/datasets/export.zip", "/api/datasets/manifest.json", "/api/datasets/sft.jsonl"]) {
      for (const query of INVALID_QUERIES) {
        const response = await api.inject({ method: "GET", url: `${route}${query}` });
        assert.deepEqual([response.statusCode, response.json().code], [400, "invalid"], `${route}${query}`);
      }
    }
    for (const url of ["/api/datasets/memory.jsonl", "/api/evaluations/export.jsonl"]) {
      const response = await api.inject({ method: "GET", url });
      assert.deepEqual([response.statusCode, response.json().code], [404, "not_found"], url);
    }
  } finally {
    await api.close();
  }
});

test("buildApi keeps live datasets in DATASET_DIR and simulated ones in memory unless it is set", async () => {
  assert.ok(defaultDatasetStore("simulated", {}) instanceof InMemoryDatasetStore);
  const simulatedOnDisk = defaultDatasetStore("simulated", { DATASET_DIR: "/tmp/sim-dataset" });
  assert.ok(simulatedOnDisk instanceof JsonlDatasetStore);
  assert.equal(simulatedOnDisk.dir, "/tmp/sim-dataset");
  const live = defaultDatasetStore("live", {});
  assert.ok(live instanceof JsonlDatasetStore);
  assert.equal(live.dir, resolve("data/dataset"));

  const dir = await mkdtemp(join(tmpdir(), "dataset-api-"));
  const previous = process.env.DATASET_DIR;
  try {
    await new JsonlDatasetStore(dir).put(goldenRecord(), goldenFiles());
    process.env.DATASET_DIR = dir;
    const api = buildApi({
      coordinatorFactory: createFactory().factory,
      enableTicker: false,
      evaluationStore: new InMemoryEvaluationStore(),
      now: () => NOW,
    });
    try {
      assert.ok(api.registry.datasets instanceof JsonlDatasetStore);
      const response = await api.inject({ method: "GET", url: "/api/datasets/export.zip" });
      const bundle = unzipSync(new Uint8Array(response.rawPayload));
      assert.deepEqual(Buffer.from(bundle[SCREENSHOTS.r1s1]), jpeg(1));
      assert.equal(JSON.parse(strFromU8(bundle["manifest.json"])).counts.episodes, 4);
    } finally {
      await api.close();
    }
  } finally {
    if (previous === undefined) delete process.env.DATASET_DIR;
    else process.env.DATASET_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
