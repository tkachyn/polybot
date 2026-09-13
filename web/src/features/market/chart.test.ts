import { describe, expect, it } from "vitest";
import type { PricePoint } from "@contract";
import {
  MIN_SPAN_MS,
  MONEY_SLOTS,
  buildChartWindow,
  buildPriceDomain,
  freeMoneySlot,
  isMarkerInWindow,
  linearScale,
  lowerBound,
  nearestIndex,
  seriesPath,
  timeTicks,
  tradeMarkerChartPrice,
} from "./chart";

describe("money flash slots", () => {
  it("gives amounts on screen together different slots", () => {
    expect(freeMoneySlot([])).toBe(0);
    expect(freeMoneySlot([{ id: 1, slot: 0 }])).toBe(1);
    expect(freeMoneySlot([{ id: 1, slot: 1 }])).toBe(0);
    expect(freeMoneySlot([{ id: 1, slot: 0 }, { id: 2, slot: 2 }])).toBe(1);
  });

  it("reuses the oldest slot once every slot is taken", () => {
    const full = Array.from({ length: MONEY_SLOTS }, (_, slot) => ({ id: 10 + ((slot + 1) % MONEY_SLOTS), slot }));
    const oldest = full.reduce((a, b) => (b.id < a.id ? b : a));
    expect(freeMoneySlot(full)).toBe(oldest.slot);
  });
});
const p = (t: number, a: number, b = 1 - a): PricePoint => ({ t, prices: { a, b } });

describe("chart event markers", () => {
  it("keeps sabotage and trade events at the chart boundaries", () => {
    expect(isMarkerInWindow(1_000, 1_000, 2_000)).toBe(true);
    expect(isMarkerInWindow(2_000, 1_000, 2_000)).toBe(true);
    expect(isMarkerInWindow(999, 1_000, 2_000)).toBe(false);
    expect(isMarkerInWindow(Number.NaN, 1_000, 2_000)).toBe(false);
  });

  it("plots both trade sides on the racer's YES-probability line", () => {
    expect(tradeMarkerChartPrice("yes", 0.35)).toBe(0.35);
    expect(tradeMarkerChartPrice("no", 0.35)).toBe(0.65);
  });

  it("zooms low prices instead of reserving the full 0–100¢ axis", () => {
    const domain = buildPriceDomain([0.05, 0.2, 0.25]);
    expect(domain[0]).toBe(0);
    expect(domain[1]).toBe(0.3);
  });

  it("expands the window when a meaningful price move occurs", () => {
    const low = buildPriceDomain([0.05, 0.2, 0.25]);
    const moved = buildPriceDomain([0.05, 0.2, 0.6]);
    expect(moved[1]).toBeGreaterThan(low[1]);
    expect(moved[1] - moved[0]).toBeGreaterThan(low[1] - low[0]);
  });
});

describe("buildChartWindow", () => {
  it("draws a flat span from a single live price when there is no history", () => {
    const w = buildChartWindow({ history: [], range: "all", end: 100_000, current: { a: 0.4, b: 0.6 } });
    expect(w.points).toEqual([{ t: 100_000, prices: { a: 0.4, b: 0.6 } }]);
    expect(w.historyCount).toBe(0);
    expect(w.end - w.start).toBe(MIN_SPAN_MS);
  });

  it("ALL spans the whole history and appends the live point at now", () => {
    const history = [p(0, 0.25), p(60_000, 0.3)];
    const w = buildChartWindow({ history, range: "all", end: 90_000, current: { a: 0.35, b: 0.65 } });
    expect(w.start).toBe(0);
    expect(w.end).toBe(90_000);
    expect(w.points.map((x) => x.t)).toEqual([0, 60_000, 90_000]);
    expect(w.historyCount).toBe(2);
  });

  it("5M keeps t >= now - 5m and carries the prior price in at the cutoff", () => {
    const history = [p(0, 0.1), p(100_000, 0.2), p(400_000, 0.3)];
    const end = 500_000;
    const w = buildChartWindow({ history, range: "5m", end, current: null });
    expect(w.start).toBe(200_000);
    expect(w.points[0]).toEqual({ t: 200_000, prices: { a: 0.2, b: 0.8 } });
    expect(w.points.map((x) => x.t)).toEqual([200_000, 400_000]);
    expect(w.historyCount).toBe(1);
  });

  it("starts at the first point when the history is shorter than the range", () => {
    const history = [p(10_000, 0.5), p(70_000, 0.4)];
    const w = buildChartWindow({ history, range: "1h", end: 80_000, current: null });
    expect(w.start).toBe(10_000);
  });

  it("extends the right edge to the newest point when the local clock lags", () => {
    const w = buildChartWindow({ history: [p(0, 0.5), p(50_000, 0.5)], range: "all", end: 40_000, current: { a: 0.5, b: 0.5 } });
    expect(w.end).toBe(50_000);
    expect(w.points).toHaveLength(2);
  });
});

describe("lookups", () => {
  const pts = [p(0, 0.1), p(10, 0.2), p(20, 0.3)];

  it("lowerBound finds the first t >= value", () => {
    expect(lowerBound(pts, -5)).toBe(0);
    expect(lowerBound(pts, 10)).toBe(1);
    expect(lowerBound(pts, 11)).toBe(2);
    expect(lowerBound(pts, 99)).toBe(3);
  });

  it("nearestIndex snaps to the closest point", () => {
    expect(nearestIndex([], 5)).toBe(-1);
    expect(nearestIndex(pts, -100)).toBe(0);
    expect(nearestIndex(pts, 4)).toBe(0);
    expect(nearestIndex(pts, 6)).toBe(1);
    expect(nearestIndex(pts, 1000)).toBe(2);
  });
});

describe("timeTicks", () => {
  it("chooses a round step and aligns ticks to it", () => {
    const { step, ticks } = timeTicks(61_000, 301_000, 4, 0);
    expect(step).toBe(60_000);
    expect(ticks).toEqual([120_000, 180_000, 240_000, 300_000]);
  });

  it("returns no ticks for an empty span", () => {
    expect(timeTicks(5, 5).ticks).toEqual([]);
  });
});

describe("seriesPath", () => {
  const x = linearScale(0, 100, 0, 100);
  const y = linearScale(0, 1, 100, 0);

  it("moves then draws, and breaks where a racer has no price", () => {
    const pts: PricePoint[] = [
      { t: 0, prices: { a: 0.5 } },
      { t: 50, prices: {} },
      { t: 60, prices: { a: 0.25 } },
      { t: 100, prices: { a: 1 } },
    ];
    const path = seriesPath(pts, "a", x, y);
    expect(path.d).toBe("M0,50M60,75L100,0");
    expect(path.count).toBe(3);
    expect(path.last).toEqual({ x: 100, y: 0 });
  });

  it("is empty for an unknown racer", () => {
    expect(seriesPath([p(0, 0.5)], "zzz", x, y)).toEqual({ d: "", count: 0, last: null });
  });
});
