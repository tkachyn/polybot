import type { Page } from "playwright";
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
  /** Verifier-backed completion check after a browser action. */
  checkFinish?(): Promise<boolean>;
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
