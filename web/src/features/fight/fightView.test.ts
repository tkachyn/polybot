import { describe, expect, it } from "vitest";
import type { AgentCheckpointState, FightAgentDetail } from "@contract";
import {
  agentStatusView,
  checkpointDot,
  fightEnd,
  finishView,
  formatCountdownClock,
  formatEta,
  formatStep,
  frameAgeLabel,
  gridRows,
  isAgentActive,
  isRaceOver,
  leaderView,
  marketStateView,
  rosterByRacer,
  sabotageFiredLabel,
  sabotageMarkers,
  startsFinishHold,
} from "./fightView";
import { parseLayout } from "./useArenaLayout";

describe("agentStatusView", () => {
  it("maps run statuses to the band copy", () => {
    expect(agentStatusView({ runStatus: "run", phase: "running" })).toEqual({ tone: "run", label: "On task" });
    expect(agentStatusView({ runStatus: "warn", phase: "running" })).toEqual({ tone: "warn", label: "Looping" });
    expect(agentStatusView({ runStatus: "recovering", phase: "recovering" })).toEqual({
      tone: "recovering",
      label: "Recovering from sabotage",
    });
  });

  it("lets terminal and pre-start phases win", () => {
    expect(agentStatusView({ runStatus: "run", phase: "ready" }).tone).toBe("idle");
    expect(agentStatusView({ runStatus: "run", phase: "finished" }).label).toBe("Finished");
    expect(agentStatusView({ runStatus: "bad", phase: "timed_out" })).toEqual({ tone: "bad", label: "Timed out" });
  });

  it("reads Upcoming before the start, matching the header", () => {
    expect(agentStatusView({ runStatus: "run", phase: "starting" })).toEqual({ tone: "idle", label: "Upcoming" });
  });

  it("knows which agents still drive a browser", () => {
    expect(isAgentActive("running")).toBe(true);
    expect(isAgentActive("recovering")).toBe(true);
    expect(isAgentActive("failed")).toBe(false);
    expect(isAgentActive("finished")).toBe(false);
    expect(isAgentActive("timed_out")).toBe(false);
    expect(isAgentActive("ready")).toBe(false);
  });
});

function checkpoints(clearedAt: Array<number | null>): AgentCheckpointState[] {
  return clearedAt.map((at, i) => ({
    index: i + 1,
    label: `Step ${i + 1}`,
    state: at === null ? "pending" : "cleared",
    isSabotage: false,
    sabotageFired: false,
    clearedAt: at,
  }));
}

function racer(racerId: string, name: string, clearedAt: Array<number | null>, finishedAt: number | null = null) {
  return {
    racerId,
    agent: { key: racerId, name, provider: "test", model: "test" },
    checkpoint: clearedAt.filter((at) => at !== null).length,
    checkpoints: checkpoints(clearedAt),
    finishedAt,
  } satisfies Pick<FightAgentDetail, "racerId" | "agent" | "checkpoint" | "checkpoints" | "finishedAt">;
}

describe("leaderView", () => {
  it("names nobody before the first checkpoint", () => {
    const view = leaderView({ leaderCheckpoint: 0, checkpointCount: 4, winnerRacerId: null, agents: [racer("r1", "GPT-5.2", [null, null, null, null])] });
    expect(view).toMatchObject({ racerId: null, name: null, tied: 0, checkpoint: 0, checkpointCount: 4 });
  });

  it("names the agent furthest along", () => {
    const agents = [racer("r1", "GPT-5.2", [10, null, null]), racer("r2", "Grok 4.1", [12, 20, null])];
    expect(leaderView({ leaderCheckpoint: 2, checkpointCount: 3, winnerRacerId: null, agents })).toMatchObject({
      racerId: "r2",
      name: "Grok 4.1",
      tied: 0,
      title: "Grok 4.1 leads with 2 of 3 checkpoints",
    });
  });

  it("breaks a tie by who got there first", () => {
    const agents = [racer("r1", "GPT-5.2", [10, 30, null]), racer("r2", "Grok 4.1", [12, 20, null]), racer("r3", "Gemini 3 Pro", [9, null, null])];
    expect(leaderView({ leaderCheckpoint: 2, checkpointCount: 3, winnerRacerId: null, agents })).toMatchObject({ racerId: "r2", tied: 1 });
  });

  it("prefers the verified winner", () => {
    const agents = [racer("r1", "GPT-5.2", [10, 30, 40]), racer("r2", "Grok 4.1", [12, 20, 35])];
    expect(leaderView({ leaderCheckpoint: 3, checkpointCount: 3, winnerRacerId: "r1", agents })).toMatchObject({ racerId: "r1", title: "GPT-5.2 won" });
  });
});

