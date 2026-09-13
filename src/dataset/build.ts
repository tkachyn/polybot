/**
 * Pure, deterministic derivation of the training dataset from fight records
 * (docs/training-data.md, "How rows are derived"; row shapes: src/api/dto.ts,
 * "Dataset export"). Nothing here reads a clock, a random source or the
 * filesystem, and no input is mutated.
 */
import { createHash } from "node:crypto";
import { type AgentDecision, type BrowserObservation, modelFacingErrorText } from "../agents/playwright-competitor-runner.js";
import { COMPETITOR_SYSTEM_PROMPT, COMPETITOR_TOOL_DESCRIPTION, COMPETITOR_TOOL_NAME, COMPETITOR_TOOL_SCHEMA, competitorUserMessage, parseDecision, REDACTED_TEXT } from "../agents/competitor-decision.js";
import type {
  AgentEvaluation,
  AgentIdentity,
  BlockedBy,
  DatasetAction,
  DatasetEpisode,
  DatasetFile,
  DatasetManifest,
  DatasetPreference,
  DatasetSftExample,
  DatasetStep,
  DatasetSteelEvent,
  DecisionIssue,
  HazardType,
  SabotageTier,
  ServerMode,
  StepObservation,
  StepQuality,
} from "../api/dto.js";
import { HAZARD_TYPES } from "../domain/sabotage.js";
import type { RaceEvent } from "../domain/types.js";
import { sabotageStepIdOf } from "../evaluation/evaluator.js";
import {
  DATASET_SCHEMA_VERSION,
  datasetRecordTime,
  type FightDatasetAgent,
  type FightDatasetRecord,
  type StepRecord,
} from "./types.js";

export const DATASET_NAME = "sabotage-markets";
export const DATASET_FILES: readonly DatasetFile[] = ["episodes", "steps", "sft", "preferences"];
/** Prompts carry this many previous actions, as the runner's history does. */
export const DATASET_HISTORY_LIMIT = 10;

const DAY_MS = 86_400_000;
const MODES: readonly string[] = ["live", "simulated"];
const TIERS: readonly string[] = ["basic", "intermediate", "difficult"];
const BLOCKED_BY: readonly string[] = ["modal", "disabled", "hidden", "missing", "timeout"];

export type DatasetMode = ServerMode | "all";

export type DatasetBuildOptions = {
  /** Becomes `manifest.generatedAt`; the window ends here. */
  now: number;
  /** Fights that finished in the `days` before `now` (by `finishedAt ?? evaluation.generatedAt`). */
  days: number;
  mode: DatasetMode;
};

export type DatasetRows = {
  manifest: DatasetManifest;
  episodes: DatasetEpisode[];
  steps: DatasetStep[];
  sft: DatasetSftExample[];
  preferences: DatasetPreference[];
  /** Bundle paths the rows reference, each once: per fight, its screenshots then its Steel traces. */
  files: string[];
};

/** A racer's sabotage window: from its hit until its next recovery. */
type HazardWindow = {
  stepId: string;
  hazardType: HazardType;
  tier: SabotageTier;
  checkpoint: number;
  appliedAt: number;
  clearedAt: number | null;
};

type DerivedStep = {
  row: DatasetStep;
  /** The window the step was observed in. */
  trap: HazardWindow | null;
  /** The error text the model was shown for this step; never the raw browser error. */
  modelError: string | null;
};

type DerivedRacer = {
  racerId: string;
  agent: AgentIdentity;
  evaluation: AgentEvaluation | null;
  source: FightDatasetAgent;
  windows: HazardWindow[];
  /** Executed steps, oldest first. */
  steps: DerivedStep[];
};

type RacerStep = { racer: DerivedRacer; step: DerivedStep; index: number };

type ProgressTimes = {
  checkpoints: Array<{ at: number; checkpoint: number }>;
  finishes: number[];
};

/**
 * Every training row for the records in the window and mode: the latest
 * record per raceId, fights oldest first, racers in order, steps oldest first.
 */
