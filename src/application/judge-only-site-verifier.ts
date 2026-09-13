import type {
  CourseVerifier,
  RacerSessionHandle,
} from "./contracts.js";

/**
 * Verifier for an external site whose state is intentionally not mirrored by
 * the arena. Progress is decided by the master from the visible page, while
 * direct checkpoint/finish claims remain untrusted and fail closed.
 */
export class JudgeOnlySiteVerifier implements CourseVerifier {
  coversRun(): boolean {
    return false;
  }

  async verifyTargetOpening(_input: {
    raceId: string;
    racerId: string;
    courseId: string;
    seed?: string;
    session: RacerSessionHandle;
  }): Promise<boolean> {
    return false;
  }

  async verifyCheckpoint(_input: {
    raceId: string;
    racerId: string;
    courseId: string;
    checkpoint: number;
    seed?: string;
    session: RacerSessionHandle;
  }): Promise<boolean> {
    return false;
  }

  async verifyFinish(_input: {
    raceId: string;
    racerId: string;
    courseId: string;
    seed?: string;
    session: RacerSessionHandle;
  }): Promise<boolean> {
    return false;
  }
}
