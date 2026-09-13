import { describe, expect, it } from "vitest";
import type { FightAgentSummary, FightStatus, FightSummary } from "@contract";
import { ALL_VIEW_RESOLVED_LIMIT, buildLobby, buildRail } from "./lobby";

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
    startsAt: status === "upcoming" ? NOW + number * 1000 : null,
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

const numbers = (fights: readonly FightSummary[]) => fights.map((f) => f.number);

describe("buildLobby", () => {
  const featured = fight(428, "live", { volume: 1_400 });
  const frozen = fight(425, "live", { marketStatus: "frozen", raceStatus: "hazards_frozen" });
  const fights = [
    fight(432, "live"),
    fight(430, "live"),
    featured,
    frozen,
    fight(433, "upcoming"),
    fight(434, "upcoming"),
    ...Array.from({ length: 7 }, (_, i) => fight(410 + i, "resolved")),
  ];
  const base = { fights, featured, filter: "all" as const, query: "" };

  it("lists every live and frozen fight besides the featured one", () => {
    const lobby = buildLobby(base);
    expect(lobby.hero?.number).toBe(428);
    const live = lobby.sections.find((s) => s.status === "live")!;
    expect(numbers(live.fights)).toEqual([432, 430, 425]);
    // Together, the featured card and the live section cover every live fight.
    const onScreen = numbers([lobby.hero!, ...live.fights]).sort();
    expect(onScreen).toEqual(numbers(fights.filter((f) => f.status === "live")).sort());
  });

  it("shows live, upcoming and the latest resolved fights in the All view", () => {
    const lobby = buildLobby(base);
    expect(lobby.sections.map((s) => s.status)).toEqual(["live", "upcoming", "resolved"]);
    expect(numbers(lobby.sections[1]!.fights)).toEqual([433, 434]);
    const resolved = lobby.sections[2]!;
    expect(resolved.fights).toHaveLength(ALL_VIEW_RESOLVED_LIMIT);
    expect(resolved.total).toBe(7);
    expect(resolved.fights[0]!.number).toBe(416);
  });

  it("leaves the upcoming section empty when nothing is scheduled", () => {
    const lobby = buildLobby({ ...base, fights: fights.filter((f) => f.status !== "upcoming") });
    const upcoming = lobby.sections.find((s) => s.status === "upcoming")!;
    expect(upcoming.fights).toEqual([]);
    expect(upcoming.total).toBe(0);
  });

  it("filters to one status", () => {
    const live = buildLobby({ ...base, filter: "live" });
    expect(live.hero?.number).toBe(428);
    expect(live.sections.map((s) => s.status)).toEqual(["live"]);

    const upcoming = buildLobby({ ...base, filter: "upcoming" });
    expect(upcoming.hero).toBeNull();
    expect(upcoming.sections.map((s) => s.status)).toEqual(["upcoming"]);

    const resolved = buildLobby({ ...base, filter: "resolved" });
    expect(resolved.hero).toBeNull();
    expect(resolved.sections[0]!.fights).toHaveLength(7);
  });

  it("counts fights per filter", () => {
    expect(buildLobby(base).counts).toEqual({ all: 13, live: 4, upcoming: 2, resolved: 7 });
  });

  it("narrows everything to the search, the featured card included", () => {
    const hit = buildLobby({ ...base, query: "task 433" });
    expect(hit.hero).toBeNull();
    expect(hit.sections.flatMap((s) => numbers(s.fights))).toEqual([433]);
    expect(hit.counts).toEqual({ all: 1, live: 0, upcoming: 1, resolved: 0 });
    expect(buildLobby({ ...base, query: "#0428" }).hero?.number).toBe(428);
  });

  it("lists the featured fight as a card when it doesn't belong in the view", () => {
    const upcomingHero = fight(433, "upcoming");
    const lobby = buildLobby({ ...base, featured: upcomingHero, filter: "live" });
    expect(lobby.hero).toBeNull();
    expect(numbers(lobby.sections[0]!.fights)).toContain(428);
  });
});

describe("buildRail", () => {
  it("has nothing to show while the lobby loads", () => {
    expect(buildRail({ fights: [], loaded: false })).toEqual({ upcoming: null, resolved: null });
  });

  it("lists upcoming fights, and resolved ones newest first", () => {
    const rail = buildRail({
      fights: [
        fight(9, "upcoming"),
        fight(3, "resolved", { finishedAt: NOW - 9_000 }),
        fight(4, "resolved", { finishedAt: NOW - 1_000 }),
      ],
      loaded: true,
    });
    expect(numbers(rail.upcoming!)).toEqual([9]);
    expect(numbers(rail.resolved!)).toEqual([4, 3]);
  });

  it("shows empty lists, not sample fights, when there is nothing of a kind", () => {
    expect(buildRail({ fights: [fight(5, "live")], loaded: true })).toEqual({ upcoming: [], resolved: [] });
  });
});