describe("finish moment", () => {
  it("holds only a fight that resolved while on screen", () => {
    expect(startsFinishHold("live", "resolved")).toBe(true);
    expect(startsFinishHold(null, "resolved")).toBe(false);
    expect(startsFinishHold("upcoming", "resolved")).toBe(false);
    expect(startsFinishHold("live", "live")).toBe(false);
  });

  it("knows when the race has its result", () => {
    expect(isRaceOver({ raceStatus: "finished" })).toBe(true);
    expect(isRaceOver({ raceStatus: "timed_out" })).toBe(true);
    expect(isRaceOver({ raceStatus: "hazards_frozen" })).toBe(false);
  });

  it("describes the winner, or a void", () => {
    const agents = [racer("r1", "GPT-5.2", [10, 30, 40], 45_000), racer("r2", "Grok 4.1", [12, null, null])];
    expect(finishView({ winnerRacerId: "r1", startedAt: 1_000, agents })).toEqual({ kind: "winner", racerId: "r1", name: "GPT-5.2", durationMs: 44_000 });
    expect(finishView({ winnerRacerId: null, startedAt: 1_000, agents })).toEqual({ kind: "void" });
  });
});

describe("figures", () => {
  it("formats countdowns as m:ss, rounding up", () => {
    expect(formatCountdownClock(247_000)).toBe("4:07");
    expect(formatCountdownClock(246_100)).toBe("4:07");
    expect(formatCountdownClock(42_000)).toBe("0:42");
    expect(formatCountdownClock(-5)).toBe("0:00");
    expect(formatCountdownClock(3_723_000)).toBe("1:02:03");
    expect(formatCountdownClock(11 * 60_000)).toBe("11:00");
  });

  it("formats steps and ETAs", () => {
    expect(formatStep(12, 40)).toBe("12/40");
    expect(formatStep(3, 0)).toBe("3");
    expect(formatEta(null, "running")).toBe("—");
    expect(formatEta(0, "running")).toBe("Finishing");
    expect(formatEta(80_000, "running")).toBe("~1m 20s");
    expect(formatEta(80_000, "finished")).toBe("Done");
  });

  it("labels frame latency", () => {
    expect(frameAgeLabel(300)).toBe("now");
    expect(frameAgeLabel(2_400)).toBe("2s ago");
    expect(frameAgeLabel(64_000)).toBe("1m 04s ago");
  });

  it("labels the sabotage time on the fight clock", () => {
    expect(sabotageFiredLabel(1_000 + 134_000, 1_000)).toBe("02:14");
  });

  it("sizes the quadrant grid", () => {
    expect(gridRows(4)).toBe(2);
    expect(gridRows(3)).toBe(2);
    expect(gridRows(0)).toBe(1);
  });
});

