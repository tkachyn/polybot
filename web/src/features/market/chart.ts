/**
 * Pure helpers for the win-probability chart: range windows, time ticks and
 * nearest-point lookup. No React, no DOM; unit-tested in chart.test.ts.
 */
import type { PricePoint, Side } from "@contract";

export type ChartRange = "5m" | "1h" | "all";

export const CHART_RANGES: readonly { value: ChartRange; label: string }[] = [
  { value: "5m", label: "5M" },
  { value: "1h", label: "1H" },
  { value: "all", label: "ALL" },
];

/** Range length in ms; null = everything. */
export const RANGE_MS: Readonly<Record<ChartRange, number | null>> = {
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
  all: null,
};

/** The x domain never collapses below this, so 0/1-point series still draw. */
export const MIN_SPAN_MS = 30_000;

/** True when a timestamp can be rendered inside the chart's current window. */
export function isMarkerInWindow(at: number, start: number, end: number): boolean {
  return Number.isFinite(at) && at >= start && at <= end;
}

/** Maps an executed side price onto the chart's YES-probability line. */
export function tradeMarkerChartPrice(side: Side, price: number): number {
  return side === "yes" ? price : 1 - price;
}

export type ChartWindow = {
  start: number;
  end: number;
  /** Oldest first; every t is within [start, end]. */
  points: PricePoint[];
  /** Number of real history points inside the window (excludes synthetic edges). */
  historyCount: number;
};

export type ChartWindowInput = {
  history: readonly PricePoint[];
  range: ChartRange;
  /** Right edge: server-corrected now, or the settle time of a finished fight. */
  end: number;
  /** Live prices appended at `end` so lines reach "now". Null to stop at the last point. */
  current: Record<string, number> | null;
};

