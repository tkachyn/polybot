import { modelFacingErrorText } from "../agents/playwright-competitor-runner.js";
import type {
  ActionLogEntry,
  ActionLogKind,
  BlockedBy,
  CursorPosition,
  DatasetAction,
  DecisionIssue,
  EvidenceFrame,
  PricePoint,
  RacerPhase,
  RunStatus,
  StepObservation,
  TraceEntry,
} from "../api/dto.js";
import { DomainError } from "../domain/errors.js";
import { evidenceFrameKey } from "../evaluation/evaluator.js";
import type {
  ActionEvidence,
  AgentActionReport,
  CapturedFrame,
  WorkerStateObservation,
} from "./contracts.js";

export const DEFAULT_MAX_STEPS = 60;
export const ACTION_LOG_LIMIT = 60;
export const PRICE_HISTORY_LIMIT = 2_000;
/** warn when this many consecutive action reports share one signature. */
export const LOOP_SIGNATURE_WINDOW = 3;
/** warn when this many consecutive reports were errors. */
export const ERROR_STREAK_WARN = 2;
/** The evaluation trace keeps the latest this many steps per racer. */
export const TRACE_LIMIT = 500;
/** An `after` keyframe is the first frame captured at least this long after a hit. */
export const KEYFRAME_AFTER_MS = 1_500;
/** Safety bound on stored keyframe bodies per racer (two per hit). */
export const KEYFRAME_LIMIT = 24;
/** Step records (the dataset's per-step capture) keep the latest this many steps per racer. */
export const STEP_RECORD_LIMIT = 500;
/** Step-tagged screenshots are kept for the latest this many steps per racer. */
export const STEP_FRAME_LIMIT = 300;
/** A step's reasoning is clipped at this many characters. */
export const REASONING_MAX = 400;
const OBSERVATION_URL_MAX = 2_000;
const OBSERVATION_TITLE_MAX = 300;
const OBSERVATION_TEXT_MAX = 8_000;
const OBSERVATION_CONTROLS_MAX = 100;
const CONTROL_TAG_MAX = 40;
const CONTROL_LABEL_MAX = 300;
const ACTION_FIELD_MAX = 2_000;
const ACTION_TEXT_MAX = 4_000;
const STEP_ERROR_MAX = 2_000;
const SIGNATURE_MAX = 5_000;
const ACTION_TYPES: ReadonlySet<string> = new Set([
  "inspect",
  "click",
  "type",
  "evaluate",
  "navigate",
  "wait",
  "checkpoint",
  "finish",
]);
const LOG_TEXT_MAX = 240;
const TARGET_TEXT_MAX = 120;
const TARGET_ROLE_MAX = 100;
const FRAME_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/svg+xml",
]);
const BLOCKED_BY: ReadonlySet<string> = new Set([
  "modal",
  "disabled",
  "hidden",
  "missing",
  "timeout",
]);

export type StoredFrame = {
  /** Increments with each capture, starting at 1. */
  seq: number;
  capturedAt: number;
  contentType: CapturedFrame["contentType"];
  body: Buffer | string;
};

export type RacerTelemetry = {
  racerId: string;
  url: string | null;
  currentAction: string | null;
  step: number;
  maxSteps: number;
  /** Oldest first, bounded to ACTION_LOG_LIMIT entries. */
  log: ActionLogEntry[];
  /** Last issued log seq; 0 before the first entry. */
  logSeq: number;
  /** Signatures of the latest action/error reports, oldest first. */
  recentSignatures: string[];
  /** Error reports since the last successful action report. */
  consecutiveErrors: number;
  /** Index k - 1 holds when checkpoint k was cleared. */
  checkpointClearedAt: Array<number | null>;
  sabotageHitAt: number | null;
  sabotageHitCheckpoint: number | null;
  recoveredAt: number | null;
  frame: StoredFrame | null;
};

export type StoredWorkerState = WorkerStateObservation;

export type RunStatusSignals = Pick<RacerTelemetry, "recentSignatures" | "consecutiveErrors">;

/** Whole-run counters behind the evaluation (the trace itself is bounded). */
export type TraceStats = {
  /** Error reports. */
  errors: number;
  /** Runs of LOOP_SIGNATURE_WINDOW or more identical consecutive signatures, one per run. */
  loops: number;
};

