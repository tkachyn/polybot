import type {
  CourseVerifier,
  RacerSessionHandle,
} from "../application/contracts.js";

export type CourseState = {
  raceId: string;
  racerId: string;
  courseId: string;
  seed?: string;
  steelSessionId?: string;
  completedCheckpoints: number[];
  targetOpened?: boolean;
  finished: boolean;
};

export interface CourseStateGateway {
  getState(input: {
    raceId: string;
    racerId: string;
    courseId: string;
    seed?: string;
    steelSessionId?: string;
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
    seed?: string;
    steelSessionId?: string;
  }): Promise<CourseState> {
    const url = new URL("/arena/state", this.baseUrl);
    url.searchParams.set("raceId", input.raceId);
    url.searchParams.set("racerId", input.racerId);
    url.searchParams.set("courseId", input.courseId);
    if (input.seed) url.searchParams.set("seed", input.seed);
    if (input.steelSessionId) {
      url.searchParams.set("steelSessionId", input.steelSessionId);
    }

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

  async verifyTargetOpening(input: {
    raceId: string;
    racerId: string;
    courseId: string;
    seed?: string;
    session: RacerSessionHandle;
  }): Promise<boolean> {
    const state = await this.gateway.getState({
      raceId: input.raceId,
      racerId: input.racerId,
      courseId: input.courseId,
      seed: input.seed,
      steelSessionId: input.session.steelSessionId,
    });
    return this.matchesRun(state, input) &&
      (state.targetOpened === true || state.completedCheckpoints.includes(1));
  }

  async verifyCheckpoint(input: {
    raceId: string;
    racerId: string;
    courseId: string;
    checkpoint: number;
    seed?: string;
    session: RacerSessionHandle;
  }): Promise<boolean> {
    const state = await this.gateway.getState({
      raceId: input.raceId,
      racerId: input.racerId,
      courseId: input.courseId,
      seed: input.seed,
      steelSessionId: input.session.steelSessionId,
    });
    return this.matchesRun(state, input) &&
      state.completedCheckpoints.includes(input.checkpoint);
  }

  async verifyFinish(input: {
    raceId: string;
    racerId: string;
    courseId: string;
    seed?: string;
    session: RacerSessionHandle;
  }): Promise<boolean> {
    const state = await this.gateway.getState({
      raceId: input.raceId,
      racerId: input.racerId,
      courseId: input.courseId,
      seed: input.seed,
      steelSessionId: input.session.steelSessionId,
    });
    return this.matchesRun(state, input) && state.finished;
  }

  private matchesRun(
    state: CourseState,
    input: {
      raceId: string;
      racerId: string;
      courseId: string;
      seed?: string;
      session?: RacerSessionHandle;
    },
  ): boolean {
    return state.raceId === input.raceId &&
      state.racerId === input.racerId &&
      state.courseId === input.courseId &&
      (!state.seed || state.seed === input.seed) &&
      (!state.steelSessionId ||
        state.steelSessionId === input.session?.steelSessionId);
  }
}
