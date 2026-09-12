import type { CourseState } from "./deterministic-course-verifier.js";

// Run identity and run-proof rules shared by every course the course app
// serves. One in-memory state map, keyed by stateKey, holds every run.

export type CourseKey = {
  raceId: string;
  racerId: string;
  courseId: string;
};

export type CourseRunProof = {
  seed?: string;
  steelSessionId?: string;
};

export type StoredCourseState = CourseState & {
  checkpointCount: number;
};

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error(`${name} must be an integer between 1 and 20`);
  }
  return parsed;
}

export function stateKey(input: CourseKey): string {
  return `${input.raceId}\u0000${input.racerId}\u0000${input.courseId}`;
}

export function assertRunProof(
  state: StoredCourseState,
  proof: CourseRunProof,
): void {
  if (state.seed !== undefined && proof.seed !== state.seed) {
    throw new Error("Course run seed does not match");
  }
  if (
    state.steelSessionId !== undefined &&
    proof.steelSessionId !== state.steelSessionId
  ) {
    throw new Error("Steel session does not match course run");
  }
}