describe("marketStateView", () => {
  const times = { freezesAt: 99, closesAt: 199, estimatedResolutionAt: null };

  it("covers every market state", () => {
    expect(marketStateView({ ...times, status: "live", marketStatus: "open" })).toMatchObject({
      tone: "open",
      detail: null,
      countdown: { to: 99, approximate: false, lead: "Trading freezes in", shortLead: "Open · freezes in" },
    });
    expect(marketStateView({ ...times, status: "live", marketStatus: "open", freezesAt: null })).toMatchObject({ tone: "open", detail: "Trading open", countdown: null });
    expect(marketStateView({ ...times, status: "upcoming", marketStatus: "open" })).toMatchObject({ tone: "pre", label: "Pre-fight trading", countdown: null });
    expect(marketStateView({ ...times, status: "live", marketStatus: "frozen" }).tone).toBe("frozen");
    expect(marketStateView({ ...times, status: "resolved", marketStatus: "resolved" })).toMatchObject({ tone: "closed", countdown: null });
  });

  it("says the agents are still racing and counts down to the hard stop while frozen", () => {
    expect(marketStateView({ ...times, status: "live", marketStatus: "frozen" })).toEqual({
      tone: "frozen",
      label: "Frozen",
      detail: null,
      countdown: {
        to: 199,
        approximate: false,
        lead: "Agents racing · ends in",
        due: "Agents racing · leader finishing",
        shortLead: "Frozen · ends in",
        shortDue: "Frozen · leader finishing",
      },
    });
    // The fastest agent's projected finish wins when it is earlier, marked as an estimate.
    expect(marketStateView({ ...times, status: "live", marketStatus: "frozen", estimatedResolutionAt: 150 }).countdown).toMatchObject({
      to: 150,
      approximate: true,
    });
    expect(marketStateView({ ...times, status: "live", marketStatus: "frozen", closesAt: null })).toMatchObject({
      detail: "Agents still racing",
      countdown: null,
    });
  });

  it("ends the fight at the earlier of the hard stop and the estimate", () => {
    expect(fightEnd({ closesAt: 200, estimatedResolutionAt: null })).toEqual({ to: 200, approximate: false });
    expect(fightEnd({ closesAt: 200, estimatedResolutionAt: 120 })).toEqual({ to: 120, approximate: true });
    expect(fightEnd({ closesAt: 200, estimatedResolutionAt: 200 })).toEqual({ to: 200, approximate: false });
    expect(fightEnd({ closesAt: null, estimatedResolutionAt: 120 })).toEqual({ to: 120, approximate: true });
    expect(fightEnd({ closesAt: null, estimatedResolutionAt: null })).toEqual({ to: null, approximate: false });
  });
});

describe("checkpoints", () => {
  it("chooses the dot treatment", () => {
    expect(checkpointDot({ state: "cleared", isSabotage: false, sabotageFired: false })).toBe("cleared");
    expect(checkpointDot({ state: "pending", isSabotage: false, sabotageFired: false })).toBe("pending");
    expect(checkpointDot({ state: "pending", isSabotage: true, sabotageFired: false })).toBe("sabotagePending");
    expect(checkpointDot({ state: "cleared", isSabotage: true, sabotageFired: true })).toBe("sabotageFired");
    expect(checkpointDot({ state: "cleared", isSabotage: true, sabotageFired: false })).toBe("sabotageCleared");
  });

  it("places the sabotage marker", () => {
    const sabotage = { checkpoint: 3, checkpointLabel: "Checkout" } as NonNullable<Parameters<typeof sabotageMarkers>[0]["sabotage"]>;
    expect(sabotageMarkers({ sabotage, checkpointCount: 6 })).toEqual([{ at: 0.5, tone: "sabotage", label: "Sabotage fires at Checkout" }]);
    expect(sabotageMarkers({ sabotage: null, checkpointCount: 6 })).toEqual([]);
  });
});

describe("roster and layout", () => {
  it("keys visuals by racer", () => {
    const map = rosterByRacer([
      { racerId: "racer-1", agent: { key: "gpt", name: "GPT-5.2", provider: "openai", model: "x" } },
      { racerId: "racer-2", agent: { key: "claude", name: "Claude Opus 4.6", provider: "anthropic", model: "x" } },
    ]);
    expect(map.get("racer-1")?.monogram).toBe("GP");
    expect(map.get("racer-2")?.color).toBe("#e8c07a");
  });

  it("parses stored layouts", () => {
    expect(parseLayout("grid")).toBe("grid");
    expect(parseLayout("lanes")).toBe("lanes");
    expect(parseLayout("tiles")).toBeNull();
    expect(parseLayout(null)).toBeNull();
  });
});
