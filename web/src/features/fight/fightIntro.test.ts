import { describe, expect, it } from "vitest";
import { introOpensIn, introStartOffset } from "./fightIntroState";

describe("fight intro", () => {
  it("starts its length plus the margin before an upcoming fight starts", () => {
    const upcoming = { status: "upcoming" as const, startsAt: 20_000 };
    // 9.4 s of video ending 0.5 s before the start.
    expect(introOpensIn(upcoming, 5_000)).toBe(5_100);
    // Already inside the lead: start now.
    expect(introOpensIn(upcoming, 12_000)).toBe(0);
    // Nothing to lead into: started, live, or no start time yet.
    expect(introOpensIn(upcoming, 20_000)).toBeNull();
    expect(introOpensIn({ status: "live", startsAt: 20_000 }, 12_000)).toBeNull();
    expect(introOpensIn({ status: "upcoming", startsAt: null }, 5_000)).toBeNull();
  });

  it("starts part-way in when the fight starts sooner than the intro runs", () => {
    expect(introStartOffset(20_000, 12_000, 9.4)).toBeCloseTo(1.4);
    expect(introStartOffset(20_000, 5_000, 9.4)).toBe(0);
    expect(introStartOffset(20_000, 12_000, Number.NaN)).toBe(0);
  });
});
