import assert from "node:assert/strict";
import test from "node:test";
import { buildCourseApp } from "../src/course/course-server.js";

test("enforces the configured course verifier token", async () => {
  const app = buildCourseApp({ verifierToken: "local-test-token" });
  const query = new URLSearchParams({
    raceId: "race-1",
    racerId: "racer-1",
    courseId: "course-1",
    seed: "seed-1",
    steelSessionId: "steel-1",
    checkpointCount: "2",
  });

  const unauthorized = await app.inject({
    method: "GET",
    url: `/arena/state?${query}`,
  });
  assert.equal(unauthorized.statusCode, 401);

  const authorized = await app.inject({
    method: "GET",
    url: `/arena/state?${query}`,
    headers: { authorization: "Bearer local-test-token" },
  });
  assert.equal(authorized.statusCode, 200);

  const initialized = await app.inject({ method: "GET", url: `/?${query}` });
  assert.equal(initialized.statusCode, 200);

  const checkpoint = await app.inject({
    method: "POST",
    url: "/arena/checkpoint",
    headers: { authorization: "Bearer local-test-token" },
    payload: {
      raceId: "race-1",
      racerId: "racer-1",
      courseId: "course-1",
      seed: "seed-1",
      steelSessionId: "steel-1",
      checkpoint: 1,
    },
  });
  assert.equal(checkpoint.statusCode, 200);

  const duplicate = await app.inject({
    method: "POST",
    url: "/arena/checkpoint",
    headers: { authorization: "Bearer local-test-token" },
    payload: {
      raceId: "race-1",
      racerId: "racer-1",
      courseId: "course-1",
      seed: "seed-1",
      steelSessionId: "steel-1",
      checkpoint: 1,
    },
  });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.json().duplicate, true);

  const spoofed = await app.inject({
    method: "POST",
    url: "/arena/checkpoint",
    headers: { authorization: "Bearer local-test-token" },
    payload: {
      raceId: "race-1",
      racerId: "racer-1",
      courseId: "course-1",
      seed: "wrong-seed",
      steelSessionId: "steel-1",
      checkpoint: 2,
    },
  });
  assert.equal(spoofed.statusCode, 400);
  await app.close();
});
