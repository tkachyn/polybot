import { describe, expect, it } from "vitest";
import type { FightAgentSummary, FightStatus, FightSummary } from "@contract";
import {
  countByFilter,
  filterFights,
  matchesFightQuery,
  parseFightFilter,
  resolvedNewestFirst,
  totalVolume,
  winnerName,
} from "./filter";

function agent(racerId: string, key: string, name: string): FightAgentSummary {
  return {
    racerId,
    agent: { key, name, provider: "simulated", model: "simulated" },
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
    raceStatus: "running",
    marketStatus: "open",
    title: `Task ${number}`,
    sabotage: null,
    createdAt: 1000 + number,
    startsAt: null,
    startedAt: null,
    freezesAt: null,
    closesAt: null,
    finishedAt: null,
    estimatedResolutionAt: null,
    volume: 10,
    traders: 1,
    checkpointCount: 4,
    leaderCheckpoint: 0,
    agents: [agent("racer-1", "gpt", "GPT-5.2"), agent("racer-2", "claude", "Claude Opus 4.6")],
    winnerRacerId: null,
    voided: false,
    ...overrides,
  };
}

describe("parseFightFilter", () => {
  it("accepts known values and defaults to all", () => {
    expect(parseFightFilter("live")).toBe("live");
    expect(parseFightFilter(" Resolved ")).toBe("resolved");
    expect(parseFightFilter("bogus")).toBe("all");
    expect(parseFightFilter(null)).toBe("all");
  });
});

describe("matchesFightQuery", () => {
  const f = fight(412, "live", { title: "Book the cheapest flight to Lisbon" });
  it("matches everything for an empty query", () => {
    expect(matchesFightQuery(f, "   ")).toBe(true);
  });
  it("matches the title case-insensitively", () => {
    expect(matchesFightQuery(f, "LISBON")).toBe(true);
    expect(matchesFightQuery(f, "paris")).toBe(false);
  });
  it("matches the fight number in any common spelling", () => {
    for (const q of ["412", "0412", "#0412", "#412", "fight 412", "Fight #0412"]) {
      expect(matchesFightQuery(f, q)).toBe(true);
    }
    expect(matchesFightQuery(f, "#0413")).toBe(false);
  });
  it("matches agent names", () => {
    expect(matchesFightQuery(f, "opus")).toBe(true);
  });
});

describe("filterFights / countByFilter", () => {
  const fights = [fight(1, "live"), fight(2, "upcoming"), fight(3, "resolved"), fight(4, "resolved")];
  it("filters by status and query together", () => {
    expect(filterFights(fights, "resolved", "").map((f) => f.number)).toEqual([3, 4]);
    expect(filterFights(fights, "all", "task 2").map((f) => f.number)).toEqual([2]);
    expect(filterFights(fights, "live", "task 2")).toEqual([]);
  });
  it("counts per status", () => {
    expect(countByFilter(fights)).toEqual({ all: 4, live: 1, upcoming: 1, resolved: 2 });
  });
});

describe("resolvedNewestFirst", () => {
  it("keeps only resolved fights, newest finish first", () => {
    const fights = [
      fight(1, "resolved", { finishedAt: 5000 }),
      fight(2, "live"),
      fight(3, "resolved", { finishedAt: 9000 }),
      fight(4, "resolved", { finishedAt: 7000 }),
    ];
    expect(resolvedNewestFirst(fights).map((f) => f.number)).toEqual([3, 4, 1]);
  });
});

describe("totalVolume / winnerName", () => {
  it("sums volume, ignoring non-finite values", () => {
    expect(totalVolume([fight(1, "resolved", { volume: 12.5 }), fight(2, "resolved", { volume: Number.NaN })])).toBe(12.5);
  });
  it("names the winner or returns null", () => {
    expect(winnerName(fight(1, "resolved", { winnerRacerId: "racer-2" }))).toBe("Claude Opus 4.6");
    expect(winnerName(fight(1, "resolved", { voided: true }))).toBeNull();
  });
});
