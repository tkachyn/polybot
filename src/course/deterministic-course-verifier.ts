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

export class CourseStateRequestError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly status?: number,
    retryable = status === undefined || status === 408 || status === 425 ||
      status === 429 || status >= 500,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CourseStateRequestError";
    this.retryable = retryable;
  }
}

export function isTransientCourseStateError(error: unknown): boolean {
  if (error instanceof CourseStateRequestError) return error.retryable;
  if (!(error instanceof Error)) return true;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  if (/\b(?:401|403|404|422)\b|unauthori[sz]ed|forbidden|invalid.+(?:token|proof|run)/i.test(error.message)) {
    return false;
  }
  return true;
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

    let response: Response;
    try {
      response = await fetch(url, {
        headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
        signal: AbortSignal.timeout(3_000),
      });
    } catch (error) {
      throw new CourseStateRequestError(
        `Course state request failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        true,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new CourseStateRequestError(
        `Course state request failed with ${response.status}`,
        response.status,
      );
    }
    let state: CourseState;
    try {
      state = (await response.json()) as CourseState;
    } catch (error) {
      throw new CourseStateRequestError(
        "Course state response was not valid JSON",
        response.status,
        false,
        { cause: error },
      );
    }
    return state;
  }
}

export type DeterministicCourseVerifierOptions = {
  /** Total gateway attempts, including the first request. */
  maxAttempts?: number;
  /** Delay between retry attempts. Defaults to 75 ms. */
  retryDelayMs?: number;
};

export class DeterministicCourseVerifier implements CourseVerifier {
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly gateway: CourseStateGateway,
    options: DeterministicCourseVerifierOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 75;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer");
    }
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new Error("retryDelayMs must be a non-negative number");
    }
  }

  async getProgress(input: {
    raceId: string;
    racerId: string;
    courseId: string;
    seed?: string;
    session: RacerSessionHandle;
  }): Promise<{ completedCheckpoints: number[]; finished: boolean } | null> {
    const state = await this.readState({
      raceId: input.raceId,
      racerId: input.racerId,
      courseId: input.courseId,
      seed: input.seed,
      steelSessionId: input.session.steelSessionId,
    });
    if (!this.matchesRun(state, input)) return null;
    return {
      completedCheckpoints: normalizeCheckpoints(state.completedCheckpoints),
      finished: state.finished,
    };
  }

  async verifyTargetOpening(input: {
    raceId: string;
    racerId: string;
    courseId: string;
    seed?: string;
    session: RacerSessionHandle;
  }): Promise<boolean> {
    const state = await this.readState({
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
    const state = await this.readState({
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
    const state = await this.readState({
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

  private async readState(input: Parameters<CourseStateGateway["getState"]>[0]): Promise<CourseState> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.gateway.getState(input);
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxAttempts || !isTransientCourseStateError(error)) throw error;
        if (this.retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function normalizeCheckpoints(checkpoints: number[]): number[] {
  return [...new Set(checkpoints.filter((checkpoint) =>
    Number.isInteger(checkpoint) && checkpoint > 0,
  ))].sort((left, right) => left - right);
}
