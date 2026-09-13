/**
 * Builds a fight's dataset record (docs/training-data.md) from what the
 * coordinator holds when the fight closes: the final evaluation, the engine
 * events, each racer's step records and step screenshots, and the Steel
 * evidence already read for the evaluation. Screenshots and raw Steel traces
 * become bundle files; the record keeps only their paths.
 */
import type { AgentIdentity, DatasetSteelEvent, FightEvaluation, ServerMode } from "../api/dto.js";
import type { RaceEvent } from "../domain/types.js";
import { normalizeSteelDatasetEvent } from "../infra/steel-evidence.js";
import { screenshotPath, steelTracePath } from "./paths.js";
import {
  DATASET_SCHEMA_VERSION,
  type DatasetFileInput,
  type FightDatasetAgent,
  type FightDatasetRecord,
  type FightDatasetTask,
  type StepRecord,
} from "./types.js";

/** A step screenshot, as telemetry stores it. */
export type DatasetFrame = { contentType: string; body: Buffer | string };

export type FightCaptureRacer = {
  racerId: string;
  agent: AgentIdentity;
  /** Oldest first. */
  steps: readonly StepRecord[];
  /** The screenshot taken with a step's observation, or null. */
  frame(step: number): DatasetFrame | null;
  /** Raw Steel Agent Traces events, oldest first; null when there is no trace. */
  steelRaw: readonly unknown[] | null | undefined;
};

export type FightCaptureInput = {
  raceId: string;
  fightNumber: number;
  title: string;
  mode: ServerMode;
  task: FightDatasetTask;
  startedAt: number | null;
  finishedAt: number | null;
  evaluation: FightEvaluation;
  /** Engine events, in emission order. */
  events: readonly RaceEvent[];
  /** Racer order. */
  racers: readonly FightCaptureRacer[];
};

export type FightCapture = {
  record: FightDatasetRecord;
  /** Step screenshots and raw Steel traces, one per bundle path. */
  files: DatasetFileInput[];
};

/** The record and its files. Copies what it keeps; frame bodies are passed through. */
export function captureFightDataset(input: FightCaptureInput): FightCapture {
  const files = new Map<string, DatasetFileInput>();
  const agents = input.racers.map((racer): FightDatasetAgent => {
    const steps = racer.steps.map((step) => structuredClone(step));
    const screenshots: Record<number, string> = {};
    for (const step of steps) {
      const number = step?.step;
      if (typeof number !== "number" || screenshots[number] !== undefined) continue;
      const frame = readFrame(racer, number);
      const path = frame && screenshotPath(input.raceId, racer.racerId, number, frame.contentType);
      if (!frame || !path) continue;
      screenshots[number] = path;
      files.set(path, { path, contentType: frame.contentType, body: frame.body });
    }

    const raw = Array.isArray(racer.steelRaw) ? racer.steelRaw : null;
    const trace = raw ? serialize(raw) : null;
    let steelTraceFile: string | null = null;
    if (trace !== null) {
      steelTraceFile = steelTracePath(input.raceId, racer.racerId);
      files.set(steelTraceFile, { path: steelTraceFile, contentType: "application/json", body: trace });
    }

    return {
      racerId: racer.racerId,
      agent: { ...racer.agent },
      steps,
      screenshots,
      steelEvents: normalizeSteelEvents(raw),
      steelTraceFile,
    };
  });

  return {
    record: {
      schemaVersion: DATASET_SCHEMA_VERSION,
      raceId: input.raceId,
      fightNumber: input.fightNumber,
      title: input.title,
      mode: input.mode,
      task: { ...input.task, checkpointLabels: [...input.task.checkpointLabels] },
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      evaluation: structuredClone(input.evaluation),
      events: input.events.map((event) => structuredClone(event)),
      agents,
    },
    files: [...files.values()],
  };
}

function readFrame(racer: FightCaptureRacer, step: number): DatasetFrame | null {
  try {
    const frame = racer.frame(step);
    if (!frame || typeof frame.contentType !== "string") return null;
    return typeof frame.body === "string" || Buffer.isBuffer(frame.body) ? frame : null;
  } catch {
    return null;
  }
}

/** The raw trace as JSON, unmodified; null when it cannot be serialised. */
function serialize(raw: readonly unknown[]): string | null {
  try {
    return JSON.stringify(raw);
  } catch {
    return null;
  }
}

function normalizeSteelEvents(raw: readonly unknown[] | null): DatasetSteelEvent[] {
  if (!raw) return [];
  const events: DatasetSteelEvent[] = [];
  for (const item of raw) {
    try {
      const event = normalizeSteelDatasetEvent(item);
      if (event) events.push(event);
    } catch {
      // A malformed event is dropped here; the raw trace file keeps it.
    }
  }
  return events.sort((left, right) => left.at - right.at);
}
