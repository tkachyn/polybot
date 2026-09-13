import { describe, expect, it } from "vitest";
import type { FightAgentSummary, FightStatus, FightSummary } from "@contract";
import { FEATURED_INTRO_WINDOW_MS, FEATURED_RESULT_HOLD_MS, bestFeaturedCandidate, nextIntroWindowAt, pickFeatured } from "./featured";

const NOW = 1_800_000_000_000;

function agent(racerId: string, name: string): FightAgentSummary {
  return {
    racerId,
    agent: { key: racerId, name, provider: "simulated", model: "simulated" },
    yes: 0.25,
    no: 0.75,
    change: 0,
    checkpoint: 0,
    runStatus: "run",
    phase: "running",
  };
}

function fight(number: number, status: FightStatus, overrides: Partial<FightSummary> = {}): FightSummary {
  return {
    raceId: `race-${number}`,
    number,
    status,
    raceStatus: status === "live" ? "running" : status === "upcoming" ? "starting" : "finished",
    marketStatus: status === "resolved" ? "resolved" : "open",
    title: `Task ${number}`,
    sabotage: null,
    createdAt: NOW - 600_000 + number,
    // A minute out: an ordinary upcoming fight, not yet inside its intro window.
    startsAt: status === "upcoming" ? NOW + 60_000 + number * 1000 : null,
    startedAt: status === "live" ? NOW - 60_000 : status === "resolved" ? NOW - 400_000 : null,
    freezesAt: null,
    closesAt: null,
    finishedAt: status === "resolved" ? NOW - 200_000 + number : null,
    estimatedResolutionAt: null,
    volume: 100,
    traders: 3,
    checkpointCount: 4,
    leaderCheckpoint: 0,
    agents: [agent("racer-1", "GPT-5.2"), agent("racer-2", "Claude Opus 4.6")],
    winnerRacerId: status === "resolved" ? "racer-1" : null,
    voided: false,
    ...overrides,
  };
}

describe("bestFeaturedCandidate", () => {
  it("prefers the open live fight with the most volume", () => {
    const fights = [
      fight(10, "live", { volume: 0, startedAt: NOW - 5_000 }),
      fight(8, "live", { volume: 1_400, startedAt: NOW - 90_000 }),
      fight(9, "live", { volume: 900, startedAt: NOW - 60_000 }),
    ];
    expect(bestFeaturedCandidate(fights)?.number).toBe(8);
  });

  it("breaks volume ties by the earlier start, then the lower number", () => {
    expect(
      bestFeaturedCandidate([fight(5, "live", { startedAt: NOW - 1_000 }), fight(6, "live", { startedAt: NOW - 9_000 })])
        ?.number,
    ).toBe(6);
    expect(bestFeaturedCandidate([fight(7, "live"), fight(3, "live")])?.number).toBe(3);
  });

  it("prefers open trading over a frozen fight, but features a frozen one over none", () => {
    const frozen = fight(4, "live", { marketStatus: "frozen", raceStatus: "hazards_frozen", volume: 5_000 });
    expect(bestFeaturedCandidate([frozen, fight(5, "live", { volume: 10 })])?.number).toBe(5);
    expect(bestFeaturedCandidate([frozen, fight(3, "resolved")])?.number).toBe(4);
  });

  it("falls back to the soonest upcoming fight, then the newest resolved one", () => {
    expect(bestFeaturedCandidate([fight(12, "upcoming"), fight(11, "upcoming"), fight(3, "resolved")])?.number).toBe(11);
    expect(
      bestFeaturedCandidate([
        fight(2, "resolved", { finishedAt: NOW - 50_000 }),
        fight(3, "resolved", { finishedAt: NOW - 10_000 }),
      ])?.number,
    ).toBe(3);
    expect(bestFeaturedCandidate([])).toBeNull();
  });
});

