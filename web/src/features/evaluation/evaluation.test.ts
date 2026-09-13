import { describe, expect, it } from "vitest";
import type { ReactionLabel, RobustnessCell, SabotageReaction, SteelTraceEntry, TraceEntry } from "@contract";
import { datasetExportUrl, datasetFileUrl, evidenceFrameUrl, replayUrl } from "../../api/client";
import { EMPTY, MINUS } from "../../lib/format";
import { AGENT_OUTCOME_LABEL, BLOCKED_BY_LABEL, EVALUATION_MODE_LABEL, EVALUATION_STATUS_LABEL, REACTION_DESCRIPTION, REACTION_LABEL } from "../../lib/labels";
import { DATASET_FILES, datasetScope, simulatedDatasetWarning } from "./dataset";
import {
  cellCountsText,
  checkpointParts,
  describeHitOffset,
  evidenceNotes,
  formatCheckpoint,
  formatFightTime,
  formatOffset,
  formatReplayOffset,
  formatRobustness,
  formatScore,
  formatSeconds,
  formatSurvival,
  matrixCellView,
  robustnessView,
  sabotageStepMeta,
  sabotageStepTitle,
} from "./format";
import { matchesSelection, parseEvaluationMode, parseEvaluationWindow } from "./params";
import { EVALUATION_STATUS_TONE, OUTCOME_TONE, REACTION_TONE, TONE_COLOR_VAR } from "./tones";
import { interleaveHits, isTraceStep, steelTraceAround, traceReasoning, traceTotals } from "./trace";

// ---------------------------------------------------------------------------
// Fixtures (tests only)
// ---------------------------------------------------------------------------

const cell = (overrides: Partial<RobustnessCell> = {}): RobustnessCell => ({
  hits: 12,
  immune: 4,
  recovered: 5,
  deceived: 1,
  stalled: 1,
  derailed: 1,
  survivalRate: 10 / 12,
  meanTimeLostMs: 8_200,
  meanScore: 74.4,
  ...overrides,
});

const step = (n: number, at: number, extra: Partial<TraceEntry> = {}): TraceEntry => ({
  step: n,
  at,
  kind: "action",
  text: `step ${n}`,
  url: null,
  targetRole: null,
  targetText: null,
  decoy: false,
  blockedBy: null,
  reasoning: null,
  clearedSabotage: false,
  ...extra,
});

const steel = (at: number, decoy = false): SteelTraceEntry => ({ at, type: "click", label: null, role: null, selector: null, url: null, decoy });

const hit = (stepIndex: number, appliedAt: number, reaction: ReactionLabel = "recovered"): SabotageReaction => ({
  stepId: `step-${stepIndex}`,
  stepIndex,
  label: "Plant a decoy control",
  hazardType: "insert_decoy",
  tier: "basic",
  checkpoint: stepIndex + 1,
  checkpointLabel: `Checkpoint ${stepIndex + 1}`,
  appliedAt,
  expiredAt: null,
  progressedAt: null,
  reaction,
  timeLostMs: 0,
  actionsInWindow: 0,
  errorsInWindow: 0,
  deceived: false,
  firstResponse: null,
  explanation: "",
  score: 100,
  evidence: { before: null, after: null, replayOffsetSec: null },
});

// ---------------------------------------------------------------------------
// Labels and colour
// ---------------------------------------------------------------------------

describe("evaluation labels", () => {
  it("names and defines every reaction", () => {
    expect(REACTION_LABEL).toEqual({
      immune: "Immune",
      recovered: "Recovered",
      deceived: "Deceived",
      stalled: "Stalled",
      derailed: "Derailed",
      cut_short: "Cut short",
    });
    for (const label of Object.keys(REACTION_LABEL) as ReactionLabel[]) expect(REACTION_DESCRIPTION[label].length).toBeGreaterThan(0);
  });

  it("names outcomes, statuses, blockers and modes", () => {
    expect(AGENT_OUTCOME_LABEL).toEqual({ won: "Won", finished: "Finished", failed: "Failed", timed_out: "Timed out", stopped: "Stopped" });
    expect(EVALUATION_STATUS_LABEL).toEqual({ provisional: "Provisional", final: "Final" });
    expect(BLOCKED_BY_LABEL).toEqual({ modal: "Modal", disabled: "Disabled", hidden: "Hidden", missing: "Missing", timeout: "Timeout" });
    expect(EVALUATION_MODE_LABEL).toEqual({ live: "Live", simulated: "Simulated", all: "All" });
  });
});

