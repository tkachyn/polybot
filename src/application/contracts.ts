import type { Page } from "playwright";
import type { BlockedBy, CursorPosition, DatasetAction, DecisionIssue, StepObservation } from "../api/dto.js";
import type { RaceEvent } from "../domain/types.js";

export type RacerSessionHandle = {
  racerId: string;
  steelSessionId: string;
  page?: Page;
  viewerUrl?: string;
};

export type CompletionObservation = {
  url: string;
  title: string;
  bodyText: string;
  controls: Array<{
    tag: string;
    role: string | null;
    arenaRole: string | null;
    text: string;
    disabled: boolean;
    visible: boolean;
  }>;
};

export type WorkerStateObservation = CompletionObservation & {
  at: number;
  step: number;
  maxSteps: number;
  candidateMilestone?: string;
  navigated?: boolean;
};

export interface CompletionJudge {
  judgeCheckpoint(input: {
    task: string;
    racerId: string;
    checkpoint: number;
    observation: CompletionObservation;
    candidateMilestone?: string;
  }): Promise<boolean>;
  judgeCompletion(input: {
    task: string;
    racerId: string;
    observation: CompletionObservation;
    candidateMilestone?: string;
  }): Promise<boolean>;
}

export interface RacerSessionManager {
  create(racerId: string): Promise<RacerSessionHandle>;
  release(racerId: string): Promise<void>;
  releaseAll(): Promise<void>;
  /**
   * Live Steel only: the racer's Steel session id and the API key that
   * created it, remembered after release so Agent Traces and the recording
   * can still be read. Never log or expose the key.
   */
  evidence?(racerId: string): { steelSessionId: string; apiKey: string } | null;
}

/** One step of a competitor's loop, reported for spectator telemetry. */
export type AgentActionReport = {
  kind: "action" | "error" | "note";
  /** Human-readable, e.g. "click checkout-submit". */
  text: string;
  /** Page URL after the step, when known. */
  url?: string;
  /** Actions taken so far, including this one. */
  step: number;
  /** The agent's action budget. */
  maxSteps: number;
  /** Stable key for loop detection. Defaults to `text`. */
  signature?: string;
  error?: string;
  /**
   * What the model's history says about this step: its failure as the model
   * was shown it (no call log, nothing hidden), or the runner's feedback on a
   * step that worked, such as a repeated inspect of an unchanged page.
   */
  modelError?: string;
  at?: number;
  /** What the browser reported about this step, independent of the model's claim. */
  evidence?: ActionEvidence;
  /** What the model saw when it chose this step. */
  observation?: StepObservation;
  /** The exact tool call, with text typed into password fields redacted. */
  action?: DatasetAction;
  /** The model's stated reason for this step, when it gave one. */
  reasoning?: string;
  /** When the observation was taken, and when the model answered. */
  observedAt?: number;
  decidedAt?: number;
  /** When the prompt was sent: after the screenshot and any rate-limit pause. */
  promptedAt?: number;
  /** How long the provider's rate limit held the prompt back. */
  rateLimitWaitMs?: number;
  /** Set when the decision was not one valid tool call on the first try. */
  decisionIssue?: DecisionIssue;
};

/**
 * Browser-side ground truth for one step, read by the runner around the
 * action. Never shown to the competitor model.
 */
export type ActionEvidence = {
  /** The element the action resolved to, read just before acting. */
  target?: {
    /** Its `data-arena-role`. */
    role: string | null;
    /** Its visible label, trimmed to at most 120 characters. */
    text: string | null;
    /** The element was a planted decoy (`data-arena-decoy="true"`). */
    decoy: boolean;
  };
  /** Why the action could not complete, classified from the browser error. */
  blockedBy?: BlockedBy;
  /** The browser pointer position used for a click or text input. */
  cursor?: CursorPosition;
  /** The page URL changed as a result of the action. */
  navigated?: boolean;
  /** An arena sabotage was active before the action and none is after it. */
  clearedSabotage?: boolean;
};

/** A periodic capture of a racer's browser. */
export type CapturedFrame = {
  contentType: "image/jpeg" | "image/png" | "image/svg+xml";
  body: Buffer | string;
  capturedAt?: number;
  /** Set on the screenshot taken with this step's observation. */
  step?: number;
};

export type CompetitorContext = {
  raceId: string;
  racerId: string;
  courseId: string;
  seed: string;
  checkpointCount: number;
  session: RacerSessionHandle;
  /** Returns false when the authoritative verifier has not accepted progress. */
  reportCheckpoint(checkpoint: number, source?: "course" | "master"): Promise<boolean | void>;
  /** Returns false when the authoritative verifier has not accepted finish. */
  reportFinish(source?: "course" | "master"): Promise<boolean | void>;
  /** Optional site-agnostic fallback when the course has no completion proof. */
  completionJudge?: CompletionJudge;
  /** Page state is evidence/request-for-review data, never completion proof. */
  reportState?(observation: WorkerStateObservation): void;
  /**
   * Reviews the current page for the next checkpoint or completion. Worker
   * claims remain hints; the callback decides from the supplied observation.
   * Returns true only when the race accepted a verified finish.
   */
  reviewProgress?(observation: WorkerStateObservation): Promise<boolean>;
  /** Ends the racer's current persistent sabotage recovery state. */
  reportRecovery?(): Promise<void>;
  /** Verifier-backed completion check after a browser action. */
  checkFinish?(): Promise<boolean>;
  /**
   * Verifier-backed progress sync after a browser action: records, in order,
   * every checkpoint the course reports as completed that the race has not
   * claimed yet. Never throws.
   */
  syncProgress?(): Promise<void>;
  /** Telemetry sink. Never throws. */
  reportAction?(report: AgentActionReport): void;
  /** Frame sink. Never throws. */
  reportFrame?(frame: CapturedFrame): void;
};

export interface CompetitorAgentRunner {
  prepare(context: Omit<CompetitorContext, "reportCheckpoint" | "reportFinish">): Promise<void>;
  run(context: CompetitorContext): Promise<void>;
  stop(racerId: string): Promise<void>;
}

export interface CourseVerifier {
  /** Returns verified course progress when the verifier supports progress reads. */
  getProgress?(input: {
    raceId: string;
    racerId: string;
    courseId: string;
    seed?: string;
    session: RacerSessionHandle;
  }): Promise<{
    completedCheckpoints: number[];
    finished: boolean;
  } | null>;
  verifyTargetOpening(input: {
    raceId: string;
    racerId: string;
    courseId: string;
    seed?: string;
    session: RacerSessionHandle;
  }): Promise<boolean>;
  verifyCheckpoint(input: {
    raceId: string;
    racerId: string;
    courseId: string;
    checkpoint: number;
    seed?: string;
    session: RacerSessionHandle;
  }): Promise<boolean>;
  verifyFinish(input: {
    raceId: string;
    racerId: string;
    courseId: string;
    seed?: string;
    session: RacerSessionHandle;
  }): Promise<boolean>;
}

export interface RaceEventStore {
  append(event: RaceEvent): Promise<void>;
  list(raceId: string): Promise<RaceEvent[]>;
}
