import assert from "node:assert/strict";
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
    finished: true,
  });
  await app.close();
});
