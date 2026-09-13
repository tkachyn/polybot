import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  contentTypeForPath,
  normalizeDatasetPath,
  sanitizePathSegment,
  screenshotPath,
  steelTracePath,
} from "../src/dataset/paths.js";
import { InMemoryDatasetStore, JsonlDatasetStore, type DatasetStore } from "../src/dataset/store.js";
import type { FightDatasetRecord } from "../src/dataset/types.js";
import { RACE_ID, SCREENSHOTS, T, TRACES, goldenFiles, goldenRecord, jpeg, variant } from "./dataset-fixtures.js";

const BAD_PATHS = [
  "../evil.jpg",
  "/etc/evil.jpg",
  "assets/../../evil.jpg",
  "assets/./evil.jpg",
  "assets//evil.jpg",
  "assets\\evil.jpg",
  "C:/evil.jpg",
  "evil.jpg",
  "fights.jsonl/evil.jpg",
  "",
];

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "dataset-store-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function assertGoldenFiles(store: DatasetStore): Promise<void> {
  const shot = await store.readFile(SCREENSHOTS.r1s1);
  assert.deepEqual(shot, { contentType: "image/jpeg", body: jpeg(1) });
  const svg = await store.readFile(SCREENSHOTS.r3s2);
  assert.equal(svg?.contentType, "image/svg+xml");
  assert.equal(svg?.body.toString("utf8"), "<svg>racer-3 step 2</svg>");
  const trace = await store.readFile(TRACES.r1);
  assert.equal(trace?.contentType, "application/json");
  assert.equal(JSON.parse(trace?.body.toString("utf8") ?? "null")[0].type, "click");
  assert.equal(await store.readFile("assets/race-g/racer-9/step-0001.jpg"), null);
}

test("paths: sanitised segments, screenshot and trace paths, content types", () => {
  assert.equal(sanitizePathSegment("race 1/../x"), "race_1_.._x");
  assert.equal(sanitizePathSegment(".."), "_.");
  assert.equal(sanitizePathSegment(""), "_");
  assert.equal(sanitizePathSegment("racer-1"), "racer-1");
  assert.equal(screenshotPath("race-1", "racer-2", 7, "image/jpeg"), "assets/race-1/racer-2/step-0007.jpg");
  assert.equal(screenshotPath("race 1", "racer-2", 12345, "image/svg+xml"), "assets/race_1/racer-2/step-12345.svg");
  assert.equal(screenshotPath("race-1", "racer-2", 1, "image/png"), "assets/race-1/racer-2/step-0001.png");
  assert.equal(screenshotPath("race-1", "racer-2", 1, "text/html"), null);
  assert.equal(screenshotPath("race-1", "racer-2", 1, "constructor"), null);
  assert.equal(screenshotPath("race-1", "racer-2", -1, "image/jpeg"), null);
  assert.equal(steelTracePath("race/1", "racer-2"), "steel/race_1/racer-2.trace.json");
  assert.equal(contentTypeForPath("a/b.JPG"), "image/jpeg");
  assert.equal(contentTypeForPath("a/b.trace.json"), "application/json");
  assert.equal(contentTypeForPath("a/b.constructor"), "application/octet-stream");
  assert.equal(normalizeDatasetPath("assets/race 1/racer?1/step-0001.svg"), "assets/race_1/racer_1/step-0001.svg");
  for (const path of BAD_PATHS) assert.throws(() => normalizeDatasetPath(path), Error, JSON.stringify(path));
});

test("in memory: the latest put per fight wins, with its files, and lists filter", async () => {
  const store = new InMemoryDatasetStore();
  const record = goldenRecord();
  await store.put(record, goldenFiles());
  assert.deepEqual(await store.list(), [goldenRecord()]);
  await assertGoldenFiles(store);

  // The store keeps copies: neither the caller's record nor a listed one can change it.
  record.title = "Changed after put";
  (await store.list())[0].title = "Changed after list";
  assert.equal((await store.list())[0].title, "Golden fight");

  assert.deepEqual(await store.list({ mode: "simulated" }), []);
  assert.equal((await store.list({ since: T + 40_000 })).length, 1);
  assert.deepEqual(await store.list({ since: T + 40_001 }), []);

  const retitled = goldenRecord();
  retitled.title = "Retitled";
  await store.put(retitled, [{ path: SCREENSHOTS.r1s1, contentType: "image/jpeg", body: jpeg(9) }]);
  assert.deepEqual((await store.list()).map((listed) => listed.title), ["Retitled"]);
  assert.deepEqual((await store.readFile(SCREENSHOTS.r1s1))?.body, jpeg(9));
  assert.equal(await store.readFile(SCREENSHOTS.r1s2), null, "files of the replaced put are dropped");

  await store.put(variant("sim-1", T - 5_000, "simulated"), []);
  assert.deepEqual((await store.list()).map((listed) => listed.raceId), ["sim-1", RACE_ID], "oldest first");
});

test("in memory: bounded to the newest fights, evicting their files", async () => {
  const store = new InMemoryDatasetStore({ maxFights: 2 });
  for (const index of [1, 2, 3]) {
    await store.put(variant(`race-${index}`, T + index, "simulated"), [
      { path: `assets/race-${index}/racer-1/step-0001.svg`, contentType: "image/svg+xml", body: `<svg>${index}</svg>` },
    ]);
  }
  assert.equal(store.size, 2);
  assert.deepEqual((await store.list()).map((record) => record.raceId), ["race-2", "race-3"]);
  assert.equal(await store.readFile("assets/race-1/racer-1/step-0001.svg"), null);
  assert.equal((await store.readFile("assets/race-3/racer-1/step-0001.svg"))?.body.toString(), "<svg>3</svg>");

  const tiny = new InMemoryDatasetStore({ maxBytes: 1 });
  await tiny.put(variant("race-a", T, "simulated"), []);
  await tiny.put(variant("race-b", T, "simulated"), []);
  assert.deepEqual((await tiny.list()).map((record) => record.raceId), ["race-b"], "the fight just put always stays");
});