export function buildDatasetRows(
  records: readonly FightDatasetRecord[],
  options: DatasetBuildOptions,
): DatasetRows {
  const since = options.now - options.days * DAY_MS;
  const fights = selectRecords(records, since, options.mode);
  const episodes: DatasetEpisode[] = [];
  const steps: DatasetStep[] = [];
  const sft: DatasetSftExample[] = [];
  const preferences: DatasetPreference[] = [];
  const files: string[] = [];
  const listed = new Set<string>();
  const pairKeys = new Set<string>();
  const byMode: Record<ServerMode, number> = { live: 0, simulated: 0 };
  let screenshots = 0;
  let steelTraces = 0;
  const list = (path: string | null): boolean => {
    if (path === null || listed.has(path)) return false;
    listed.add(path);
    files.push(path);
    return true;
  };

  for (const record of fights) {
    byMode[record.mode] += 1;
    const racers = record.agents
      .filter((agent) => isObject(agent) && typeof agent.racerId === "string")
      .map((agent) => deriveRacer(record, agent));
    for (const racer of racers) {
      for (const { row } of racer.steps) {
        steps.push(row);
        if (list(row.screenshot)) screenshots += 1;
      }
    }
    for (const agent of record.evaluation.agents) {
      const racer = racers.find((candidate) => candidate.racerId === agent.racerId) ?? null;
      const episode = episodeRow(record, agent, racer);
      episodes.push(episode);
      if (list(episode.steelTraceFile)) steelTraces += 1;
      if (racer && (agent.outcome === "won" || agent.outcome === "finished")) {
        sft.push(...sftExamples(record, racer));
      }
    }
    // Identical prompt, chosen and rejected actions are kept once.
    for (const preference of preferencePairs(record, racers)) {
      const key = JSON.stringify([preference.prompt, preference.chosen, preference.rejected]);
      if (pairKeys.has(key)) continue;
      pairKeys.add(key);
      preferences.push(preference);
    }
  }

  const manifest: DatasetManifest = {
    schemaVersion: DATASET_SCHEMA_VERSION,
    name: DATASET_NAME,
    generatedAt: options.now,
    filters: { days: options.days, mode: options.mode },
    counts: {
      fights: fights.length,
      episodes: episodes.length,
      steps: steps.length,
      sft: sft.length,
      preferences: preferences.length,
      screenshots,
      steelTraces,
    },
    byMode,
    files: [
      {
        path: "episodes.jsonl",
        description: "One agent in one fight (DatasetEpisode): outcome, robustness, every sabotage reaction, crowd prices, and links to its steps and Steel trace.",
        rows: episodes.length,
      },
      {
        path: "steps.jsonl",
        description: "One agent step (DatasetStep): what the model saw, the tool call it made and why, the verified result, the sabotage in effect, Steel events and labels.",
        rows: steps.length,
      },
      {
        path: "sft.jsonl",
        description: "Chat-format fine-tuning examples (DatasetSftExample) from good steps of won or finished runs, replayable with `tool` and `systemPrompt`.",
        rows: sft.length,
      },
      {
        path: "preferences.jsonl",
        description: "Chosen and rejected actions at sabotage moments (DatasetPreference), for preference training such as DPO.",
        rows: preferences.length,
      },
      {
        path: "assets/<raceId>/<racerId>/step-NNNN.<ext>",
        description: "The screenshot each step's observation was taken with (DatasetStep.screenshot).",
        rows: null,
      },
      {
        path: "steel/<raceId>/<racerId>.trace.json",
        description: "One agent's raw Steel Agent Traces events, as Steel returned them (DatasetEpisode.steelTraceFile).",
        rows: null,
      },
    ],
    tool: {
      name: COMPETITOR_TOOL_NAME,
      description: COMPETITOR_TOOL_DESCRIPTION,
      parameters: structuredClone(COMPETITOR_TOOL_SCHEMA),
    },
    systemPrompt: COMPETITOR_SYSTEM_PROMPT,
    notes: [
      "Steel typing events record the field, input type, length and timing, never the characters; the exact text an agent typed is in its action.",
      `Text typed into password fields is replaced with "${REDACTED_TEXT}" (textLength keeps its length), and sft.jsonl skips those steps.`,
      "Simulated rows come from scripted agents, not real models; use mode=live for training.",
      "Steel timestamps come from Steel's clock; the per-step Steel slices assume it agrees with the server clock.",
      `Window: fights that finished in the ${options.days} days before ${isoTime(options.now)} (since ${isoTime(since)}); mode: ${options.mode}.`,
    ],
  };

  return { manifest, episodes, steps, sft, preferences, files };
}

