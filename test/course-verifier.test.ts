import assert from "node:assert/strict";
import test from "node:test";
import {
  CourseStateRequestError,
  DeterministicCourseVerifier,
  type CourseStateGateway,
} from "../src/course/deterministic-course-verifier.js";

const session = { racerId: "racer-1", steelSessionId: "steel-1" };

test("accepts only checkpoint state belonging to the exact run", async () => {
  const gateway: CourseStateGateway = {
    async getState() {
      return {
        raceId: "race-1",
        racerId: "racer-1",
        courseId: "course-1",
        completedCheckpoints: [1, 2],
        finished: false,
      };
    },
  };
  const verifier = new DeterministicCourseVerifier(gateway);

  assert.equal(await verifier.verifyCheckpoint({
    raceId: "race-1",
    racerId: "racer-1",
    courseId: "course-1",
    checkpoint: 2,
    session,
  }), true);
  assert.equal(await verifier.verifyCheckpoint({
    raceId: "race-2",
    racerId: "racer-1",
    courseId: "course-1",
    checkpoint: 2,
    session,
  }), false);
});

test("accepts a finish only when the exact run is marked finished", async () => {
  const gateway: CourseStateGateway = {
    async getState(input) {
      return {
        ...input,
        completedCheckpoints: [1, 2, 3],
        finished: true,
      };
    },
  };
  const verifier = new DeterministicCourseVerifier(gateway);
  assert.equal(await verifier.verifyFinish({
    raceId: "race-1",
    racerId: "racer-1",
    courseId: "course-1",
    session,
  }), true);
});

test("verifies the first target-opening milestone against the run proof", async () => {
  const gateway: CourseStateGateway = {
    async getState() {
      return {
        raceId: "race-1",
        racerId: "racer-1",
        courseId: "course-1",
        seed: "seed-1",
        steelSessionId: "steel-1",
        completedCheckpoints: [1],
        targetOpened: true,
        finished: false,
      };
    },
  };
  const verifier = new DeterministicCourseVerifier(gateway);

  assert.equal(await verifier.verifyTargetOpening({
    raceId: "race-1",
    racerId: "racer-1",
    courseId: "course-1",
    seed: "seed-1",
    session,
  }), true);
  assert.equal(await verifier.verifyTargetOpening({
    raceId: "race-1",
    racerId: "racer-1",
    courseId: "course-1",
    seed: "wrong-seed",
    session,
  }), false);
});

test("retries transient course-state failures and normalizes duplicate progress", async () => {
  let calls = 0;
  const gateway: CourseStateGateway = {
    async getState() {
      calls += 1;
      if (calls < 3) throw new CourseStateRequestError("temporarily unavailable", 503);
      return {
        raceId: "race-1",
        racerId: "racer-1",
        courseId: "course-1",
        completedCheckpoints: [3, 1, 2, 2, 1],
        finished: false,
      };
    },
  };
  const verifier = new DeterministicCourseVerifier(gateway, { retryDelayMs: 0 });

  assert.deepEqual(await verifier.getProgress({
    raceId: "race-1",
    racerId: "racer-1",
    courseId: "course-1",
    session,
  }), { completedCheckpoints: [1, 2, 3], finished: false });
  assert.equal(calls, 3);
});

test("does not retry hard authorization failures", async () => {
  let calls = 0;
  const gateway: CourseStateGateway = {
    async getState() {
      calls += 1;
      throw new CourseStateRequestError("forbidden", 403, false);
    },
  };
  const verifier = new DeterministicCourseVerifier(gateway, { retryDelayMs: 0 });

  await assert.rejects(
    verifier.verifyFinish({
      raceId: "race-1",
      racerId: "racer-1",
      courseId: "course-1",
      session,
    }),
    /forbidden/,
  );
  assert.equal(calls, 1);
});
