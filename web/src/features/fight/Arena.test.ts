import { createElement, type CSSProperties } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FightAgentDetail, FightDetail } from "@contract";
import { rosterByRacer } from "./fightView";
import { ArenaStage } from "./Arena";

function agent(racerId: string): FightAgentDetail {
  return {
    racerId,
    agent: { key: racerId, name: racerId, provider: "test", model: "test/model" },
    yes: 0.25,
    no: 0.75,
    change: 0,
    openingYes: 0.25,
    runStatus: "run",
    phase: "running",
    checkpoint: 0,
    progress: 0,
    step: 0,
    maxSteps: 20,
    url: null,
    currentAction: null,
    etaMs: null,
    startedAt: 1,
    finishedAt: null,
    sabotageHitAt: null,
    recoveredAt: null,
    checkpoints: [{
      index: 1,
      label: "Checkpoint 1",
      state: "pending",
      isSabotage: false,
      sabotageFired: false,
      clearedAt: null,
    }],
    log: [],
    frame: null,
    browserView: {
      status: "live",
      viewerUrl: `https://viewer.test/${racerId}`,
    },
  };
}

function fight(agents: FightAgentDetail[]): FightDetail {
  return {
    raceId: "race-1",
    number: 1,
    title: "Test fight",
    status: "live",
    raceStatus: "running",
    marketStatus: "open",
    createdAt: 1,
    startedAt: 1,
    startsAt: null,
    freezesAt: 100,
    closesAt: 200,
    finishedAt: null,
    estimatedResolutionAt: null,
    volume: 0,
    traders: 0,
    leaderCheckpoint: 0,
    checkpointCount: 1,
    winnerRacerId: null,
    voided: false,
    task: "Complete the test",
    taskDetail: "Complete the test",
    successCondition: "Verified",
    checkpoints: [{ index: 1, label: "Checkpoint 1", isSabotage: false }],
    sabotage: null,
    agents,
    pricing: { depth: 1_000, logOdds: {} },
  };
}

describe("ArenaStage focus persistence", () => {
  it("keeps the base live viewer iframes mounted under the focus overlay", () => {
    const agents = ["racer-1", "racer-2", "racer-3", "racer-4"].map(agent);
    const current = fight(agents);
    const html = renderToStaticMarkup(createElement(ArenaStage, {
      fight: current,
      roster: rosterByRacer(agents),
      slip: null,
      layout: "grid",
      focused: agents[0]!,
      markers: [],
      rowsStyle: { "--rows": 2 } as CSSProperties,
      laneStyle: { "--rows": 4 } as CSSProperties,
      onOpen: () => undefined,
      onClose: () => undefined,
      buttonRef: () => undefined,
    }));

    // The viewer iframe is created once per racer in the browser, inside the
    // stage's viewer layer, and never moved; SSR renders only its hosts.
    expect((html.match(/<iframe /g) ?? []).length).toBe(0);
    for (const racerId of ["racer-1", "racer-2", "racer-3", "racer-4"]) {
      expect(html).toContain(`data-viewer-url="https://viewer.test/${racerId}"`);
    }
    expect(html).toContain("stageContentHidden");
    expect(html).toContain("focusOverlay");
    expect(html).toContain("viewerLayer");
  });
});