/**
 * Everything captured for one competitor step, for the dataset export
 * (docs/training-data.md): what the model saw and chose, why, when, and what
 * the browser reported. Built from each action report; text arrives redacted.
 */
export type StepRecord = {
  step: number;
  kind: "action" | "error" | "note";
  /** Report time (after the action). */
  actedAt: number;
  observedAt: number | null;
  /** When the prompt was sent (after any rate-limit pause); null in older records. */
  promptedAt: number | null;
  decidedAt: number | null;
  /** Rate-limit pause before the prompt was sent; 0 when none. */
  rateLimitWaitMs: number;
  url: string | null;
  /** Human description, already redacted. */
  text: string;
  observation: StepObservation | null;
  action: DatasetAction | null;
  reasoning: string | null;
  /** Set when the decision was not one valid tool call on the first try. */
  decisionIssue: DecisionIssue | null;
  /** Full error text, for diagnostics: may include Playwright's call log. */
  error: string | null;
  /**
   * What the model's history holds for this step, for prompts: the failure as
   * it was shown, or the runner's feedback on a step that worked.
   */
  modelError: string | null;
  signature: string | null;
  evidence: {
    target: { role: string | null; text: string | null; decoy: boolean } | null;
    blockedBy: BlockedBy | null;
    navigated: boolean;
    clearedSabotage: boolean;
    cursor: CursorPosition | null;
  };
};

/** Evaluation evidence per racer: the step trace, loop counters and keyframes. */
type RacerEvidence = {
  trace: TraceEntry[];
  errors: number;
  loops: number;
  lastSignature: string | null;
  runLength: number;
  keyframes: Map<string, StoredFrame>;
  /** `after` keyframes still waiting for a frame captured at or after `due`. */
  pendingAfter: Array<{ key: string; due: number }>;
  /** Oldest first, at most STEP_RECORD_LIMIT. */
  steps: StepRecord[];
  /** Step-tagged screenshots by step: the latest STEP_FRAME_LIMIT steps. */
  stepFrames: Map<number, StoredFrame>;
};

/**
 * bad while sabotage is active or the racer is out; warn when the last three
 * action reports share a signature or the last two reports were errors.
 */
export function deriveRunStatus(phase: RacerPhase, telemetry: RunStatusSignals): RunStatus {
  if (phase === "recovering") {
    return "recovering";
  }
  if (phase === "failed" || phase === "timed_out") {
    return "bad";
  }
  const signatures = telemetry.recentSignatures.slice(-LOOP_SIGNATURE_WINDOW);
  const looping = signatures.length === LOOP_SIGNATURE_WINDOW &&
    signatures.every((signature) => signature === signatures[0]);
  if (looping || telemetry.consecutiveErrors >= ERROR_STREAK_WARN) {
    return "warn";
  }
  return "run";
}

function clampText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= LOG_TEXT_MAX ? flat : `${flat.slice(0, LOG_TEXT_MAX - 1)}…`;
}

function cleanEvidenceText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function sanitizeStateText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : "";
  const redacted = text
    .replace(/\b(?:bearer|authorization|api[-_ ]?key|token|password)\b\s*[:=]?\s*\S+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length <= max ? redacted : `${redacted.slice(0, max - 1)}…`;
}

function sanitizeStateUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function sanitizeWorkerState(
  observation: WorkerStateObservation,
  now: number,
): StoredWorkerState {
  return {
    url: sanitizeStateUrl(observation.url),
    title: sanitizeStateText(observation.title, 160),
    bodyText: sanitizeStateText(observation.bodyText, 4_000),
    controls: observation.controls.slice(0, 80).map((control) => ({
      tag: sanitizeStateText(control.tag, 30),
      role: cleanEvidenceText(control.role, TARGET_ROLE_MAX),
      arenaRole: cleanEvidenceText(control.arenaRole, TARGET_ROLE_MAX),
      text: sanitizeStateText(control.text, TARGET_TEXT_MAX),
      disabled: control.disabled === true,
      visible: control.visible === true,
    })),
    at: Number.isFinite(observation.at) ? observation.at : now,
    step: Number.isFinite(observation.step) && observation.step >= 0
      ? Math.floor(observation.step)
      : 0,
    maxSteps: Number.isFinite(observation.maxSteps) && observation.maxSteps >= 0
      ? Math.floor(observation.maxSteps)
      : 0,
    ...(typeof observation.candidateMilestone === "string"
      ? { candidateMilestone: sanitizeStateText(observation.candidateMilestone, 100) }
      : {}),
    ...(typeof observation.navigated === "boolean" ? { navigated: observation.navigated } : {}),
  };
}

