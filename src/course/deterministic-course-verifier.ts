import type {
  CourseVerifier,
  RacerSessionHandle,
} from "../application/contracts.js";

export type CourseState = {
  raceId: string;
  racerId: string;
  courseId: string;
  completedCheckpoints: number[];
  finished: boolean;
};

export interface CourseStateGateway {
  getState(input: {
    raceId: string;
    racerId: string;
    courseId: string;
  }): Promise<CourseState>;
}

export class HttpCourseStateGateway implements CourseStateGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {
    if (!baseUrl) throw new Error("Course state base URL is required");
  }

  async getState(input: {
    raceId: string;
    racerId: string;
    courseId: string;
  }): Promise<CourseState> {
    const url = new URL("/arena/state", this.baseUrl);
    url.searchParams.set("raceId", input.raceId);
    url.searchParams.set("racerId", input.racerId);
    url.searchParams.set("courseId", input.courseId);

    const response = await fetch(url, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      throw new Error(`Course state request failed with ${response.status}`);
    }
    const state = (await response.json()) as CourseState;
    return state;
  }
}

export class DeterministicCourseVerifier implements CourseVerifier {
  constructor(private readonly gateway: CourseStateGateway) {}

  async verifyCheckpoint(input: {
    raceId: string;
    racerId: string;
    courseId: string;
    checkpoint: number;
    session: RacerSessionHandle;
  }): Promise<boolean> {
    const state = await this.gateway.getState(input);
    return this.matchesRun(state, input) &&
      state.completedCheckpoints.includes(input.checkpoint);
  }

  async verifyFinish(input: {
    raceId: string;
    racerId: string;
    courseId: string;
    session: RacerSessionHandle;
  }): Promise<boolean> {
    const state = await this.gateway.getState(input);
    return this.matchesRun(state, input) && state.finished;
  }

  private matchesRun(
    state: CourseState,
    input: { raceId: string; racerId: string; courseId: string },
  ): boolean {
    return state.raceId === input.raceId &&
      state.racerId === input.racerId &&
      state.courseId === input.courseId;
  }
}
