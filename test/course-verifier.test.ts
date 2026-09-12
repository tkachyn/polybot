import assert from "node:assert/strict";
import test from "node:test";
import {
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