describe("evaluation colour mapping", () => {
  it("colours reactions with the rationed semantic tones", () => {
    expect(REACTION_TONE).toEqual({
      immune: "positive",
      recovered: "edge",
      deceived: "negative",
      derailed: "negative",
      stalled: "warn",
      cut_short: "muted",
    });
  });

  it("colours outcomes and the report status", () => {
    expect(OUTCOME_TONE).toEqual({ won: "positive", finished: "edge", failed: "negative", timed_out: "warn", stopped: "neutral" });
    expect(EVALUATION_STATUS_TONE).toEqual({ provisional: "edge", final: "neutral" });
  });

  it("resolves every tone to a colour token, never a literal", () => {
    for (const value of Object.values(TONE_COLOR_VAR)) expect(value).toMatch(/^var\(--color-[a-z-]+\)$/);
    expect(TONE_COLOR_VAR.positive).toBe("var(--color-positive)");
    expect(TONE_COLOR_VAR.edge).toBe("var(--color-edge)");
    expect(TONE_COLOR_VAR.negative).toBe("var(--color-negative)");
    // No warning hue exists: warn reads as secondary text, like LOOPING.
    expect(TONE_COLOR_VAR.warn).toBe("var(--color-text-secondary)");
  });
});

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

describe("scores and survival", () => {
  it("rounds scores to whole numbers within 0–100", () => {
    expect(formatScore(74.4)).toBe("74");
    expect(formatScore(74.5)).toBe("75");
    expect(formatScore(100)).toBe("100");
    expect(formatScore(0)).toBe("0");
    expect(formatScore(null)).toBe(EMPTY);
    expect(formatScore(Number.NaN)).toBe(EMPTY);
  });

  it("reads a null robustness as not scored when the agent was hit, not tested when it never was", () => {
    expect(formatRobustness(null)).toBe("Not tested");
    expect(formatRobustness(null, 1)).toBe("Not scored");
    expect(formatRobustness(62.6)).toBe("63");
    expect(formatRobustness(62.6, 2)).toBe("63");
  });

  it("explains a missing robustness: cut-short hits are not scored, an unhit agent is not tested", () => {
    const cut = { ...hit(1, 100, "cut_short"), score: null };
    expect(robustnessView({ robustness: null, sabotage: [cut] })).toEqual({
      text: "Not scored",
      scored: false,
      scoredHits: 0,
      title: "Hit, but cut short: the fight ended too soon after the hit to judge it, so it wasn’t scored.",
    });
    expect(robustnessView({ robustness: null, sabotage: [cut, { ...cut, stepId: "step-2" }] }).title).toMatch(/^Hit 2 times, all cut short/);
    expect(robustnessView({ robustness: null, sabotage: [] })).toEqual({
      text: "Not tested",
      scored: false,
      scoredHits: 0,
      title: "Never hit by sabotage, so robustness was not tested.",
    });
    // A cut-short hit beside a scored one: scored, over the one scored hit.
    expect(robustnessView({ robustness: 80, sabotage: [hit(1, 100), cut] })).toEqual({
      text: "80",
      scored: true,
      scoredHits: 1,
      title: "Mean reaction score over 1 scored hit, 0 to 100.",
    });
  });

  it("formats survival as a whole percent", () => {
    expect(formatSurvival(10 / 12)).toBe("83%");
    expect(formatSurvival(1)).toBe("100%");
    expect(formatSurvival(0)).toBe("0%");
    expect(formatSurvival(null)).toBe(EMPTY);
  });
});

describe("matrix cells", () => {
  it("shows the mean score prominently, survival and hits small, and the counts in the tooltip", () => {
    expect(matrixCellView(cell())).toEqual({
      headline: "74",
      detail: "83% survival · 12 hits",
      tooltip: "12 scored hits: 4 immune, 5 recovered, 1 deceived, 1 stalled, 1 derailed. Mean time lost 8.2s.",
      empty: false,
    });
  });

  it("uses the singular for one hit and leaves out an unknown time lost", () => {
    const one = cell({ hits: 1, immune: 1, recovered: 0, deceived: 0, stalled: 0, derailed: 0, survivalRate: 1, meanTimeLostMs: null, meanScore: 100 });
    expect(matrixCellView(one)).toMatchObject({ headline: "100", detail: "100% survival · 1 hit" });
    expect(cellCountsText(one)).toBe("1 scored hit: 1 immune, 0 recovered, 0 deceived, 0 stalled, 0 derailed.");
  });

  it("marks cells without scored hits as empty", () => {
    expect(matrixCellView(undefined)).toEqual({ headline: EMPTY, detail: "No hits", tooltip: "No scored hits", empty: true });
    expect(matrixCellView(cell({ hits: 0, immune: 0, recovered: 0, deceived: 0, stalled: 0, derailed: 0, survivalRate: null, meanScore: null }))).toMatchObject({
      headline: EMPTY,
      empty: true,
    });
  });
});