test("in memory: one bad path rejects the whole put and stores nothing", async () => {
  const store = new InMemoryDatasetStore();
  for (const path of BAD_PATHS) {
    await assert.rejects(store.put(goldenRecord(), [...goldenFiles(), { path, contentType: "image/jpeg", body: jpeg(0) }]));
    assert.equal(await store.readFile(path), null);
  }
  await assert.rejects(store.put({ raceId: "" } as FightDatasetRecord, []), /raceId/);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.readFile(SCREENSHOTS.r1s1), null);
});

test("jsonl: records and files persist across instances; the latest line per fight wins", () => withDir(async (dir) => {
  const first = new JsonlDatasetStore(dir);
  await first.put(goldenRecord(), goldenFiles());
  await first.put(variant("sim-1", T - 5_000, "simulated"), []);
  assert.equal(existsSync(join(dir, "assets", "race-g", "racer-1", "step-0001.jpg")), true);
  assert.deepEqual(await readFile(join(dir, "steel", "race-g", "racer-2.trace.json"), "utf8"), "[]");

  const second = new JsonlDatasetStore(dir);
  assert.deepEqual((await second.list()).map((record) => record.raceId), ["sim-1", RACE_ID]);
  assert.deepEqual(await second.list({ mode: "live" }), [goldenRecord()]);
  assert.deepEqual(await second.list({ since: T + 40_001 }), []);
  await assertGoldenFiles(second);

  const retitled = goldenRecord();
  retitled.title = "Retitled";
  await second.put(retitled, []);
  assert.deepEqual((await second.list({ mode: "live" })).map((record) => record.title), ["Retitled"]);
  assert.equal((await readFile(join(dir, "fights.jsonl"), "utf8")).trimEnd().split("\n").length, 3);

  // A newer line outside the filter also hides the older line inside it.
  const moved = goldenRecord();
  moved.mode = "simulated";
  await second.put(moved, []);
  assert.deepEqual(await second.list({ mode: "live" }), []);
  assert.equal(await new JsonlDatasetStore(join(dir, "missing")).readFile(SCREENSHOTS.r1s1), null);
  assert.deepEqual(await new JsonlDatasetStore(join(dir, "missing")).list(), []);
}));

test("jsonl: a torn last line is skipped and the next record starts on a fresh line", () => withDir(async (dir) => {
  const file = join(dir, "fights.jsonl");
  await writeFile(file, `${JSON.stringify(goldenRecord())}\n{"raceId":"torn","agents":[`, "utf8");
  const store = new JsonlDatasetStore(dir);
  assert.deepEqual((await store.list()).map((record) => record.raceId), [RACE_ID]);
  await store.put(variant("sim-1", T - 5_000, "simulated"), []);
  assert.deepEqual((await store.list()).map((record) => record.raceId), ["sim-1", RACE_ID]);
  const lines = (await readFile(file, "utf8")).split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[1], '{"raceId":"torn","agents":[');
  assert.equal(JSON.parse(lines[2]).raceId, "sim-1");
  assert.equal(lines[3], "");
}));

test("jsonl: paths are validated, sanitised and can never leave the directory", () => withDir(async (root) => {
  const dir = join(root, "dataset");
  const store = new JsonlDatasetStore(dir);
  for (const path of BAD_PATHS) {
    await assert.rejects(
      store.put(goldenRecord(), [...goldenFiles(), { path, contentType: "image/jpeg", body: jpeg(0) }]),
      Error,
      JSON.stringify(path),
    );
    assert.equal(await store.readFile(path), null);
  }
  assert.deepEqual(await readdir(root), [], "nothing was written anywhere");
  assert.deepEqual(await store.list(), []);

  await store.put(goldenRecord(), [{ path: "assets/race 1/racer?1/step-0001.svg", contentType: "image/svg+xml", body: "<svg/>" }]);
  assert.equal(existsSync(join(dir, "assets", "race_1", "racer_1", "step-0001.svg")), true);
  assert.equal((await store.readFile("assets/race 1/racer?1/step-0001.svg"))?.body.toString(), "<svg/>");
  assert.equal((await store.readFile("assets/race_1/racer_1/step-0001.svg"))?.contentType, "image/svg+xml");
  const leftovers = (await readdir(join(dir, "assets", "race_1", "racer_1"))).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "files are renamed into place");
}));

test("jsonl: concurrent puts are serialised into whole lines", () => withDir(async (dir) => {
  const store = new JsonlDatasetStore(dir);
  await Promise.all([1, 2, 3, 4, 5].map((index) =>
    store.put(variant(`race-${index}`, T + index, "live"), [
      { path: `assets/race-${index}/racer-1/step-0001.jpg`, contentType: "image/jpeg", body: jpeg(index) },
    ])));
  const lines = (await readFile(join(dir, "fights.jsonl"), "utf8")).trimEnd().split("\n");
  assert.deepEqual(lines.map((line) => JSON.parse(line).raceId).sort(), ["race-1", "race-2", "race-3", "race-4", "race-5"]);
  assert.deepEqual((await store.list()).map((record) => record.raceId), ["race-1", "race-2", "race-3", "race-4", "race-5"]);
  assert.deepEqual((await store.readFile("assets/race-4/racer-1/step-0001.jpg"))?.body, jpeg(4));
}));
