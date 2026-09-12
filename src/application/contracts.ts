import type { Page } from "playwright";
import type { BlockedBy, CursorPosition } from "../api/dto.js";
import type { RaceEvent } from "../domain/types.js";

export type RacerSessionHandle = {
  racerId: string;
  steelSessionId: string;
  page?: Page;
  viewerUrl?: string;
};

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
  at?: number;
  /** What the browser reported about this step, independent of the model's claim. */
  evidence?: ActionEvidence;
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
};

/** A periodic capture of a racer's browser. */
export type CapturedFrame = {
  contentType: "image/jpeg" | "image/png" | "image/svg+xml";
  body: Buffer | string;
  capturedAt?: number;
};

export type CompetitorContext = {
  raceId: string;
  racerId: string;
  courseId: string;
  seed: string;
  checkpointCount: number;
  session: RacerSessionHandle;
  reportCheckpoint(checkpoint: number): Promise<void>;
  reportFinish(): Promise<void>;
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