/** Browser evidence → the trace's target and block fields. Tolerates junk. */
function traceEvidence(
  evidence: ActionEvidence | undefined,
): Pick<TraceEntry, "targetRole" | "targetText" | "decoy" | "blockedBy"> {
  const record = evidence && typeof evidence === "object" ? evidence : undefined;
  const target = record?.target && typeof record.target === "object" ? record.target : undefined;
  const blockedBy = record?.blockedBy;
  return {
    targetRole: cleanEvidenceText(target?.role, TARGET_ROLE_MAX),
    targetText: cleanEvidenceText(target?.text, TARGET_TEXT_MAX),
    decoy: target?.decoy === true,
    blockedBy: typeof blockedBy === "string" && BLOCKED_BY.has(blockedBy)
      ? blockedBy as BlockedBy
      : null,
  };
}

/** Terminal colour codes, which Playwright puts in its errors. */
const ANSI_COLOUR = /\x1b\[[0-9;]*m/g;

/**
 * A failed step's error as spectators read it: what the model was told
 * (`modelError`: no call log, nothing hidden), else the raw error cleaned the
 * same way, never with colour codes. The raw error stays in the step record.
 */
function readableError(report: AgentActionReport): string | null {
  const told = typeof report.modelError === "string" && report.modelError.trim().length > 0
    ? report.modelError
    : typeof report.error === "string" && report.error.trim().length > 0
      ? modelFacingErrorText(report.error, traceEvidence(report.evidence).blockedBy)
      : null;
  const clean = told?.replace(ANSI_COLOUR, "").replace(/\s+/g, " ").trim() ?? "";
  return clean.length > 0 ? clean : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function stringOrNull(value: unknown, max: number): string | null {
  return typeof value === "string" ? clip(value, max) : null;
}

/** A report's observation, copied and bounded; null when absent or malformed. */
function cleanObservation(value: unknown): StepObservation | null {
  if (!isRecord(value)) return null;
  const controls = Array.isArray(value.controls) ? value.controls : [];
  return {
    url: stringOrNull(value.url, OBSERVATION_URL_MAX),
    title: stringOrNull(value.title, OBSERVATION_TITLE_MAX),
    text: typeof value.text === "string" ? clip(value.text, OBSERVATION_TEXT_MAX) : "",
    controls: controls.slice(0, OBSERVATION_CONTROLS_MAX).filter(isRecord).map((control) => ({
      tag: typeof control.tag === "string" ? clip(control.tag, CONTROL_TAG_MAX) : "",
      role: stringOrNull(control.role, TARGET_ROLE_MAX),
      arenaRole: stringOrNull(control.arenaRole, TARGET_ROLE_MAX),
      label: typeof control.label === "string" ? clip(control.label, CONTROL_LABEL_MAX) : "",
      visible: control.visible === true,
      disabled: control.disabled === true,
    })),
  };
}

/** A reported decision issue, or null when there was none. */
function cleanDecisionIssue(issue: DecisionIssue | undefined): DecisionIssue | null {
  if (!issue || typeof issue !== "object") return null;
  const malformedAttempts = typeof issue.malformedAttempts === "number" &&
    Number.isFinite(issue.malformedAttempts) && issue.malformedAttempts > 0
    ? Math.floor(issue.malformedAttempts)
    : 0;
  const fallback = issue.fallback === true;
  return malformedAttempts === 0 && !fallback ? null : { malformedAttempts, fallback };
}

/** A report's tool call, copied and bounded; null when absent or malformed. */
function cleanAction(value: unknown): DatasetAction | null {
  if (!isRecord(value) || typeof value.type !== "string" || !ACTION_TYPES.has(value.type)) {
    return null;
  }
  const action: DatasetAction = { type: value.type as DatasetAction["type"] };
  if (typeof value.targetRole === "string") action.targetRole = clip(value.targetRole, ACTION_FIELD_MAX);
  if (typeof value.label === "string") action.label = clip(value.label, ACTION_FIELD_MAX);
  if (typeof value.text === "string") action.text = clip(value.text, ACTION_TEXT_MAX);
  const textLength = finiteOrNull(value.textLength);
  if (textLength !== null) action.textLength = textLength;
  if (typeof value.script === "string") action.script = clip(value.script, ACTION_TEXT_MAX);
  if (typeof value.url === "string") action.url = clip(value.url, ACTION_FIELD_MAX);
  const durationMs = finiteOrNull(value.durationMs);
  if (durationMs !== null) action.durationMs = durationMs;
  const checkpoint = finiteOrNull(value.checkpoint);
  if (checkpoint !== null) action.checkpoint = checkpoint;
  return action;
}

function cleanCursor(value: unknown): CursorPosition | null {
  if (!isRecord(value)) return null;
  const x = finiteOrNull(value.x);
  const y = finiteOrNull(value.y);
  const viewportWidth = finiteOrNull(value.viewportWidth);
  const viewportHeight = finiteOrNull(value.viewportHeight);
  const action = value.action;
  if (x === null || y === null || viewportWidth === null || viewportHeight === null ||
    (action !== "click" && action !== "type")) {
    return null;
  }
  return { x, y, viewportWidth, viewportHeight, action };
}

/** Browser evidence → a step record's evidence. Tolerates junk. */
function stepEvidence(evidence: ActionEvidence | undefined): StepRecord["evidence"] {
  const traced = traceEvidence(evidence);
  const record: Record<string, unknown> | undefined = isRecord(evidence) ? evidence : undefined;
  return {
    target: isRecord(record?.target)
      ? { role: traced.targetRole, text: traced.targetText, decoy: traced.decoy }
      : null,
    blockedBy: traced.blockedBy,
    navigated: record?.navigated === true,
    clearedSabotage: record?.clearedSabotage === true,
    cursor: cleanCursor(record?.cursor),
  };
}

function samePrices(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

/** Per-racer spectator telemetry plus per-race chart data. */
export class RaceTelemetry {
  readonly racerIds: readonly string[];

  private readonly racers = new Map<string, RacerTelemetry>();
  private readonly states = new Map<string, StoredWorkerState>();
  private readonly evidence = new Map<string, RacerEvidence>();
  private readonly logLimit: number;
  private readonly priceLimit: number;
  private readonly prices: PricePoint[] = [];
  private opening: Record<string, number> | null = null;
  private keyframeRevisionValue = 0;

  constructor(
    racerIds: readonly string[],
    checkpointCount: number,
    options: { maxSteps?: number; logLimit?: number; priceHistoryLimit?: number } = {},
  ) {
    this.racerIds = [...racerIds];
    this.logLimit = options.logLimit ?? ACTION_LOG_LIMIT;
    this.priceLimit = options.priceHistoryLimit ?? PRICE_HISTORY_LIMIT;
    for (const racerId of racerIds) {
      this.racers.set(racerId, {
        racerId,
        url: null,
        currentAction: null,
        step: 0,
        maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
        log: [],
        logSeq: 0,
        recentSignatures: [],
        consecutiveErrors: 0,
        checkpointClearedAt: Array.from({ length: checkpointCount }, () => null),
        sabotageHitAt: null,
        sabotageHitCheckpoint: null,
        recoveredAt: null,
        frame: null,
      });
      this.evidence.set(racerId, {
        trace: [],
        errors: 0,
        loops: 0,
        lastSignature: null,
        runLength: 0,
        keyframes: new Map(),
        pendingAfter: [],
        steps: [],
        stepFrames: new Map(),
      });
    }
  }

  /** A copy of one racer's telemetry. The frame body is shared, not copied. */
  racer(racerId: string): RacerTelemetry {
    const state = this.state(racerId);
    return {
      ...state,
      log: state.log.map((entry) => ({ ...entry })),
      recentSignatures: [...state.recentSignatures],
      checkpointClearedAt: [...state.checkpointClearedAt],
      frame: state.frame ? { ...state.frame } : null,
    };
  }

  /** Stores only the latest bounded, redacted browser observation per racer. */
  recordState(racerId: string, observation: WorkerStateObservation, now = Date.now()): boolean {
    this.state(racerId);
    const sanitized = sanitizeWorkerState(observation, now);
    const previous = this.states.get(racerId);
    if (previous && JSON.stringify(previous) === JSON.stringify(sanitized)) return false;
    this.states.set(racerId, sanitized);
    return true;
  }

  latestState(racerId: string): StoredWorkerState | null {
    const state = this.states.get(racerId);
    if (!state) return null;
    return {
      ...state,
      controls: state.controls.map((control) => ({ ...control })),
    };
  }

  runStatus(racerId: string, phase: RacerPhase): RunStatus {
    return deriveRunStatus(phase, this.state(racerId));
  }

  appendLog(
    racerId: string,
    entry: { kind: ActionLogKind; text: string; at: number; url?: string | null; cursor?: CursorPosition },
  ): ActionLogEntry {
    const state = this.state(racerId);
    state.logSeq += 1;
    const logged: ActionLogEntry = {
      seq: state.logSeq,
      at: entry.at,
      kind: entry.kind,
      text: clampText(entry.text),
      url: entry.url === undefined ? state.url : entry.url,
      ...(entry.cursor ? { cursor: { ...entry.cursor } } : {}),
    };
    state.log.push(logged);
    state.currentAction = logged.text;
    if (state.log.length > this.logLimit) {
      state.log.splice(0, state.log.length - this.logLimit);
    }
    return { ...logged };
  }

  /**
   * Applies a competitor step: log, step counters, URL and loop signals, plus
   * the evaluation trace (with browser evidence), error and loop counters.
   */
  recordAction(racerId: string, report: AgentActionReport, now: number): ActionLogEntry {
    const state = this.state(racerId);
    if (typeof report?.text !== "string") {
      throw new DomainError("invalid", "action report text is required");
    }
    if (typeof report.url === "string" && report.url.length > 0) {
      state.url = report.url;
    }
    if (Number.isFinite(report.step) && report.step >= 0) {
      state.step = Math.floor(report.step);
    }
    if (Number.isFinite(report.maxSteps) && report.maxSteps > 0) {
      state.maxSteps = Math.floor(report.maxSteps);
    }
    state.currentAction = clampText(report.text);

    const evidence = this.evidenceState(racerId);
    if (report.kind === "action" || report.kind === "error") {
      const signature = report.signature ?? report.text;
      state.recentSignatures.push(signature);
      if (state.recentSignatures.length > LOOP_SIGNATURE_WINDOW) {
        state.recentSignatures.splice(0, state.recentSignatures.length - LOOP_SIGNATURE_WINDOW);
      }
      state.consecutiveErrors = report.kind === "error" ? state.consecutiveErrors + 1 : 0;

      if (signature === evidence.lastSignature) {
        evidence.runLength += 1;
      } else {
        evidence.lastSignature = signature;
        evidence.runLength = 1;
      }
      if (evidence.runLength === LOOP_SIGNATURE_WINDOW) evidence.loops += 1;
      if (report.kind === "error") evidence.errors += 1;
    }

    const kind: ActionLogKind = report.kind === "error"
      ? "error"
      : report.kind === "note"
        ? "status"
        : "action";
    // Spectators read a failure as the model was told it, never Playwright's call log.
    const shownError = report.kind === "error" ? readableError(report) : null;
    const text = shownError === null ? report.text : `${report.text} (${shownError})`;
    const at = report.at ?? now;
    const step = Number.isFinite(report.step) && report.step >= 0 ? Math.floor(report.step) : state.step;
    const actedAt = Number.isFinite(at) ? at : now;
    const stepKind = report.kind === "error" ? "error" : report.kind === "note" ? "note" : "action";
    const reasoning = cleanEvidenceText(report.reasoning, REASONING_MAX);
    const browser = stepEvidence(report.evidence);

    evidence.trace.push({
      step,
      at: actedAt,
      kind: stepKind,
      text: clampText(text),
      url: state.url,
      ...traceEvidence(report.evidence),
      reasoning,
      clearedSabotage: browser.clearedSabotage,
    });
    if (evidence.trace.length > TRACE_LIMIT) {
      evidence.trace.splice(0, evidence.trace.length - TRACE_LIMIT);
    }

    evidence.steps.push({
      step,
      kind: stepKind,
      actedAt,
      observedAt: finiteOrNull(report.observedAt),
      promptedAt: finiteOrNull(report.promptedAt),
      decidedAt: finiteOrNull(report.decidedAt),
      rateLimitWaitMs: Math.max(0, Math.round(finiteOrNull(report.rateLimitWaitMs) ?? 0)),
      url: state.url,
      text: clampText(report.text),
      observation: cleanObservation(report.observation),
      action: cleanAction(report.action),
      reasoning,
      decisionIssue: cleanDecisionIssue(report.decisionIssue),
      // Playwright colours its call log; the record keeps plain text.
      error: typeof report.error === "string" && report.error.length > 0
        ? clip(report.error.replace(ANSI_COLOUR, ""), STEP_ERROR_MAX)
        : null,
      modelError: typeof report.modelError === "string" && report.modelError.length > 0
        ? clip(report.modelError, STEP_ERROR_MAX)
        : null,
      signature: typeof report.signature === "string" ? clip(report.signature, SIGNATURE_MAX) : null,
      evidence: browser,
    });
    if (evidence.steps.length > STEP_RECORD_LIMIT) {
      evidence.steps.splice(0, evidence.steps.length - STEP_RECORD_LIMIT);
    }

    return this.appendLog(racerId, { kind, text, at, cursor: report.evidence?.cursor });
  }

  recordFrame(racerId: string, frame: CapturedFrame, now: number): StoredFrame {
    const state = this.state(racerId);
    if (!frame || !FRAME_CONTENT_TYPES.has(frame.contentType)) {
      throw new DomainError("invalid", "unsupported frame content type");
    }
    if (typeof frame.body !== "string" && !Buffer.isBuffer(frame.body)) {
      throw new DomainError("invalid", "frame body must be a Buffer or string");
    }
    const stored: StoredFrame = {
      seq: (state.frame?.seq ?? 0) + 1,
      capturedAt: frame.capturedAt ?? now,
      contentType: frame.contentType,
      body: frame.body,
    };
    state.frame = stored;

    const evidence = this.evidenceState(racerId);
    if (evidence.pendingAfter.length > 0) {
      evidence.pendingAfter = evidence.pendingAfter.filter((pending) => {
        if (stored.capturedAt < pending.due) return true;
        this.storeKeyframe(evidence, pending.key, stored);
        return false;
      });
    }
    // The screenshot a step's observation was taken with is also kept by step.
    if (typeof frame.step === "number" && Number.isFinite(frame.step) && frame.step >= 0) {
      this.storeStepFrame(evidence, Math.floor(frame.step), stored);
    }
    return { ...stored };
  }

  frame(racerId: string): StoredFrame | null {
    const frame = this.state(racerId).frame;
    return frame ? { ...frame } : null;
  }

  /**
   * A sabotage hit at `at`: keeps the racer's latest frame as
   * `<stepId>-before` and waits for the first frame captured at least
   * KEYFRAME_AFTER_MS later, kept as `<stepId>-after`. At most two bodies per hit.
   */
  captureHitKeyframes(racerId: string, stepId: string, at: number): void {
    const state = this.state(racerId);
    const evidence = this.evidenceState(racerId);
    const before = evidenceFrameKey(stepId, "before");
    const after = evidenceFrameKey(stepId, "after");
    if (state.frame && !evidence.keyframes.has(before)) {
      this.storeKeyframe(evidence, before, state.frame);
    }
    if (!evidence.keyframes.has(after) && !evidence.pendingAfter.some((pending) => pending.key === after)) {
      evidence.pendingAfter.push({ key: after, due: at + KEYFRAME_AFTER_MS });
    }
  }

  /** A stored keyframe with its body, or null. */
  keyframe(racerId: string, key: string): StoredFrame | null {
    const frame = this.evidence.get(racerId)?.keyframes.get(key);
    return frame ? { ...frame } : null;
  }

  /** Keyframe metadata by key. */
  keyframes(racerId: string): Record<string, EvidenceFrame> {
    const frames: Record<string, EvidenceFrame> = {};
    for (const [key, frame] of this.evidenceState(racerId).keyframes) {
      frames[key] = { key, capturedAt: frame.capturedAt, contentType: frame.contentType };
    }
    return frames;
  }

  /** Increments whenever a keyframe body is stored. */
  get keyframeRevision(): number {
    return this.keyframeRevisionValue;
  }

  /** Oldest first, at most TRACE_LIMIT steps. */
  trace(racerId: string): TraceEntry[] {
    return this.evidenceState(racerId).trace.map((entry) => ({ ...entry }));
  }

  traceStats(racerId: string): TraceStats {
    const evidence = this.evidenceState(racerId);
    return { errors: evidence.errors, loops: evidence.loops };
  }

  /** Every step's full capture, oldest first: at most STEP_RECORD_LIMIT copies. */
  stepRecords(racerId: string): StepRecord[] {
    return structuredClone(this.evidence.get(racerId)?.steps ?? []);
  }

  /** The screenshot taken with `step`'s observation, or null. The body is shared. */
  stepFrame(racerId: string, step: number): StoredFrame | null {
    const frame = this.evidence.get(racerId)?.stepFrames.get(step);
    return frame ? { ...frame } : null;
  }

  /** Steps that have a stored screenshot, ascending. */
  stepFrameSteps(racerId: string): number[] {
    const frames = this.evidence.get(racerId)?.stepFrames;
    return frames ? [...frames.keys()].sort((left, right) => left - right) : [];
  }

  markCheckpointCleared(racerId: string, checkpoint: number, at: number): void {
    const state = this.state(racerId);
    const index = checkpoint - 1;
    if (index >= 0 && index < state.checkpointClearedAt.length &&
      state.checkpointClearedAt[index] === null) {
      state.checkpointClearedAt[index] = at;
    }
  }

  markSabotageHit(racerId: string, checkpoint: number | null, at: number): void {
    const state = this.state(racerId);
    state.sabotageHitAt = at;
    state.sabotageHitCheckpoint = checkpoint;
  }

  markRecovered(racerId: string, at: number): void {
    this.state(racerId).recoveredAt = at;
  }

  /**
   * Appends a chart sample. A sample identical to the last one is skipped
   * unless `heartbeat` forces it. Timestamps are kept strictly increasing so
   * clients that append only newer points never drop a sample.
   */
  appendPrice(
    t: number,
    prices: Record<string, number>,
    options: { heartbeat?: boolean } = {},
  ): PricePoint | null {
    const last = this.prices.at(-1);
    if (last && !options.heartbeat && samePrices(last.prices, prices)) {
      return null;
    }
    const point: PricePoint = {
      t: last && t <= last.t ? last.t + 1 : t,
      prices: { ...prices },
    };
    this.prices.push(point);
    if (this.prices.length > this.priceLimit) {
      this.prices.splice(0, this.prices.length - this.priceLimit);
    }
    return { t: point.t, prices: { ...point.prices } };
  }

  /** Oldest first. */
  priceHistory(): PricePoint[] {
    return this.prices.map((point) => ({ t: point.t, prices: { ...point.prices } }));
  }

  lastPricePoint(): PricePoint | null {
    const last = this.prices.at(-1);
    return last ? { t: last.t, prices: { ...last.prices } } : null;
  }

  setOpeningPrices(prices: Record<string, number>): void {
    this.opening = { ...prices };
  }

  openingPrices(): Record<string, number> | null {
    return this.opening ? { ...this.opening } : null;
  }

  private state(racerId: string): RacerTelemetry {
    const state = this.racers.get(racerId);
    if (!state) throw new DomainError("not_found", `Unknown racer: ${racerId}`);
    return state;
  }

  private evidenceState(racerId: string): RacerEvidence {
    const evidence = this.evidence.get(racerId);
    if (!evidence) throw new DomainError("not_found", `Unknown racer: ${racerId}`);
    return evidence;
  }

  private storeKeyframe(evidence: RacerEvidence, key: string, frame: StoredFrame): void {
    if (!evidence.keyframes.has(key) && evidence.keyframes.size >= KEYFRAME_LIMIT) return;
    evidence.keyframes.set(key, { ...frame });
    this.keyframeRevisionValue += 1;
  }

  /** Keeps the latest STEP_FRAME_LIMIT steps; a repeated step replaces its frame. */
  private storeStepFrame(evidence: RacerEvidence, step: number, frame: StoredFrame): void {
    evidence.stepFrames.set(step, { ...frame });
    if (evidence.stepFrames.size > STEP_FRAME_LIMIT) {
      evidence.stepFrames.delete(Math.min(...evidence.stepFrames.keys()));
    }
  }
}
