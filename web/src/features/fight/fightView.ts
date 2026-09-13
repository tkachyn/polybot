/**
 * Pure view helpers for the fight screen. No React.
 */
import type { AgentCheckpointState, FightAgentDetail, FightDetail, RacerPhase, RunStatus } from "@contract";
import type { ProgressMarker } from "../../components";
import { agentVisual, rosterVisuals, type AgentVisual } from "../../lib/agents";
import { EMPTY, formatClock, formatCountdown, formatDuration, formatLogTime, formatNumber } from "../../lib/format";
import { RUN_STATUS_LABEL } from "../../lib/labels";

// ---------------------------------------------------------------------------
// Agent status band
// ---------------------------------------------------------------------------

/** run = ON TASK (green), warn = LOOPING, bad = BLOCKED (terracotta), idle = not started. */
export type AgentTone = RunStatus | "idle";

export type AgentStatusView = { tone: AgentTone; label: string };

/** Status band copy and tone. Terminal and pre-start phases override runStatus. */
export function agentStatusView(agent: { runStatus: RunStatus; phase: RacerPhase }): AgentStatusView {
  switch (agent.phase) {
    // Racers sit in "starting" for the whole pre-fight countdown; the header
    // already says when the fight starts, so the band matches its "Upcoming".
    case "starting":
      return { tone: "idle", label: "Upcoming" };
    case "ready":
      return { tone: "idle", label: "Ready" };
    case "finished":
      return { tone: "run", label: "Finished" };
    case "failed":
      return { tone: "bad", label: "Failed" };
    case "timed_out":
      return { tone: "bad", label: "Timed out" };
    default:
      return { tone: agent.runStatus, label: RUN_STATUS_LABEL[agent.runStatus] };
  }
}

/** "12/40", or "12" when the budget is unknown. */
export function formatStep(step: number, maxSteps: number): string {
  return maxSteps > 0 ? `${formatNumber(step)}/${formatNumber(maxSteps)}` : formatNumber(step);
}

/** ETA copy: "~1m 20s", "Finishing" (awaiting finish), "Done", "—". */
export function formatEta(etaMs: number | null, phase: RacerPhase): string {
  if (phase === "finished") return "Done";
  if (etaMs === null || !Number.isFinite(etaMs)) return EMPTY;
  if (etaMs <= 0) return "Finishing";
  return `~${formatCountdown(etaMs)}`;
}

// ---------------------------------------------------------------------------
// Leader
// ---------------------------------------------------------------------------

export type LeaderView = {
  /** Null until some agent clears a checkpoint. */
  racerId: string | null;
  name: string | null;
  /** Other agents on the same checkpoint. */
  tied: number;
  checkpoint: number;
  checkpointCount: number;
  /** Accessible description, e.g. "GPT-5.2 leads with 2 of 4 checkpoints". */
  title: string;
};

type LeaderAgent = Pick<FightAgentDetail, "racerId" | "agent" | "checkpoint" | "checkpoints">;

/** When `agent` cleared its current checkpoint; unknown sorts last. */
function reachedAt(agent: LeaderAgent): number {
  return agent.checkpoints.find((c) => c.index === agent.checkpoint)?.clearedAt ?? Number.POSITIVE_INFINITY;
}

/**
 * Who leads: the verified winner once there is one, else the agent furthest
 * along, and on a tie the one that reached that checkpoint first.
 */
export function leaderView(fight: Pick<FightDetail, "leaderCheckpoint" | "checkpointCount" | "winnerRacerId"> & { agents: readonly LeaderAgent[] }): LeaderView {
  const { leaderCheckpoint: checkpoint, checkpointCount } = fight;
  const figure = `${formatNumber(checkpoint)} of ${formatNumber(checkpointCount)}`;
  const winner = fight.agents.find((a) => a.racerId === fight.winnerRacerId);
  const front = checkpoint > 0 ? fight.agents.filter((a) => a.checkpoint === checkpoint) : [];
  const lead = winner ?? [...front].sort((a, b) => reachedAt(a) - reachedAt(b))[0];
  if (!lead) {
    return { racerId: null, name: null, tied: 0, checkpoint, checkpointCount, title: `No agent has cleared a checkpoint yet (0 of ${formatNumber(checkpointCount)})` };
  }
  const tied = front.filter((a) => a.racerId !== lead.racerId).length;
  const name = lead.agent.name;
  const title = winner
    ? `${name} won`
    : tied > 0
      ? `${name} leads with ${figure} checkpoints, reached first; ${tied} more on the same checkpoint`
      : `${name} leads with ${figure} checkpoints`;
  return { racerId: lead.racerId, name, tied, checkpoint, checkpointCount, title };
}

// ---------------------------------------------------------------------------
// Clocks
// ---------------------------------------------------------------------------

/** Countdown as m:ss, rounded up to the second: 247_000 → "4:07", 42_000 → "0:42", 3_723_000 → "1:02:03". */
export function formatCountdownClock(remainingMs: number): string {
  if (!Number.isFinite(remainingMs)) return EMPTY;
  const ms = Math.ceil(Math.max(0, remainingMs) / 1000) * 1000;
  return formatClock(ms).replace(/^0(?=\d:)/, "");
}

/** A frame older than this reads as stale in the latency badge. */
export const STALE_FRAME_MS = 15_000;

/** Latency badge copy: "now", "2s ago", "1m 04s ago". */
export function frameAgeLabel(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 1000) return "now";
  return `${formatDuration(ageMs)} ago`;
}