describe("pickFeatured", () => {
  it("keeps the current fight while it is live, whatever else starts", () => {
    const watched = fight(428, "live", { volume: 300 });
    // A newer, busier fight starts: the featured card does not move.
    const lobby = [fight(432, "live", { volume: 9_000, startedAt: NOW }), watched];
    expect(pickFeatured(lobby, watched.raceId, NOW)?.number).toBe(428);
  });

  it("keeps the current fight once its trading freezes", () => {
    const frozen = fight(435, "live", { marketStatus: "frozen", raceStatus: "hazards_frozen" });
    expect(pickFeatured([fight(440, "live", { volume: 5_000 }), frozen], frozen.raceId, NOW)?.number).toBe(435);
  });

  it("never swaps across a run of lobby updates while the fight runs", () => {
    let current: string | null = null;
    const seen: number[] = [];
    const updates = [
      [fight(428, "live", { volume: 1_400 }), fight(429, "live", { volume: 200 })],
      [fight(432, "live", { volume: 0, startedAt: NOW }), fight(428, "live", { volume: 1_500 }), fight(429, "live")],
      [fight(434, "live", { volume: 0 }), fight(432, "live", { volume: 2_000 }), fight(428, "live", { marketStatus: "frozen" })],
    ];
    for (const lobby of updates) {
      const featured = pickFeatured(lobby, current, NOW);
      current = featured?.raceId ?? null;
      seen.push(featured?.number ?? 0);
    }
    expect(seen).toEqual([428, 428, 428]);
  });

  it("holds a just-resolved fight so its result can be read, then moves on", () => {
    const done = fight(428, "resolved", { finishedAt: NOW - 5_000 });
    const lobby = [fight(430, "live", { volume: 50 }), fight(431, "live", { volume: 900 }), done];
    expect(pickFeatured(lobby, done.raceId, NOW)?.number).toBe(428);
    const later = NOW - 5_000 + FEATURED_RESULT_HOLD_MS;
    expect(pickFeatured(lobby, done.raceId, later)?.number).toBe(431);
  });

  it("picks by the rule when the current fight is gone", () => {
    const lobby = [fight(430, "live", { volume: 50 }), fight(431, "live", { volume: 900 })];
    expect(pickFeatured(lobby, "race-999", NOW)?.number).toBe(431);
    expect(pickFeatured(lobby, null, NOW)?.number).toBe(431);
  });

  it("lets an upcoming fallback give way to a live fight, and keeps it otherwise", () => {
    const next = fight(20, "upcoming");
    expect(pickFeatured([fight(21, "upcoming", { startsAt: NOW + 30_000 }), next], next.raceId, NOW)?.number).toBe(20);
    expect(pickFeatured([fight(19, "live"), next], next.raceId, NOW)?.number).toBe(19);
    // The fallback itself going live keeps it.
    expect(pickFeatured([fight(20, "live"), fight(19, "live", { volume: 9_000 })], next.raceId, NOW)?.number).toBe(20);
  });

  it("lets a resolved fallback give way to anything still to come", () => {
    const old = fight(3, "resolved", { finishedAt: NOW - 600_000 });
    expect(pickFeatured([fight(4, "upcoming"), old], old.raceId, NOW)?.number).toBe(4);
    expect(pickFeatured([fight(5, "resolved", { finishedAt: NOW - 1_000_000 }), old], old.raceId, NOW)?.number).toBe(3);
  });
});

describe("the intro window", () => {
  it("hands the card to a fight about to start, unless a live fight holds it", () => {
    const starting = fight(9, "upcoming", { startsAt: NOW + 8_000 });
    const later = fight(3, "upcoming");
    const justResolved = fight(4, "resolved", { finishedAt: NOW - 1_000 });
    // Over a result still on hold, a later upcoming fallback, and a live fight no one is featuring yet.
    expect(pickFeatured([justResolved, starting, later], justResolved.raceId, NOW)?.number).toBe(9);
    expect(pickFeatured([later, starting], later.raceId, NOW)?.number).toBe(9);
    expect(pickFeatured([fight(5, "live"), starting], null, NOW)?.number).toBe(9);
    // Never over the live fight on the card.
    expect(pickFeatured([fight(5, "live"), starting], "race-5", NOW)?.number).toBe(5);
    // Kept through the moment between its start time and going live.
    expect(pickFeatured([fight(5, "live"), { ...starting, startsAt: NOW - 500 }], starting.raceId, NOW)?.number).toBe(9);
    // Outside the window it is an ordinary upcoming fight.
    expect(pickFeatured([fight(5, "live"), { ...starting, startsAt: NOW + FEATURED_INTRO_WINDOW_MS + 1 }], null, NOW)?.number).toBe(5);
  });

  it("wakes when the next fight comes inside its window", () => {
    expect(nextIntroWindowAt([fight(3, "upcoming"), fight(2, "resolved")], NOW)).toBe(NOW + 63_000 - FEATURED_INTRO_WINDOW_MS);
    // Already inside, or no start time yet: nothing to wait for.
    expect(nextIntroWindowAt([fight(3, "upcoming", { startsAt: NOW + 5_000 })], NOW)).toBeNull();
    expect(nextIntroWindowAt([fight(3, "upcoming", { startsAt: null })], NOW)).toBeNull();
  });
});