describe("time formatting", () => {
  it("formats replay offsets as m:ss", () => {
    expect(formatReplayOffset(0)).toBe("0:00");
    expect(formatReplayOffset(5.9)).toBe("0:05");
    expect(formatReplayOffset(75)).toBe("1:15");
    expect(formatReplayOffset(600)).toBe("10:00");
    expect(formatReplayOffset(3_725)).toBe("1:02:05");
    expect(formatReplayOffset(-3)).toBe("0:00");
    expect(formatReplayOffset(null)).toBe(EMPTY);
    expect(formatReplayOffset(Number.POSITIVE_INFINITY)).toBe(EMPTY);
  });

  it("formats short spans", () => {
    expect(formatSeconds(0)).toBe("0s");
    expect(formatSeconds(3_400)).toBe("3.4s");
    expect(formatSeconds(3_000)).toBe("3s");
    expect(formatSeconds(42_900)).toBe("42s");
    expect(formatSeconds(134_000)).toBe("2m 14s");
    expect(formatSeconds(-50)).toBe("0s");
    expect(formatSeconds(null)).toBe(EMPTY);
  });

  it("signs offsets from the hit", () => {
    expect(formatOffset(-3_200)).toBe(`${MINUS}3.2s`);
    expect(formatOffset(1_500)).toBe("+1.5s");
    expect(formatOffset(20)).toBe("0s");
    expect(describeHitOffset(-800)).toBe("0.8s before the hit");
    expect(describeHitOffset(1_600)).toBe("1.6s after the hit");
    expect(describeHitOffset(0)).toBe("at the hit");
  });

  it("names checkpoints without repeating a default label", () => {
    expect(formatCheckpoint(2, "Checkpoint 2")).toBe("Checkpoint 2");
    expect(formatCheckpoint(3, "Search results")).toBe("Checkpoint 3 · Search results");
    expect(formatCheckpoint(1, "")).toBe("Checkpoint 1");
  });

  it("gives times into the fight", () => {
    expect(formatFightTime(84_000, 1_000)).toBe("01:23");
    expect(formatFightTime(null, 1_000)).toBe(EMPTY);
  });
});

describe("evidence notes", () => {
  it("says why a hit has no replay or Steel trace", () => {
    expect(evidenceNotes({ mode: "simulated", replayAvailable: false, traceAvailable: false })).toEqual([
      "Replays and Steel traces exist for live fights only.",
    ]);
    expect(evidenceNotes({ mode: "live", replayAvailable: true, traceAvailable: true })).toEqual([]);
    expect(evidenceNotes({ mode: "live", replayAvailable: false, traceAvailable: true })).toEqual(["No Steel recording was saved for this session."]);
    expect(evidenceNotes({ mode: "live", replayAvailable: true, traceAvailable: false })).toEqual(["No Steel trace was saved for this session."]);
    expect(evidenceNotes({ mode: "live", replayAvailable: false, traceAvailable: false })).toEqual([
      "No Steel recording or trace was saved for this session.",
    ]);
  });

  it("says what a fight that has left the lobby no longer serves", () => {
    expect(evidenceNotes({ mode: "live", replayAvailable: true, traceAvailable: true, archived: true })).toEqual([
      "Keyframes and the replay aren’t kept once a fight leaves the lobby.",
    ]);
    expect(evidenceNotes({ mode: "simulated", replayAvailable: false, traceAvailable: false, archived: true })).toEqual([
      "Keyframes aren’t kept once a fight leaves the lobby.",
      "Replays and Steel traces exist for live fights only.",
    ]);
  });
});

