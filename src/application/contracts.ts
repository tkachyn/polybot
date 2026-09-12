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

export type CompetitorContext = {
  raceId: string;
  racerId: string;
  courseId: string;
  seed: string;
  checkpointCount: number;
  session: RacerSessionHandle;
  reportCheckpoint(checkpoint: number): Promise<void>;
  reportFinish(): Promise<void>;
};

export interface CompetitorAgentRunner {
  prepare(context: Omit<CompetitorContext, "reportCheckpoint" | "reportFinish">): Promise<void>;
  run(context: CompetitorContext): Promise<void>;
  stop(racerId: string): Promise<void>;
}

export interface CourseVerifier {
  verifyCheckpoint(input: {
    raceId: string;
    racerId: string;
    courseId: string;
    checkpoint: number;
    session: RacerSessionHandle;
  }): Promise<boolean>;
  verifyFinish(input: {
    raceId: string;
    racerId: string;
    courseId: string;
    session: RacerSessionHandle;
  }): Promise<boolean>;
}

export interface RaceEventStore {
  append(event: RaceEvent): Promise<void>;
  list(raceId: string): Promise<RaceEvent[]>;
}