/** JSON Lines: one JSON value per line, each line ending in "\n". */
export function toJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

// ---------------------------------------------------------------------------
// Records and windows
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isHazardType(value: unknown): value is HazardType {
  return typeof value === "string" && (HAZARD_TYPES as readonly string[]).includes(value);
}

function isTier(value: unknown): value is SabotageTier {
  return typeof value === "string" && TIERS.includes(value);
}

function blockedByOf(value: unknown): BlockedBy | null {
  return typeof value === "string" && BLOCKED_BY.includes(value) ? value as BlockedBy : null;
}

function isoTime(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? String(ms) : date.toISOString();
}

function isUsable(record: unknown): record is FightDatasetRecord {
  if (!isObject(record)) return false;
  const candidate = record as Partial<FightDatasetRecord>;
  return typeof candidate.raceId === "string" &&
    candidate.raceId.length > 0 &&
    typeof candidate.mode === "string" &&
    MODES.includes(candidate.mode) &&
    isObject(candidate.task) &&
    isObject(candidate.evaluation) &&
    Array.isArray(candidate.evaluation.agents) &&
    Array.isArray(candidate.agents) &&
    Array.isArray(candidate.events);
}

/** The latest record per raceId (by evaluation.generatedAt), in the window and mode, oldest first. */
function selectRecords(
  records: readonly FightDatasetRecord[],
  since: number,
  mode: DatasetMode,
): FightDatasetRecord[] {
  const byRace = new Map<string, FightDatasetRecord>();
  for (const record of records) {
    if (!isUsable(record)) continue;
    const previous = byRace.get(record.raceId);
    if (!previous || !(record.evaluation.generatedAt < previous.evaluation.generatedAt)) {
      byRace.set(record.raceId, record);
    }
  }
  return [...byRace.values()]
    .filter((record) =>
      (mode === "all" || record.mode === mode) && datasetRecordTime(record) >= since)
    .sort((left, right) =>
      datasetRecordTime(left) - datasetRecordTime(right) || compareText(left.raceId, right.raceId));
}

/** Each `sabotage_applied` for the racer, open until that racer's next `sabotage_recovered`. */
function hazardWindows(record: FightDatasetRecord, racerId: string): HazardWindow[] {
  const windows: HazardWindow[] = [];
  const events = record.events;
  events.forEach((event, index) => {
    if (!isObject(event) || event.type !== "sabotage_applied" || event.racerId !== racerId) return;
    const appliedAt = finiteOrNull(event.occurredAt);
    if (appliedAt === null) return;
    const stepId = sabotageStepIdOf(event);
    const metadata = isObject(event.metadata) ? event.metadata : {};
    const policy = isObject(metadata.policy) ? metadata.policy : {};
    const planned = (record.evaluation.sabotageSteps ?? []).find((step) => step.stepId === stepId);
    const hazardType = isHazardType(policy.hazardType) ? policy.hazardType : planned?.hazardType;
    const tier = isTier(metadata.tier) ? metadata.tier : planned?.tier;
    if (!hazardType || !tier) return;
    let clearedAt: number | null = null;
    for (const later of events.slice(index + 1)) {
      if (isObject(later) && later.type === "sabotage_recovered" && later.racerId === racerId) {
        clearedAt = finiteOrNull(later.occurredAt);
        if (clearedAt !== null) break;
      }
    }
    windows.push({
      stepId,
      hazardType,
      tier,
      checkpoint: finiteOrNull(event.checkpoint) ?? planned?.checkpoint ?? 0,
      appliedAt,
      clearedAt,
    });
  });
  return windows;
}