describe("sabotage step labels", () => {
  it("does not repeat a hazard the step is already named after", () => {
    // A step without a named preset is labelled after its hazard type.
    expect(sabotageStepTitle({ label: "Blocking modal", hazardType: "blocking_modal" })).toEqual({ title: "Blocking modal", hazard: null });
    expect(sabotageStepTitle({ label: "Insert decoy", hazardType: "insert_decoy" })).toEqual({ title: "Insert decoy", hazard: null });
    expect(sabotageStepTitle({ label: "Temporary disable", hazardType: "temporary_disable" })).toEqual({ title: "Temporary disable", hazard: null });
    expect(sabotageStepTitle({ label: "Decoy control", hazardType: "insert_decoy" })).toEqual({ title: "Decoy control", hazard: null });
    // A named preset keeps its hazard; a missing label falls back to the hazard alone.
    expect(sabotageStepTitle({ label: "Plant a decoy control", hazardType: "insert_decoy" })).toEqual({
      title: "Plant a decoy control",
      hazard: "Decoy control",
    });
    expect(sabotageStepTitle({ label: "  ", hazardType: "rename_control" })).toEqual({ title: "Renamed control", hazard: null });
  });

  it("splits the facts under a step into items a line never breaks inside", () => {
    const step = { tier: "difficult" as const, checkpoint: 3, checkpointLabel: "Seat map" };
    expect(sabotageStepMeta({ ...step, label: "Blocking modal", hazardType: "blocking_modal" })).toEqual([
      { text: "Difficult", wrap: false },
      { text: "Checkpoint 3", wrap: false },
      { text: "Seat map", wrap: true },
    ]);
    expect(
      sabotageStepMeta({ ...step, label: "Cover the page with a modal", hazardType: "blocking_modal", checkpointLabel: "Checkpoint 3" }).map((item) => item.text),
    ).toEqual(["Blocking modal", "Difficult", "Checkpoint 3"]);
    expect(checkpointParts(3, "Seat map")).toEqual(["Checkpoint 3", "Seat map"]);
    expect(checkpointParts(2, "checkpoint 2")).toEqual(["Checkpoint 2"]);
  });
});

// ---------------------------------------------------------------------------
// Filters, URLs and traces
// ---------------------------------------------------------------------------

describe("evaluation filters", () => {
  it("parses the mode and the window from the URL", () => {
    expect(parseEvaluationMode("live")).toBe("live");
    expect(parseEvaluationMode(" ALL ")).toBe("all");
    expect(parseEvaluationMode("bogus")).toBeNull();
    expect(parseEvaluationMode(null)).toBeNull();
    expect(parseEvaluationWindow("7")).toBe(7);
    expect(parseEvaluationWindow("90")).toBe(90);
    expect(parseEvaluationWindow("45")).toBe(30);
    expect(parseEvaluationWindow(null)).toBe(30);
  });

  it("shows a matrix response only for the window and mode on screen", () => {
    const simulated30 = { windowDays: 30, mode: "simulated" as const };
    expect(matchesSelection(simulated30, 30, "simulated")).toBe(true);
    // Switched to Live or to 7 days while the old response is still held: not this selection's figures.
    expect(matchesSelection(simulated30, 30, "live")).toBe(false);
    expect(matchesSelection(simulated30, 7, "simulated")).toBe(false);
    // No mode chosen: the server picks one, so its answer matches.
    expect(matchesSelection(simulated30, 30, null)).toBe(true);
    expect(matchesSelection(simulated30, 90, null)).toBe(false);
    expect(matchesSelection({ windowDays: 7, mode: "all" }, 7, "all")).toBe(true);
  });

  it("builds evidence and replay URLs", () => {
    expect(evidenceFrameUrl("race 1", "racer-2", "before/1")).toBe("/api/fights/race%201/agents/racer-2/evidence/before%2F1");
    expect(replayUrl("race-1", "racer-3")).toBe("/api/fights/race-1/agents/racer-3/replay.m3u8");
  });
});

