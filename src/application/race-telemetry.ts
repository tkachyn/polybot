import type {
  ActionLogEntry,
  ActionLogKind,
  BlockedBy,
  CursorPosition,
  EvidenceFrame,
  PricePoint,
  RacerPhase,
  RunStatus,
  TraceEntry,
} from "../api/dto.js";
import { DomainError } from "../domain/errors.js";
import { evidenceFrameKey } from "../evaluation/evaluator.js";
import type { ActionEvidence, AgentActionReport, CapturedFrame } from "./contracts.js";

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

export type RunStatusSignals = Pick<RacerTelemetry, "recentSignatures" | "consecutiveErrors">;

/** Whole-run counters behind the evaluation (the trace itself is bounded). */
export type TraceStats = {
  /** Error reports. */
  errors: number;
  /** Runs of LOOP_SIGNATURE_WINDOW or more identical consecutive signatures, one per run. */
  loops: number;
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
};

/**
 * bad while sabotage is active or the racer is out; warn when the last three
 * action reports share a signature or the last two reports were errors.
 */
export function deriveRunStatus(phase: RacerPhase, telemetry: RunStatusSignals): RunStatus {
  if (phase === "recovering" || phase === "failed" || phase === "timed_out") {
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

function samePrices(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

/** Per-racer spectator telemetry plus per-race chart data. */
export class RaceTelemetry {
  readonly racerIds: readonly string[];

  private readonly racers = new Map<string, RacerTelemetry>();
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
    const text = report.kind === "error" && report.error
      ? `${report.text} (${report.error})`
      : report.text;
    const at = report.at ?? now;

    evidence.trace.push({
      step: Number.isFinite(report.step) && report.step >= 0 ? Math.floor(report.step) : state.step,
      at: Number.isFinite(at) ? at : now,
      kind: report.kind === "error" ? "error" : report.kind === "note" ? "note" : "action",
      text: clampText(text),
      url: state.url,
      ...traceEvidence(report.evidence),
    });
    if (evidence.trace.length > TRACE_LIMIT) {
      evidence.trace.splice(0, evidence.trace.length - TRACE_LIMIT);
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
}
