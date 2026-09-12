/**
 * Hardcoded lobby cards for the demo. Only the featured fight (the first
 * fight from the backend) is real; these fill the list beneath it so the
 * lobby reads like a busy market. They are never fetched, traded or opened.
 *
 * Times are relative to `now` so clocks and countdowns read naturally for
 * the length of a demo. Fight numbers sit around the featured fight's
 * number and never collide with it.
 */
import type { AgentIdentity, FightAgentSummary, FightStatus, FightSummary, SabotageSummary } from "@contract";

const ROSTER: readonly AgentIdentity[] = [
  { key: "gpt", name: "GPT-5.2", provider: "openai", model: "gpt-5.2" },
  { key: "claude", name: "Claude Opus 4.6", provider: "anthropic", model: "claude-opus-4-6" },
  { key: "gemini", name: "Gemini 3 Pro", provider: "google", model: "gemini-3-pro" },
  { key: "grok", name: "Grok 4.1", provider: "xai", model: "grok-4.1" },
];

type Quad = readonly [number, number, number, number];

type PlaceholderTemplate = {
  status: FightStatus;
  title: string;
  sabotage: string;
  sabotageCheckpoint: number;
  checkpointLabel: string;
  checkpointCount: number;
  /** YES prices in racer order; they sum to 1. */
  prices: Quad;
  changes: Quad;
  checkpoints: Quad;
  volume: number;
  traders: number;
  /** live: started this long ago; upcoming: starts in; resolved: finished this long ago. */
  offsetMs: number;
  /** Resolved fights: how long the race ran. */
  durationMs?: number;
  fired?: boolean;
  /** Racer index shown as BLOCKED (sabotage active). */
  blocked?: number;
  /** Resolved fights: winning racer index. Omit for a voided fight. */
  winner?: number;
};

const MINUTE = 60_000;
/** The handoff's 30-minute cap; trading freezes 5 minutes before it. */
const CAP_MS = 30 * MINUTE;
const FREEZE_MS = 25 * MINUTE;

/** Order matches the backend lobby sort: live, then upcoming, then resolved. */
export const PLACEHOLDER_TEMPLATES: readonly PlaceholderTemplate[] = [
  {
    status: "live",
    title: "Return the damaged blender and schedule a courier pickup for tomorrow morning",
    sabotage: "Pickup time picker silently resets to next week",
    sabotageCheckpoint: 3,
    checkpointLabel: "Pickup slot",
    checkpointCount: 4,
    prices: [0.31, 0.27, 0.24, 0.18],
    changes: [0.043, -0.012, -0.018, -0.013],
    checkpoints: [2, 2, 1, 1],
    volume: 3_840,
    traders: 41,
    offsetMs: 2.3 * MINUTE,
    blocked: 2,
  },
  {
    status: "live",
    title: "Find the cheapest 27-inch 4K monitor under $300 and reach order confirmation",
    sabotage: "Decoy “Continue” link planted over the checkout button",
    sabotageCheckpoint: 3,
    checkpointLabel: "Cart",
    checkpointCount: 5,
    prices: [0.22, 0.36, 0.19, 0.23],
    changes: [-0.031, 0.108, -0.06, -0.017],
    checkpoints: [3, 4, 2, 3],
    volume: 6_125,
    traders: 58,
    offsetMs: 5.6 * MINUTE,
    fired: true,
  },
  {
    status: "upcoming",
    title: "Book a 2-night stay in Lisbon under €180 per night with free cancellation",
    sabotage: "Fake session-expired modal blocks the payment form",
    sabotageCheckpoint: 4,
    checkpointLabel: "Payment",
    checkpointCount: 5,
    prices: [0.27, 0.29, 0.22, 0.22],
    changes: [0.02, 0.04, -0.03, -0.03],
    checkpoints: [0, 0, 0, 0],
    volume: 910,
    traders: 14,
    offsetMs: 18 * MINUTE,
  },
  {
    status: "upcoming",
    title: "RSVP to Thursday’s design meetup and add it to the team calendar",
    sabotage: "RSVP button relabelled “Unavailable” on the event page",
    sabotageCheckpoint: 2,
    checkpointLabel: "Event page",
    checkpointCount: 3,
    prices: [0.24, 0.28, 0.26, 0.22],
    changes: [-0.01, 0.03, 0.01, -0.03],
    checkpoints: [0, 0, 0, 0],
    volume: 420,
    traders: 9,
    offsetMs: 42 * MINUTE,
  },
  {
    status: "resolved",
    title: "File a support ticket about a double-charged invoice and request a refund",
    sabotage: "Next button on Ticket details disabled for 12 seconds",
    sabotageCheckpoint: 2,
    checkpointLabel: "Ticket details",
    checkpointCount: 4,
    prices: [0.12, 0.71, 0.09, 0.08],
    changes: [-0.13, 0.46, -0.16, -0.17],
    checkpoints: [3, 4, 2, 2],
    volume: 5_210,
    traders: 63,
    offsetMs: 26 * MINUTE,
    durationMs: 2 * MINUTE + 41_000,
    fired: true,
    winner: 1,
  },
  {
    status: "resolved",
    title: "Switch the household energy plan to the 100% green fixed tariff",
    sabotage: "Continue button on Switch date relabelled “Cancel”",
    sabotageCheckpoint: 3,
    checkpointLabel: "Switch date",
    checkpointCount: 4,
    prices: [0.26, 0.24, 0.27, 0.23],
    changes: [0.01, -0.01, 0.02, -0.02],
    checkpoints: [2, 3, 3, 1],
    volume: 2_980,
    traders: 37,
    offsetMs: 58 * MINUTE,
    durationMs: CAP_MS,
    fired: true,
  },
];

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Fight numbers around the featured fight. With room below it, live and
 * resolved previews take lower numbers and upcoming ones higher; otherwise
 * every preview sits above it.
 */