describe("dataset downloads", () => {
  it("builds the zip URL for the page's window and mode", () => {
    expect(datasetExportUrl({ days: 30, mode: "all" })).toBe("/api/datasets/export.zip?days=30&mode=all");
    expect(datasetExportUrl({ days: 7 })).toBe("/api/datasets/export.zip?days=7");
    expect(datasetExportUrl()).toBe("/api/datasets/export.zip");
  });

  it("builds single-file URLs: JSON Lines files, and manifest.json", () => {
    expect(datasetFileUrl("manifest", { days: 90, mode: "live" })).toBe("/api/datasets/manifest.json?days=90&mode=live");
    expect(datasetFileUrl("steps", { days: 30, mode: "simulated" })).toBe("/api/datasets/steps.jsonl?days=30&mode=simulated");
    expect(datasetFileUrl("episodes", { days: 7 })).toBe("/api/datasets/episodes.jsonl?days=7");
    expect(datasetFileUrl("sft")).toBe("/api/datasets/sft.jsonl");
    expect(datasetFileUrl("preferences", { mode: "all" })).toBe("/api/datasets/preferences.jsonl?mode=all");
  });

  it("describes every file once, in one line, under the name it downloads as", () => {
    expect(DATASET_FILES.map((f) => f.file)).toEqual(["steps", "episodes", "sft", "preferences", "manifest"]);
    for (const { file, name, description } of DATASET_FILES) {
      expect(datasetFileUrl(file)).toBe(`/api/datasets/${name}`);
      expect(description.trim().length).toBeGreaterThan(0);
      expect(description).not.toMatch(/\n/);
    }
  });

  it("disables the downloads only when the window is known to hold no fight", () => {
    expect(datasetScope(0)).toEqual({ empty: true, summary: "No fights in this window" });
    expect(datasetScope(1)).toEqual({ empty: false, summary: "1 fight · 4 episodes" });
    expect(datasetScope(1_250)).toEqual({ empty: false, summary: "1,250 fights · 5,000 episodes" });
    // Unknown (loading, or the matrix failed): keep the downloads, say nothing.
    expect(datasetScope(null)).toEqual({ empty: false, summary: null });
  });

  it("warns against training on simulated rows whenever the download includes them", () => {
    expect(simulatedDatasetWarning("live")).toBeNull();
    expect(simulatedDatasetWarning(null)).toBeNull();
    for (const mode of ["simulated", "all"] as const) {
      expect(simulatedDatasetWarning(mode)).toMatch(/scripted agents, not real models, and shouldn’t be used for training/);
    }
    expect(simulatedDatasetWarning("all")).toMatch(/filter them out/);
  });
});

describe("trace helpers", () => {
  it("keeps Steel events within ten seconds of the hit", () => {
    const trace = [steel(0), steel(5_000), steel(15_000, true), steel(25_000), steel(25_001)];
    expect(steelTraceAround(trace, 15_000).map((e) => e.at)).toEqual([5_000, 15_000, 25_000]);
  });

  it("marks each hit before the first step taken at or after it", () => {
    const rows = interleaveHits([step(1, 100), step(2, 200), step(3, 300)], [hit(2, 250), hit(1, 150), hit(3, 900)]);
    expect(rows.map((r) => (r.kind === "hit" ? `hit${r.reaction.stepIndex}` : `s${r.entry.step}`))).toEqual(["s1", "hit1", "s2", "hit2", "s3", "hit3"]);
  });

  it("counts errors, decoy clicks, blocked steps and cleared sabotage", () => {
    const trace = [step(1, 1, { kind: "error", blockedBy: "modal" }), step(2, 2, { decoy: true }), step(3, 3, { clearedSabotage: true }), step(4, 4)];
    expect(traceTotals(trace)).toEqual({ steps: 4, notes: 0, errors: 1, decoys: 1, blocked: 1, cleared: 1 });
  });

  it("counts steps the way the agent's step count does: notes are not steps", () => {
    // The runner's step-0 page load and a rate-limit pause are logged, not taken: 3 steps, as in "Steps 3/90".
    const trace = [
      step(0, 0, { kind: "note", text: "open https://shop.arena.test/" }),
      step(1, 1),
      step(2, 2, { kind: "error" }),
      step(2, 3, { kind: "note", text: "paused for the rate limit" }),
      step(3, 4),
    ];
    expect(traceTotals(trace)).toMatchObject({ steps: 3, notes: 2, errors: 1 });
    expect(trace.filter(isTraceStep).map((entry) => entry.step)).toEqual([1, 2, 3]);
  });

  it("reads the model's reasoning, trimmed, or null when it gave none", () => {
    expect(traceReasoning(step(1, 1, { reasoning: "  Two primary buttons; the task needs Add to cart.\n" }))).toBe("Two primary buttons; the task needs Add to cart.");
    expect(traceReasoning(step(2, 2))).toBeNull();
    expect(traceReasoning(step(3, 3, { reasoning: "   " }))).toBeNull();
  });
});