/** The latest window containing `at`: [appliedAt, clearedAt ?? ∞). */
function windowAt(windows: readonly HazardWindow[], at: number): HazardWindow | null {
  for (let index = windows.length - 1; index >= 0; index -= 1) {
    const candidate = windows[index];
    if (at >= candidate.appliedAt && (candidate.clearedAt === null || at < candidate.clearedAt)) {
      return candidate;
    }
  }
  return null;
}

function progressTimes(events: readonly RaceEvent[], racerId: string): ProgressTimes {
  const times: ProgressTimes = { checkpoints: [], finishes: [] };
  for (const event of events) {
    if (!isObject(event) || event.racerId !== racerId) continue;
    const at = finiteOrNull(event.occurredAt);
    if (at === null) continue;
    if (event.type === "checkpoint_reached") {
      const checkpoint = finiteOrNull(event.checkpoint);
      if (checkpoint !== null) times.checkpoints.push({ at, checkpoint });
    } else if (event.type === "racer_finished") {
      times.finishes.push(at);
    }
  }
  return times;
}

/** Actions and errors (notes are not decisions), oldest first, one per step number. */
function executedSteps(steps: readonly StepRecord[] | undefined): StepRecord[] {
  const seen = new Set<number>();
  const executed: StepRecord[] = [];
  for (const step of steps ?? []) {
    if (!isObject(step) || (step.kind !== "action" && step.kind !== "error")) continue;
    if (!Number.isSafeInteger(step.step) || finiteOrNull(step.actedAt) === null) continue;
    if (seen.has(step.step)) continue;
    seen.add(step.step);
    executed.push(step);
  }
  return executed;
}

/** A step record's decision issue, or null (older records carry none). */
function decisionIssueOf(value: unknown): DecisionIssue | null {
  if (!isObject(value)) return null;
  const malformedAttempts = Math.max(0, Math.floor(finiteOrNull(value.malformedAttempts) ?? 0));
  const fallback = value.fallback === true;
  return malformedAttempts === 0 && !fallback ? null : { malformedAttempts, fallback };
}

/** The step's loop key, as telemetry counts loops: its signature, else its text. */
function signatureOf(step: StepRecord): string | null {
  return textOrNull(step.signature) ?? textOrNull(step.text);
}

