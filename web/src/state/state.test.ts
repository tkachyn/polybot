import { afterEach, describe, expect, it } from "vitest";
import type { PricePoint } from "@contract";
import { failureFromResponse } from "../api/client";
import { backoffMs } from "../lib/backoff";
import { getClockOffset, noteServerTime, resetClock, serverNow } from "./clock";
import { appendPricePoint } from "./fight";
import { createUserId, isValidUserId, sanitizeUserId } from "./userId";

const point = (t: number): PricePoint => ({ t, prices: { "racer-1": 0.25 } });

describe("appendPricePoint", () => {
  it("appends newer points only", () => {
    const h = [point(1), point(2)];
    expect(appendPricePoint(h, point(3)).map((p) => p.t)).toEqual([1, 2, 3]);
    expect(appendPricePoint(h, point(2))).toBe(h);
    expect(appendPricePoint(h, point(1))).toBe(h);
    expect(appendPricePoint([], point(5))).toHaveLength(1);
  });

  it("caps the history", () => {
    const h = [point(1), point(2), point(3)];
    expect(appendPricePoint(h, point(4), 3).map((p) => p.t)).toEqual([2, 3, 4]);
  });
});

describe("server clock", () => {
  afterEach(() => resetClock());

  it("tracks the server offset", () => {
    const local = Date.now();
    noteServerTime(local + 60_000, local, local);
    expect(Math.round(getClockOffset() / 1000)).toBe(60);
    expect(serverNow() - Date.now()).toBeGreaterThan(59_000);
  });
});

describe("user ids", () => {
  it("creates ids that satisfy the server rule", () => {
    for (let i = 0; i < 20; i += 1) expect(isValidUserId(createUserId())).toBe(true);
    expect(isValidUserId("abc")).toBe(false);
    expect(sanitizeUserId("a b$c-d_e")).toBe("abc-d_e");
  });
});

describe("api failures", () => {
  it("maps contract errors and statuses", () => {
    expect(failureFromResponse(400, { error: "Price moved", code: "price_moved" })).toMatchObject({ code: "price_moved", status: 400 });
    expect(failureFromResponse(404, undefined)).toMatchObject({ code: "not_found", status: 404 });
    expect(failureFromResponse(502, "bad gateway")).toMatchObject({ code: "server", status: 502 });
  });
});

describe("backoff", () => {
  it("doubles up to the cap", () => {
    expect([0, 1, 2, 3, 4, 10].map((n) => backoffMs(n))).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
  });
});
