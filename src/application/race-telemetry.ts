import type {
  ActionLogEntry,
  ActionLogKind,
  PricePoint,
  RacerPhase,
  RunStatus,
} from "../api/dto.js";
import { DomainError } from "../domain/errors.js";
import type { AgentActionReport, CapturedFrame } from "./contracts.js";

export const DEFAULT_MAX_STEPS = 60;
export const ACTION_LOG_LIMIT = 60;
export const PRICE_HISTORY_LIMIT = 2_000;
/** warn when this many consecutive action reports share one signature. */
export const LOOP_SIGNATURE_WINDOW = 3;
/** warn when this many consecutive reports were errors. */
export const ERROR_STREAK_WARN = 2;
const LOG_TEXT_MAX = 240;
const FRAME_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/svg+xml",
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

function samePrices(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

/** Per-racer spectator telemetry plus per-race chart data. */
export class RaceTelemetry {
  readonly racerIds: readonly string[];

  private readonly racers = new Map<string, RacerTelemetry>();
  private readonly logLimit: number;
  private readonly priceLimit: number;
  private readonly prices: PricePoint[] = [];
  private opening: Record<string, number> | null = null;

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
    entry: { kind: ActionLogKind; text: string; at: number; url?: string | null },
  ): ActionLogEntry {
    const state = this.state(racerId);
    state.logSeq += 1;
    const logged: ActionLogEntry = {
      seq: state.logSeq,
      at: entry.at,
      kind: entry.kind,
      text: clampText(entry.text),
      url: entry.url === undefined ? state.url : entry.url,
    };
    state.log.push(logged);
    if (state.log.length > this.logLimit) {
      state.log.splice(0, state.log.length - this.logLimit);
    }
    return { ...logged };
  }

  /** Applies a competitor step: log, step counters, URL and loop signals. */
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

    if (report.kind === "action" || report.kind === "error") {
      state.recentSignatures.push(report.signature ?? report.text);
      if (state.recentSignatures.length > LOOP_SIGNATURE_WINDOW) {
        state.recentSignatures.splice(0, state.recentSignatures.length - LOOP_SIGNATURE_WINDOW);
      }
      state.consecutiveErrors = report.kind === "error" ? state.consecutiveErrors + 1 : 0;
    }

    const kind: ActionLogKind = report.kind === "error"
      ? "error"
      : report.kind === "note"
        ? "status"
        : "action";
    const text = report.kind === "error" && report.error
      ? `${report.text} (${report.error})`
      : report.text;
    return this.appendLog(racerId, { kind, text, at: report.at ?? now });
  }

  recordFrame(racerId: string, frame: CapturedFrame, now: number): StoredFrame {
    const state = this.state(racerId);
    if (!frame || !FRAME_CONTENT_TYPES.has(frame.contentType)) {
      throw new DomainError("invalid", "unsupported frame content type");
    }
    if (typeof frame.body !== "string" && !Buffer.isBuffer(frame.body)) {
      throw new DomainError("invalid", "frame body must be a Buffer or string");
    }
    state.frame = {
      seq: (state.frame?.seq ?? 0) + 1,
      capturedAt: frame.capturedAt ?? now,
      contentType: frame.contentType,
      body: frame.body,
    };
    return { ...state.frame };
  }

  frame(racerId: string): StoredFrame | null {
    const frame = this.state(racerId).frame;
    return frame ? { ...frame } : null;
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
}