function screenshotOf(source: FightDatasetAgent, step: number): string | null {
  const path = isObject(source.screenshots) ? source.screenshots[step] : undefined;
  return typeof path === "string" && path.length > 0 ? path : null;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function deriveRacer(record: FightDatasetRecord, source: FightDatasetAgent): DerivedRacer {
  const racerId = source.racerId;
  const evaluation = record.evaluation.agents.find((agent) => agent.racerId === racerId) ?? null;
  const agent = evaluation?.agent ?? source.agent;
  const windows = hazardWindows(record, racerId);
  const progress = progressTimes(record.events, racerId);
  const steel: DatasetSteelEvent[] = (Array.isArray(source.steelEvents) ? source.steelEvents : [])
    .filter((event) => isObject(event) && finiteOrNull(event.at) !== null)
    .sort((left, right) => left.at - right.at);
  const executed = executedSteps(source.steps);
  const checkpointCount = record.task.checkpointCount;
  const labels = Array.isArray(record.task.checkpointLabels) ? record.task.checkpointLabels : [];

  const steps = executed.map((step, index): DerivedStep => {
    const previous = index > 0 ? executed[index - 1] : undefined;
    const next = executed[index + 1];
    const actedAt = step.actedAt;
    const nextActedAt = next ? next.actedAt : Number.POSITIVE_INFINITY;
    const observedAt = finiteOrNull(step.observedAt);
    const decidedAt = finiteOrNull(step.decidedAt);
    const promptedAt = finiteOrNull(step.promptedAt);
    // Model latency runs from the prompt (after any rate-limit pause); older
    // records only know when the observation was taken.
    const latencyFrom = promptedAt ?? observedAt;
    const rateLimitWaitMs = Math.max(0, finiteOrNull(step.rateLimitWaitMs) ?? 0);
    const decisionIssue = decisionIssueOf(step.decisionIssue);
    // Verified progress recorded between this action and the next one.
    const followed = (at: number) => at >= actedAt && at < nextActedAt;
    const progressed = progress.checkpoints.some((reached) => followed(reached.at));
    const finished = progress.finishes.some(followed);

    const evidence = isObject(step.evidence) ? step.evidence : null;
    const target = evidence && isObject(evidence.target) ? evidence.target : null;
    const decoy = target?.decoy === true;
    const blockedBy = blockedByOf(evidence?.blockedBy);
    const clearedSabotage = evidence?.clearedSabotage === true;
    const error = textOrNull(step.error);
    // What the model was told: recorded by the runner, rebuilt for older records.
    const modelError = textOrNull((step as { modelError?: unknown }).modelError) ??
      (error === null ? null : modelFacingErrorText(error, blockedBy));
    const signature = signatureOf(step);
    // The runner's substitute for a model that gave no usable tool call is a failed step.
    const quality: StepQuality =
      decoy || blockedBy !== null || step.kind === "error" || decisionIssue?.fallback === true
        ? "harmful"
        : progressed || finished || clearedSabotage
          ? "progress"
          : signature !== null && previous !== undefined && signatureOf(previous) === signature
            ? "wasted"
            : "neutral";

    const trap = windowAt(windows, observedAt ?? actedAt);
    const steelFrom = decidedAt ?? actedAt;
    const steelTo = next
      ? finiteOrNull(next.decidedAt) ?? next.actedAt
      : Number.POSITIVE_INFINITY;
    const cleared = new Set(progress.checkpoints
      .filter((reached) => reached.at < actedAt)
      .map((reached) => reached.checkpoint)).size;

    const row: DatasetStep = {
      schemaVersion: DATASET_SCHEMA_VERSION,
      id: `${record.raceId}:${racerId}:${step.step}`,
      raceId: record.raceId,
      racerId,
      step: step.step,
      mode: record.mode,
      agent: { ...agent },
      task: { text: record.task.text, courseId: record.task.courseId, seed: record.task.seed },
      timing: {
        observedAt,
        promptedAt,
        decidedAt,
        actedAt,
        rateLimitWaitMs,
        modelLatencyMs: latencyFrom !== null && decidedAt !== null && decidedAt >= latencyFrom
          ? decidedAt - latencyFrom
          : null,
      },
      progress: {
        checkpoint: cleared,
        checkpointCount,
        nextCheckpointLabel: cleared < checkpointCount ? labels[cleared] ?? null : null,
      },
      observation: isObject(step.observation) ? structuredClone(step.observation) : null,
      screenshot: screenshotOf(source, step.step),
      hazard: trap
        ? {
            stepId: trap.stepId,
            hazardType: trap.hazardType,
            tier: trap.tier,
            appliedAt: trap.appliedAt,
            clearedAt: trap.clearedAt,
          }
        : null,
      action: isObject(step.action) ? { ...step.action } : null,
      reasoning: typeof step.reasoning === "string" && step.reasoning.trim().length > 0
        ? step.reasoning
        : null,
      decisionIssue,
      result: {
        ok: step.kind === "action" && error === null && blockedBy === null,
        error,
        blockedBy,
        decoy,
        navigated: evidence?.navigated === true,
        clearedSabotage,
        progressed,
        finished,
        target: target ? { role: textOrNull(target.role), text: textOrNull(target.text) } : null,
        cursor: evidence && isObject(evidence.cursor) ? { ...evidence.cursor } : null,
      },
      steel: steel
        .filter((event) => event.at >= steelFrom && event.at < steelTo)
        .map((event) => structuredClone(event)),
      labels: {
        quality,
        reaction: trap
          ? evaluation?.sabotage.find((hit) => hit.stepId === trap.stepId)?.reaction ?? null
          : null,
      },
    };
    return { row, trap, modelError };
  });

  return { racerId, agent, evaluation, source, windows, steps };
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

function episodeRow(
  record: FightDatasetRecord,
  agent: AgentEvaluation,
  racer: DerivedRacer | null,
): DatasetEpisode {
  return {
    schemaVersion: DATASET_SCHEMA_VERSION,
    id: `${record.raceId}:${agent.racerId}`,
    raceId: record.raceId,
    racerId: agent.racerId,
    fightNumber: record.fightNumber,
    mode: record.mode,
    title: record.title,
    task: {
      text: record.task.text,
      courseId: record.task.courseId,
      seed: record.task.seed,
      checkpointLabels: [...(record.task.checkpointLabels ?? [])],
    },
    agent: { ...agent.agent },
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    outcome: agent.outcome,
    success: agent.success,
    durationMs: agent.durationMs,
    steps: agent.steps,
    errors: agent.errors,
    loops: agent.loops,
    robustness: agent.robustness,
    sabotage: (agent.sabotage ?? []).map((reaction) => {
      const { evidence: _evidence, ...rest } = reaction;
      return structuredClone(rest);
    }),
    crowd: { ...agent.crowd },
    stepIds: racer ? racer.steps.map(({ row }) => row.id) : [],
    steelTraceFile: typeof racer?.source.steelTraceFile === "string" ? racer.source.steelTraceFile : null,
  };
}

// ---------------------------------------------------------------------------
// Supervised fine-tuning
// ---------------------------------------------------------------------------

/**
 * The observation exactly as the runner hands it to `decide`, keys in the
 * runner's order. A redacted password label stays redacted.
 */
function runtimeObservation(observation: StepObservation): BrowserObservation {
  return {
    url: observation.url ?? "",
    title: observation.title ?? "",
    bodyText: observation.text,
    controls: (observation.controls ?? []).map((control) => ({
      tag: control.tag,
      role: control.role,
      arenaRole: control.arenaRole,
      text: control.label,
      disabled: control.disabled,
      visible: control.visible,
    })),
  };
}

/** The decision as the runner parsed it: canonical keys, without dataset-only fields. */
function runtimeDecision(action: DatasetAction): AgentDecision {
  try {
    return { ...parseDecision(action) };
  } catch {
    // Every recorded action parsed at runtime; one that no longer does (an older
    // record) is passed through as recorded rather than dropped.
    const { textLength: _textLength, ...rest } = action;
    return { ...rest } as AgentDecision;
  }
}

function toolCallId(stepId: string): string {
  return `call_${createHash("sha256").update(stepId).digest("hex").slice(0, 24)}`;
}

/** Steps with an action before `index`, the latest `DATASET_HISTORY_LIMIT` of them. */
function earlierActions(racer: DerivedRacer, index: number): DerivedStep[] {
  return racer.steps
    .slice(0, index)
    .filter(({ row }) => row.action !== null)
    .slice(-DATASET_HISTORY_LIMIT);
}

function sftExamples(record: FightDatasetRecord, racer: DerivedRacer): DatasetSftExample[] {
  const examples: DatasetSftExample[] = [];
  racer.steps.forEach(({ row }, index) => {
    const { quality } = row.labels;
    const { observation, action } = row;
    if ((quality !== "progress" && quality !== "neutral") || !observation || !action) return;
    // Never teach a model to type the redaction marker.
    if (action.type === "type" && action.text === REDACTED_TEXT) return;
    // Only a first-try tool call: never a retry after a malformed payload (its
    // prompt differed) or the runner's substitute action.
    if (row.decisionIssue !== null) return;
    const history = earlierActions(racer, index).map((earlier) => {
      const decision = runtimeDecision(earlier.row.action as DatasetAction);
      // Exactly what the model was shown: the cleaned error (no call log, no hidden
      // decoy markup), never the raw browser error.
      return earlier.modelError === null ? { decision } : { decision, error: earlier.modelError };
    });
    // The runner's own prompt builder, so each example matches runtime byte for byte.
    const userMessage = competitorUserMessage({
      task: record.task.text,
      racerId: racer.racerId,
      observation: runtimeObservation(observation),
      history,
    });
    const toolArguments = {
      ...runtimeDecision(action),
      ...(row.reasoning === null ? {} : { reasoning: row.reasoning }),
    };
    examples.push({
      messages: [
        { role: "system", content: COMPETITOR_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: toolCallId(row.id),
            type: "function",
            function: { name: COMPETITOR_TOOL_NAME, arguments: JSON.stringify(toolArguments) },
          }],
        },
      ],
      metadata: {
        stepId: row.id,
        raceId: record.raceId,
        agentKey: racer.agent.key,
        model: racer.agent.model,
        quality,
        hazardType: row.hazard?.hazardType ?? null,
        mode: record.mode,
      },
    });
  });
  return examples;
}

