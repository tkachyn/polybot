/**
 * The dataset layer's stored unit (docs/training-data.md): one record per
 * closed fight, holding every agent's step records, the bundle paths of their
 * step screenshots and their normalised Steel events. The training files are
 * derived from records by `buildDatasetRows`. Screenshots and raw Steel traces
 * are stored as bundle files, never inside the record.
 */
import type { AgentIdentity, DatasetSteelEvent, FightEvaluation, ServerMode } from "../api/dto.js";
import type { StepRecord } from "../application/race-telemetry.js";
import type { RaceEvent } from "../domain/types.js";

/** One racer step as telemetry records it (`RaceTelemetry.stepRecords`). */
export type { StepRecord };

export const DATASET_SCHEMA_VERSION = 1 as const;

export type FightDatasetTask = {
  text: string;
  courseId: string;
  seed: string;
  /** Index k - 1 labels checkpoint k. */
  checkpointLabels: string[];
  checkpointCount: number;
};

export type FightDatasetAgent = {
  racerId: string;
  agent: AgentIdentity;
  /** Oldest first, at most 500. */
  steps: StepRecord[];
  /** Step number → bundle path, e.g. `assets/<raceId>/<racerId>/step-0007.jpg`. */
  screenshots: Record<number, string>;
  /** Steel Agent Traces events, normalised, oldest first. Live runs only. */
  steelEvents: DatasetSteelEvent[];
  /** `steel/<raceId>/<racerId>.trace.json`, or null when Steel returned no trace. */
  steelTraceFile: string | null;
};

export type FightDatasetRecord = {
  schemaVersion: typeof DATASET_SCHEMA_VERSION;
  raceId: string;
  fightNumber: number;
  title: string;
  mode: ServerMode;
  task: FightDatasetTask;
  startedAt: number | null;
  finishedAt: number | null;
  /** The fight's final evaluation. */
  evaluation: FightEvaluation;
  /** Engine events, in emission order. */
  events: RaceEvent[];
  /** Racer order. */
  agents: FightDatasetAgent[];
};

/** A bundle file stored with a record: a step screenshot or a raw Steel trace. */
export type DatasetFileInput = {
  /** Bundle path, e.g. `assets/<raceId>/<racerId>/step-0007.jpg`. */
  path: string;
  contentType: string;
  body: Buffer | string;
};

export type StoredDatasetFile = {
  contentType: string;
  body: Buffer;
};

/** When a record counts for windowing: the fight's finish, else when it was evaluated. */
export function datasetRecordTime(
  record: Pick<FightDatasetRecord, "finishedAt" | "evaluation">,
): number {
  return record.finishedAt ?? record.evaluation?.generatedAt ?? 0;
}