export function placeholderNumbers(featuredNumber: number): number[] {
  const offsets = featuredNumber > PLACEHOLDER_TEMPLATES.length - 2 ? [-1, -2, 1, 2, -3, -4] : [3, 4, 5, 6, 1, 2];
  return offsets.map((offset) => featuredNumber + offset);
}

function agentsFor(template: PlaceholderTemplate): FightAgentSummary[] {
  const resolved = template.status === "resolved";
  return ROSTER.map((agent, index) => {
    const yes = template.prices[index] ?? 0.25;
    const blocked = template.blocked === index;
    return {
      racerId: `racer-${index + 1}`,
      agent,
      yes,
      no: round6(1 - yes),
      change: template.changes[index] ?? 0,
      checkpoint: template.checkpoints[index] ?? 0,
      runStatus: blocked ? "bad" : "run",
      phase: resolved
        ? template.winner === index
          ? "finished"
          : "timed_out"
        : template.status === "upcoming"
          ? "ready"
          : blocked
            ? "recovering"
            : "running",
    };
  });
}

function sabotageFor(template: PlaceholderTemplate, firedAt: number | null): SabotageSummary {
  return {
    revealed: true,
    summary: template.sabotage,
    checkpoint: template.sabotageCheckpoint,
    checkpointLabel: template.checkpointLabel,
    state: template.fired ? "fired" : template.status === "resolved" ? "expired" : "armed",
    firedAt: template.fired ? firedAt : null,
    tier: null,
  };
}

export function buildPlaceholderFights(now: number, featuredNumber: number): FightSummary[] {
  const numbers = placeholderNumbers(featuredNumber);
  return PLACEHOLDER_TEMPLATES.map((template, index) => {
    const number = numbers[index] ?? featuredNumber + index + 1;
    const live = template.status === "live";
    const upcoming = template.status === "upcoming";
    const voided = template.status === "resolved" && template.winner === undefined;

    const finishedAt = template.status === "resolved" ? now - template.offsetMs : null;
    const startedAt = live
      ? now - template.offsetMs
      : finishedAt !== null
        ? finishedAt - (template.durationMs ?? 3 * MINUTE)
        : null;
    const startsAt = upcoming ? now + template.offsetMs : null;
    const firedAt = startedAt !== null ? startedAt + Math.min(template.offsetMs, MINUTE) * 0.8 : null;
    const agents = agentsFor(template);

    return {
      raceId: `preview-${number}`,
      number,
      status: template.status,
      raceStatus: live ? "running" : upcoming ? "starting" : voided ? "timed_out" : "finished",
      marketStatus: template.status === "resolved" ? (voided ? "unresolved" : "resolved") : "open",
      title: template.title,
      sabotage: sabotageFor(template, firedAt),
      createdAt: (startedAt ?? now) - 10 * MINUTE,
      startsAt,
      startedAt,
      freezesAt: startedAt !== null ? startedAt + FREEZE_MS : null,
      closesAt: startedAt !== null ? startedAt + CAP_MS : null,
      finishedAt,
      estimatedResolutionAt: null,
      volume: template.volume,
      traders: template.traders,
      checkpointCount: template.checkpointCount,
      leaderCheckpoint: Math.max(...template.checkpoints),
      agents,
      winnerRacerId: template.winner !== undefined ? `racer-${template.winner + 1}` : null,
      voided,
    } satisfies FightSummary;
  });
}