/** Index of the first point with t >= `t` (history.length if none). */
export function lowerBound(points: readonly PricePoint[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((points[mid]?.t ?? Infinity) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The visible slice for a range: points with t >= end - range. Prices hold
 * until the next point, so when earlier history exists a synthetic point at
 * the cutoff carries the last price in (lines start at the left edge).
 */
export function buildChartWindow({ history, range, end: endInput, current }: ChartWindowInput): ChartWindow {
  const last = history[history.length - 1];
  const end = last ? Math.max(endInput, last.t) : endInput;
  const rangeMs = RANGE_MS[range];
  const cutoff = rangeMs === null ? -Infinity : end - rangeMs;
  const first = Number.isFinite(cutoff) ? lowerBound(history, cutoff) : 0;
  const points: PricePoint[] = history.slice(first);
  const historyCount = points.length;
  const prior = first > 0 ? history[first - 1] : undefined;
  if (prior && Number.isFinite(cutoff) && (points[0]?.t ?? Infinity) > cutoff) {
    points.unshift({ t: cutoff, prices: prior.prices });
  }
  if (current) {
    const tail = points[points.length - 1];
    if (!tail || tail.t < end) points.push({ t: end, prices: current });
  }
  let start = points[0]?.t ?? end;
  if (Number.isFinite(cutoff)) start = Math.max(start, cutoff);
  if (end - start < MIN_SPAN_MS) start = end - MIN_SPAN_MS;
  return { start, end, points, historyCount };
}

/** Index of the point closest to `t` (-1 for an empty list). */
export function nearestIndex(points: readonly PricePoint[], t: number): number {
  if (points.length === 0) return -1;
  const i = lowerBound(points, t);
  if (i <= 0) return 0;
  if (i >= points.length) return points.length - 1;
  const before = points[i - 1];
  const after = points[i];
  if (!before || !after) return Math.min(i, points.length - 1);
  return t - before.t <= after.t - t ? i - 1 : i;
}

const TICK_STEPS_MS = [
  5_000, 10_000, 15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000,
  2 * 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000,
] as const;
const LARGEST_TICK_STEP_MS = 86_400_000;

export type TimeTicks = { step: number; ticks: number[] };

/**
 * At most `maxTicks` round-time ticks in [start, end], aligned to local
 * clock boundaries (so "14:05", not "14:04:37").
 */
export function timeTicks(start: number, end: number, maxTicks = 4, tzOffsetMs = new Date(end).getTimezoneOffset() * 60_000): TimeTicks {
  const span = Math.max(0, end - start);
  const step: number = TICK_STEPS_MS.find((s) => span / s <= maxTicks) ?? LARGEST_TICK_STEP_MS;
  const ticks: number[] = [];
  if (span === 0 || !Number.isFinite(span)) return { step, ticks };
  // Local time = t - tzOffset; align in local time, convert back.
  let t = Math.ceil((start - tzOffsetMs) / step) * step + tzOffsetMs;
  while (t <= end && ticks.length <= maxTicks) {
    ticks.push(t);
    t += step;
  }
  return { step, ticks };
}

export type PriceDomain = readonly [min: number, max: number];

/**
 * Chooses a readable y-axis window from the prices currently visible in the
 * chart. Low markets stay magnified around 0–25¢; a meaningful move expands
 * the window automatically so the moved line remains visible.
 */
export function buildPriceDomain(values: readonly number[]): PriceDomain {
  const finite = values.filter((value) => Number.isFinite(value)).map((value) => Math.min(1, Math.max(0, value)));
  if (finite.length === 0) return [0, 1];
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const rawSpan = max - min;
  const minimumSpan = max <= 0.25 ? 0.3 : 0.25;
  const paddedSpan = Math.max(minimumSpan, rawSpan * 1.3);
  const center = (min + max) / 2;
  let lower = center - paddedSpan / 2;
  let upper = center + paddedSpan / 2;
  if (lower < 0) {
    upper -= lower;
    lower = 0;
  }
  if (upper > 1) {
    lower -= upper - 1;
    upper = 1;
  }
  return [Math.max(0, lower), Math.min(1, upper)];
}

/** Five evenly spaced y-axis ticks for an adaptive price domain. */
export function priceTicks([min, max]: PriceDomain): number[] {
  return Array.from({ length: 5 }, (_, index) => min + ((max - min) * index) / 4);
}

/** Side-by-side slots for traded amounts floating left of the price dots. */
export const MONEY_SLOTS = 4;

/**
 * The slot for a new traded amount: the first one no amount on screen holds,
 * so amounts shown together never overlap; the oldest one's when all are taken.
 */
export function freeMoneySlot(active: readonly { id: number; slot: number }[]): number {
  const used = new Set(active.map((flash) => flash.slot));
  for (let slot = 0; slot < MONEY_SLOTS; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  return active.reduce((oldest, flash) => (flash.id < oldest.id ? flash : oldest)).slot;
}

export type Scale = (value: number) => number;

export function linearScale(d0: number, d1: number, r0: number, r1: number): Scale {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

export type SeriesPath = {
  /** SVG path data; "" when the series has no points. */
  d: string;
  /** Points drawn. */
  count: number;
  /** Last drawn position (for the end dot). */
  last: { x: number; y: number } | null;
};

/**
 * Path for one racer. A point missing that racer's price breaks the line.
 * Coordinates are rounded to 0.1px to keep the path string small.
 */
export function seriesPath(points: readonly PricePoint[], racerId: string, x: Scale, y: Scale): SeriesPath {
  let d = "";
  let count = 0;
  let pen = false;
  let last: { x: number; y: number } | null = null;
  for (const point of points) {
    const price = point.prices[racerId];
    if (typeof price !== "number" || !Number.isFinite(price)) {
      pen = false;
      continue;
    }
    const px = Math.round(x(point.t) * 10) / 10;
    const py = Math.round(y(Math.min(1, Math.max(0, price))) * 10) / 10;
    d += `${pen ? "L" : "M"}${px},${py}`;
    pen = true;
    count += 1;
    last = { x: px, y: py };
  }
  return { d, count, last };
}
