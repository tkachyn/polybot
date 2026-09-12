import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildCourseApp } from "../src/course/course-server.js";

const identity = {
  raceId: "race-1",
  racerId: "racer-1",
  courseId: "course-1",
};

test("serves a deterministic course and records verified completion", async () => {
  const app = buildCourseApp();
  const query = new URLSearchParams({
    ...identity,
    checkpointCount: "2",
  });
  const page = await app.inject({ method: "GET", url: `/?${query}` });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /data-arena-role="primary-action"/);

  for (const checkpoint of [1, 2]) {
    const response = await app.inject({
      method: "POST",
      url: "/arena/checkpoint",
      payload: { ...identity, checkpoint },
    });
    assert.equal(response.statusCode, 200);
  }

  const finished = await app.inject({
    method: "POST",
    url: "/arena/finish",
    payload: identity,
  });
  assert.equal(finished.statusCode, 200);

  const stateQuery = new URLSearchParams(identity);
  const state = await app.inject({
    method: "GET",
    url: `/arena/state?${stateQuery}`,
  });
  assert.deepEqual(state.json(), {
    ...identity,
    completedCheckpoints: [1, 2],
    targetOpened: true,
    finished: true,
  });
  await app.close();
});

test("keeps the existing course byte-for-byte for other course ids", async () => {
  const app = buildCourseApp();
  const run = {
    raceId: "race-g",
    racerId: "racer-g",
    courseId: "course-1",
    seed: "seed-g",
    steelSessionId: "steel-g",
  };
  const url = `/?${new URLSearchParams({ ...run, checkpointCount: "2" })}`;
  const digest = async () => {
    const page = await app.inject({ method: "GET", url });
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(page.headers["cache-control"], undefined);
    return createHash("sha256").update(page.body).digest("hex");
  };
  const report = (path: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: path, payload });

  // SHA-256 of each page state, captured from the course before the storefront existed.
  assert.equal(await digest(), "e7f98c596919c48aaf2fbf7dd59bf78f911f2989ad35c663c5dac91adcae13e6");
  assert.equal((await report("/arena/checkpoint", { ...run, checkpoint: 1 })).statusCode, 200);
  assert.equal(await digest(), "e6f0c7771e81a73dafc66c5a521c10402a2bbe7df789a212c7d89b0b1964df97");
  assert.equal((await report("/arena/checkpoint", { ...run, checkpoint: 2 })).statusCode, 200);
  assert.equal(await digest(), "d2976f8d4c0f3139be0bd388cc570aebf57d4802184114034b9f425c9984d9f5");
  assert.equal((await report("/arena/finish", run)).statusCode, 200);
  assert.equal(await digest(), "95d33d7734d178824bb0ff8282bc2bb86b50725e2e7c1a8d5cdc27f06de632cc");

  const state = await app.inject({
    method: "GET",
    url: `/arena/state?${new URLSearchParams({ raceId: run.raceId, racerId: run.racerId, courseId: run.courseId })}`,
  });
  assert.deepEqual(state.json(), {
    ...run,
    completedCheckpoints: [1, 2],
    targetOpened: true,
    finished: true,
  });
  await app.close();
});

test("rejects direct progress reports only for the storefront course", async () => {
  const app = buildCourseApp();
  const uninitialized = await app.inject({
    method: "POST",
    url: "/arena/checkpoint",
    payload: { raceId: "race-2", racerId: "racer-1", courseId: "course-2", checkpoint: 1 },
  });
  assert.equal(uninitialized.statusCode, 400);
  assert.deepEqual(uninitialized.json(), { error: "Course run was not initialized" });

  for (const path of ["/arena/checkpoint", "/arena/finish"]) {
    const shortcut = await app.inject({
      method: "POST",
      url: path,
      payload: { raceId: "race-2", racerId: "racer-1", courseId: "arena-shop", checkpoint: 1 },
    });
    assert.equal(shortcut.statusCode, 400);
    assert.match(shortcut.json().error, /recorded by the storefront/);
  }
  await app.close();
});
