import type { CourseVerifier } from "../application/contracts.js";

/** The simulated course has no server state: every report verifies. */
export class SimulatedCourseVerifier implements CourseVerifier {
  async verifyTargetOpening(): Promise<boolean> {
    return true;
  }

  async verifyCheckpoint(): Promise<boolean> {
    return true;
  }

  async verifyFinish(): Promise<boolean> {
    return true;
  }
}