/** When the sabotage fired: fight clock ("02:14") if the start is known, else time of day. */
export function sabotageFiredLabel(firedAt: number, startedAt: number | null): string {
  return startedAt !== null && firedAt >= startedAt ? formatClock(firedAt - startedAt) : formatLogTime(firedAt);
}

// ---------------------------------------------------------------------------
// Market state
// ---------------------------------------------------------------------------

export type MarketTone = "open" | "pre" | "frozen" | "closed";

/** A ticking countdown and its copy, for the header and, shorter, the rail footer. */
export type MarketCountdown = {
  to: number;
  /** Runs to an estimate (the fastest agent's projected finish): "~0:42", then `due` once it passes. */
  approximate: boolean;
  /** Words before the clock in the header, and what replaces both once an estimate is due. */
  lead: string;
  due: string;
  /** The same for the rail footer, which has less room. */
  shortLead: string;
  shortDue: string;
};

export type MarketStateView = {
  tone: MarketTone;
  label: string;
  /** Secondary copy when there is no countdown. */
  detail: string | null;
  countdown: MarketCountdown | null;
};

export type FightEnd = { to: number | null; approximate: boolean };

/**
 * When a live fight ends: the hard stop (`closesAt`), or the fastest agent's
 * projected finish when that comes first.
 */
export function fightEnd(fight: Pick<FightDetail, "closesAt" | "estimatedResolutionAt">): FightEnd {
  const { closesAt, estimatedResolutionAt: estimate } = fight;
  if (estimate !== null && Number.isFinite(estimate) && (closesAt === null || estimate < closesAt)) {
    return { to: estimate, approximate: true };
  }
  return { to: closesAt, approximate: false };
}

type MarketStateInput = Pick<FightDetail, "status" | "marketStatus" | "freezesAt" | "closesAt" | "estimatedResolutionAt">;

export function marketStateView(fight: MarketStateInput): MarketStateView {
  switch (fight.marketStatus) {
    case "open":
      if (fight.status === "upcoming") {
        return { tone: "pre", label: "Pre-fight trading", detail: "Open before the start", countdown: null };
      }
      if (fight.freezesAt === null) return { tone: "open", label: "Open", detail: "Trading open", countdown: null };
      return {
        tone: "open",
        label: "Open",
        detail: null,
        countdown: {
          to: fight.freezesAt,
          approximate: false,
          lead: "Trading freezes in",
          due: "Trading freezes in",
          shortLead: "Open · freezes in",
          shortDue: "Open · freezes in",
        },
      };
    case "frozen": {
      // Trading stops at the freeze but the race does not: say so, and when it
      // ends. An estimate that comes due means the leader is at the finish.
      const end = fightEnd(fight);
      if (end.to === null) return { tone: "frozen", label: "Frozen", detail: "Agents still racing", countdown: null };
      return {
        tone: "frozen",
        label: "Frozen",
        detail: null,
        countdown: {
          to: end.to,
          approximate: end.approximate,
          lead: "Agents racing · ends in",
          due: "Agents racing · leader finishing",
          shortLead: "Frozen · ends in",
          shortDue: "Frozen · leader finishing",
        },
      };
    }
    default:
      return { tone: "closed", label: "Closed", detail: null, countdown: null };
  }
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/**
 * Track dot: green when cleared, slate when pending; the sabotage point is a
 * terracotta ring while pending, filled when it fired on this agent, and a
 * green dot with a terracotta ring when cleared without a hit.
 */
export type CheckpointDot = "cleared" | "pending" | "sabotagePending" | "sabotageFired" | "sabotageCleared";

export function checkpointDot(c: Pick<AgentCheckpointState, "state" | "isSabotage" | "sabotageFired">): CheckpointDot {
  if (c.sabotageFired) return "sabotageFired";
  if (c.isSabotage) return c.state === "cleared" ? "sabotageCleared" : "sabotagePending";
  return c.state === "cleared" ? "cleared" : "pending";
}

/** Progress-bar marker at the sabotage checkpoint (none without a sabotage). */
export function sabotageMarkers(fight: Pick<FightDetail, "sabotage" | "checkpointCount">): ProgressMarker[] {
  const s = fight.sabotage;
  if (!s || fight.checkpointCount <= 0) return [];
  return [{ at: s.checkpoint / fight.checkpointCount, tone: "sabotage", label: `Sabotage fires at ${s.checkpointLabel}` }];
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export type RosterVisuals = ReadonlyMap<string, AgentVisual>;

/** Identity visuals by racerId; colours never collide within the fight. */
export function rosterByRacer(agents: readonly Pick<FightAgentDetail, "racerId" | "agent">[]): Map<string, AgentVisual> {
  const visuals = rosterVisuals(agents.map((a) => a.agent));
  const map = new Map<string, AgentVisual>();
  agents.forEach((a, i) => {
    const visual = visuals[i];
    if (visual) map.set(a.racerId, visual);
  });
  return map;
}

export function visualFor(roster: RosterVisuals, agent: Pick<FightAgentDetail, "racerId" | "agent">): AgentVisual {
  return roster.get(agent.racerId) ?? agentVisual(agent.agent);
}

/** Stable key for memoising roster visuals. */
export function rosterKey(agents: readonly Pick<FightAgentDetail, "racerId" | "agent">[]): string {
  return agents.map((a) => `${a.racerId}:${a.agent.key}:${a.agent.name}`).join("|");
}

/** Rows of the two-column quadrant grid. */
export function gridRows(count: number): number {
  return Math.max(1, Math.ceil(count / 2));
}

/** True when a key event started in a text field (Esc there belongs to the field). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}