// ---------------------------------------------------------------------------
// Preference pairs
// ---------------------------------------------------------------------------

/**
 * Per sabotage step, in the order the traps first fired: self-correction
 * pairs (a racer's first harmful step in its window against its first later
 * step that progressed or cleared the trap), then cross-agent pairs (each
 * racer whose first decisive step worked against each whose first failed).
 */
function preferencePairs(
  record: FightDatasetRecord,
  racers: readonly DerivedRacer[],
): DatasetPreference[] {
  const firstFired = new Map<string, number>();
  for (const racer of racers) {
    for (const trap of racer.windows) {
      const first = firstFired.get(trap.stepId);
      if (first === undefined || trap.appliedAt < first) firstFired.set(trap.stepId, trap.appliedAt);
    }
  }
  const traps = [...firstFired.entries()]
    .sort(([leftId, leftAt], [rightId, rightAt]) => leftAt - rightAt || compareText(leftId, rightId))
    .map(([stepId]) => stepId);

  const pairs: DatasetPreference[] = [];
  const addPair = (
    pairType: DatasetPreference["metadata"]["pairType"],
    chosen: RacerStep,
    rejected: RacerStep,
  ): void => {
    const chosenRow = chosen.step.row;
    const rejectedRow = rejected.step.row;
    const trap = rejected.step.trap;
    if (!chosenRow.action || !rejectedRow.action || !trap) return;
    // Both sides must be the models' own first-try tool calls.
    if (chosenRow.decisionIssue !== null || rejectedRow.decisionIssue !== null) return;
    pairs.push({
      id: `${pairType}:${rejectedRow.id}>${chosenRow.id}`,
      prompt: {
        task: record.task.text,
        observation: rejectedRow.observation ? structuredClone(rejectedRow.observation) : null,
        history: earlierActions(rejected.racer, rejected.index)
          .map(({ row }) => ({ ...(row.action as DatasetAction) })),
      },
      chosen: { ...chosenRow.action },
      rejected: { ...rejectedRow.action },
      metadata: {
        pairType,
        raceId: record.raceId,
        sabotageStepId: trap.stepId,
        hazardType: trap.hazardType,
        checkpoint: trap.checkpoint,
        chosenStepId: chosenRow.id,
        rejectedStepId: rejectedRow.id,
        chosenAgent: chosen.racer.agent.key,
        rejectedAgent: rejected.racer.agent.key,
        chosenResult: chosenRow.result.progressed || chosenRow.result.finished ? "progressed" : "cleared",
        rejectedResult: rejectedRow.result.decoy ? "decoy" : rejectedRow.result.blockedBy ?? "error",
        mode: record.mode,
      },
    });
  };

  for (const stepId of traps) {
    const inTrap = racers.map((racer) => racer.steps
      .map((step, index): RacerStep => ({ racer, step, index }))
      .filter(({ step }) => step.trap?.stepId === stepId));

    for (const steps of inTrap) {
      const failed = steps.findIndex(({ step }) => step.row.labels.quality === "harmful");
      if (failed < 0) continue;
      const recovered = steps
        .slice(failed + 1)
        .find(({ step }) => step.row.labels.quality === "progress");
      if (recovered) addPair("self-correction", recovered, steps[failed]);
    }

    const decisive = inTrap
      .map((steps) => steps.find(({ step }) =>
        step.row.labels.quality === "harmful" || step.row.labels.quality === "progress"))
      .filter((entry): entry is RacerStep => entry !== undefined);
    const worked = decisive.filter(({ step }) => step.row.labels.quality === "progress");
    const failedFirst = decisive.filter(({ step }) => step.row.labels.quality === "harmful");
    for (const chosen of worked) {
      for (const rejected of failedFirst) addPair("cross-agent", chosen, rejected);
    }
  }
  return pairs;
}
