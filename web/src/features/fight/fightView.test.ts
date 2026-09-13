import { describe, expect, it } from "vitest";
import type { AgentCheckpointState, FightAgentDetail } from "@contract";
import {
  agentStatusView,
  checkpointDot,
  formatCountdownClock,
  formatEta,
  formatStep,
  frameAgeLabel,
  gridRows,
  leaderView,
  marketStateView,
  rosterByRacer,
  sabotageFiredLabel,
  sabotageMarkers,
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
  it("covers every market state", () => {
    expect(marketStateView({ status: "live", marketStatus: "open", freezesAt: 99 })).toMatchObject({ tone: "open", countdownTo: 99 });
    expect(marketStateView({ status: "live", marketStatus: "open", freezesAt: null })).toMatchObject({ tone: "open", countdownTo: null });
    expect(marketStateView({ status: "upcoming", marketStatus: "open", freezesAt: 99 })).toMatchObject({ tone: "pre", label: "Pre-fight trading" });
    expect(marketStateView({ status: "live", marketStatus: "frozen", freezesAt: 99 }).tone).toBe("frozen");
    expect(marketStateView({ status: "resolved", marketStatus: "resolved", freezesAt: 99 }).tone).toBe("closed");
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
