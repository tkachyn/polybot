/**
 * Preview lobby: hardcoded sample fights that keep the lobby from looking
 * empty on a fresh backend. They stand in for a status (upcoming, resolved)
 * only while the backend has no real fight with it, and they are always
 * marked as previews: a "Preview" tag, and a disabled View that explains why.
 * They are never fetched, traded or opened.
 *
 * Never shown while the lobby is loading or the server is unreachable (see
 * previewsAllowed): a sample fight next to a skeleton or an error banner
 * reads as real data.
 *
 * Times are relative to `now` so clocks and countdowns read naturally for
 * the length of a demo. Fight numbers never collide with a real fight's.
 */
import type {
  AgentIdentity,
  FightAgentSummary,
  FightStatus,
  FightSummary,
  LeaderboardRow,
  SabotageSummary,
} from "@contract";

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
    status: "upcoming",
    title: "Renew a passport online and pay the fast-track processing fee",
    sabotage: "Photo upload button hidden behind a cookie banner",
    sabotageCheckpoint: 3,
    checkpointLabel: "Photo upload",
    checkpointCount: 5,
    prices: [0.26, 0.3, 0.21, 0.23],
    changes: [0.01, 0.03, -0.02, -0.02],
    checkpoints: [0, 0, 0, 0],
    volume: 760,
    traders: 12,
    offsetMs: 55 * MINUTE,
  },
  {
    status: "upcoming",
    title: "Order a large pepperoni pizza for delivery and apply the 20% student code",
    sabotage: "Promo field rejects every code with a fake error",
    sabotageCheckpoint: 3,
    checkpointLabel: "Checkout",
    checkpointCount: 4,
    prices: [0.25, 0.27, 0.25, 0.23],
    changes: [0, 0.02, 0.01, -0.03],
    checkpoints: [0, 0, 0, 0],
    volume: 1_140,
    traders: 19,
    offsetMs: 68 * MINUTE,
  },
  {
    status: "upcoming",
    title: "Buy two floor tickets for Saturday’s concert for under $250 in total",
    sabotage: "Seat map swaps prices after a seat is picked",
    sabotageCheckpoint: 2,
    checkpointLabel: "Seat map",
    checkpointCount: 4,
    prices: [0.23, 0.31, 0.24, 0.22],
    changes: [-0.02, 0.05, 0, -0.03],
    checkpoints: [0, 0, 0, 0],
    volume: 1_530,
    traders: 22,
    offsetMs: 80 * MINUTE,
  },
  {
    status: "upcoming",
    title: "Cancel the gym membership without accepting the retention offer",
    sabotage: "“Keep my membership” moved into the Cancel button’s spot",
    sabotageCheckpoint: 2,
    checkpointLabel: "Cancellation",
    checkpointCount: 3,
    prices: [0.28, 0.26, 0.23, 0.23],
    changes: [0.03, 0.01, -0.02, -0.02],
    checkpoints: [0, 0, 0, 0],
    volume: 640,
    traders: 11,
    offsetMs: 95 * MINUTE,
  },
  {
    status: "upcoming",
    title: "Move $500 from checking to savings and download the transfer receipt",
    sabotage: "Amount field clears itself after the first keystroke",
    sabotageCheckpoint: 2,
    checkpointLabel: "Transfer form",
    checkpointCount: 4,
    prices: [0.24, 0.29, 0.25, 0.22],
    changes: [-0.01, 0.04, 0, -0.03],
    checkpoints: [0, 0, 0, 0],
    volume: 880,
    traders: 15,
    offsetMs: 110 * MINUTE,
  },
  {
    status: "upcoming",
    title: "Rent a compact car at Denver airport from Friday to Monday under $200",
    sabotage: "Pickup calendar opens on the wrong month",
    sabotageCheckpoint: 2,
    checkpointLabel: "Dates",
    checkpointCount: 5,
    prices: [0.22, 0.3, 0.27, 0.21],
    changes: [-0.03, 0.05, 0.02, -0.04],
    checkpoints: [0, 0, 0, 0],
    volume: 1_020,
    traders: 17,
    offsetMs: 125 * MINUTE,
  },
  {
    status: "upcoming",
    title: "Apply for the junior frontend developer role and attach a résumé",
    sabotage: "Upload input stays disabled until the page is scrolled twice",
    sabotageCheckpoint: 3,
    checkpointLabel: "Résumé",
    checkpointCount: 4,
    prices: [0.27, 0.28, 0.22, 0.23],
    changes: [0.02, 0.03, -0.03, -0.02],
    checkpoints: [0, 0, 0, 0],
    volume: 590,
    traders: 10,
    offsetMs: 140 * MINUTE,
  },
  {
    status: "upcoming",
    title: "Book a dental cleaning for next Tuesday afternoon",
    sabotage: "Every afternoon slot shows as “Fully booked”",
    sabotageCheckpoint: 2,
    checkpointLabel: "Time slot",
    checkpointCount: 3,
    prices: [0.25, 0.26, 0.26, 0.23],
    changes: [0, 0.01, 0.01, -0.02],
    checkpoints: [0, 0, 0, 0],
    volume: 470,
    traders: 8,
    offsetMs: 160 * MINUTE,
  },
  {
    status: "upcoming",
    title: "Add three items to a grocery cart and pick a two-hour delivery window",
    sabotage: "Delivery windows reload and drop the chosen slot",
    sabotageCheckpoint: 3,
    checkpointLabel: "Delivery window",
    checkpointCount: 4,
    prices: [0.26, 0.25, 0.24, 0.25],
    changes: [0.01, 0, -0.01, 0],
    checkpoints: [0, 0, 0, 0],
    volume: 1_260,
    traders: 20,
    offsetMs: 180 * MINUTE,
  },
  {
    status: "upcoming",
    title: "Report a pothole to the city with its exact location and a photo",
    sabotage: "Map pin snaps back to the city centre",
    sabotageCheckpoint: 2,
    checkpointLabel: "Location",
    checkpointCount: 4,
    prices: [0.21, 0.27, 0.29, 0.23],
    changes: [-0.04, 0.02, 0.04, -0.02],
    checkpoints: [0, 0, 0, 0],
    volume: 350,
    traders: 7,
    offsetMs: 200 * MINUTE,
  },
  {
    status: "upcoming",
    title: "Upgrade the phone plan to unlimited data without adding device insurance",
    sabotage: "Insurance add-on re-checks itself on the review page",
    sabotageCheckpoint: 3,
    checkpointLabel: "Review",
    checkpointCount: 4,
    prices: [0.24, 0.32, 0.23, 0.21],
    changes: [-0.01, 0.07, -0.02, -0.04],
    checkpoints: [0, 0, 0, 0],
    volume: 1_690,
    traders: 26,
    offsetMs: 225 * MINUTE,
  },
  {
    status: "upcoming",
    title: "Reserve a table for four at 7:30 pm on Saturday at an Italian restaurant",
    sabotage: "Party-size menu relabelled with the wrong numbers",
    sabotageCheckpoint: 2,
    checkpointLabel: "Party size",
    checkpointCount: 3,
    prices: [0.27, 0.27, 0.24, 0.22],
    changes: [0.02, 0.02, -0.01, -0.03],
    checkpoints: [0, 0, 0, 0],
    volume: 730,
    traders: 13,
    offsetMs: 250 * MINUTE,
  },
  {
    status: "upcoming",
    title: "Pay a parking ticket online using the citation number on the notice",
    sabotage: "Fake “system maintenance” modal covers the payment step",
    sabotageCheckpoint: 3,
    checkpointLabel: "Payment",
    checkpointCount: 4,
    prices: [0.23, 0.28, 0.26, 0.23],
    changes: [-0.02, 0.03, 0.01, -0.02],
    checkpoints: [0, 0, 0, 0],
    volume: 540,
    traders: 9,
    offsetMs: 280 * MINUTE,
  },
  {
    status: "upcoming",
    title: "Sign up for the annual newsletter plan and opt out of all marketing emails",
    sabotage: "Opt-out checkboxes swap their labels",
    sabotageCheckpoint: 2,
    checkpointLabel: "Preferences",
    checkpointCount: 3,
    prices: [0.25, 0.3, 0.22, 0.23],
    changes: [0, 0.05, -0.03, -0.02],
    checkpoints: [0, 0, 0, 0],
    volume: 410,
    traders: 8,
    offsetMs: 310 * MINUTE,
  },
  {
    status: "upcoming",
    title: "Start a return for shoes that don’t fit and print the prepaid label",
    sabotage: "“Print label” link leads to a decoy help page",
    sabotageCheckpoint: 4,
    checkpointLabel: "Return label",
    checkpointCount: 5,
    prices: [0.26, 0.28, 0.25, 0.21],
    changes: [0.01, 0.03, 0, -0.04],
    checkpoints: [0, 0, 0, 0],
    volume: 980,
    traders: 16,
    offsetMs: 345 * MINUTE,
  },
  {
    status: "upcoming",
    title: "Find a pet-friendly two-bedroom apartment under $2,000 and request a tour",
    sabotage: "Pet-friendly filter silently switches itself off",
    sabotageCheckpoint: 2,
    checkpointLabel: "Filters",
    checkpointCount: 5,
    prices: [0.22, 0.29, 0.26, 0.23],
    changes: [-0.03, 0.04, 0.01, -0.02],
    checkpoints: [0, 0, 0, 0],
    volume: 1_370,
    traders: 21,
    offsetMs: 380 * MINUTE,
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

/** Where preview numbers start when the backend has no fight at all. */
export const DEFAULT_PREVIEW_NUMBER = 412;

/**
 * One fight number per template, never one a real fight has. Upcoming
 * previews continue the sequence past the newest real fight; the others sit
 * below the oldest, or above everything when there is no room below.
 */
export function placeholderNumbers(realNumbers: Iterable<number>): number[] {
  const taken = new Set<number>();
  for (const n of realNumbers) if (Number.isInteger(n) && n > 0) taken.add(n);
  let up = taken.size > 0 ? Math.max(...taken) : DEFAULT_PREVIEW_NUMBER - 1;
  let down = taken.size > 0 ? Math.min(...taken) : DEFAULT_PREVIEW_NUMBER;

  const above = (): number => {
    do up += 1;
    while (taken.has(up));
    taken.add(up);
    return up;
  };
  const below = (): number => {
    do down -= 1;
    while (down > 0 && taken.has(down));
    if (down <= 0) return above();
    taken.add(down);
    return down;
  };
  return PLACEHOLDER_TEMPLATES.map((template) => (template.status === "upcoming" ? above() : below()));
}

/**
 * Previews may stand in only on a loaded, healthy lobby: never behind a
 * skeleton, and never next to a "couldn't load" or "interrupted" banner.
 */
export function previewsAllowed({ loaded, error }: { loaded: boolean; error: unknown }): boolean {
  return loaded && (error === null || error === undefined);
}

/** Tooltip on a preview's disabled View and on preview rail rows. */
export const PREVIEW_FIGHT_HINT = "Sample fight, shown until real fights are scheduled. It can't be opened or traded.";

/** Tooltip on the Preview tag of the sample standings. */
export const PREVIEW_STANDINGS_HINT = "Sample standings, shown until the first fight settles.";

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
    stepCount: 1,
    steps: [{
      index: 1,
      stepId: "preview-step-1",
      checkpoint: template.sabotageCheckpoint,
      checkpointLabel: template.checkpointLabel,
      state: template.fired ? "fired" : template.status === "resolved" ? "expired" : "armed",
      firedAt: template.fired ? firedAt : null,
      recoveredAt: null,
      hitRacerIds: [],
      hazardType: null,
    }],
  };
}

/** One preview per template, numbered clear of `realNumbers` (every real fight's number). */
export function buildPlaceholderFights(now: number, realNumbers: Iterable<number>): FightSummary[] {
  const numbers = placeholderNumbers(realNumbers);
  return PLACEHOLDER_TEMPLATES.map((template, index) => {
    const number = numbers[index] ?? DEFAULT_PREVIEW_NUMBER + index;
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

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

/**
 * A standing for one agent, before the derived rates are filled in. Win rate,
 * sabotage survival and rank are computed rather than written down, so the
 * figures can never contradict each other.
 */
type PlaceholderStanding = {
  agent: AgentIdentity;
  fights: number;
  wins: number;
  sabotageHits: number;
  sabotageSurvived: number;
  /** Return to backers who bought YES on this agent. */
  backerRoi: number | null;
  /** Mean winning finish, in seconds. */
  avgFinishSec: number | null;
};

/**
 * The demo's ranking, ordered as written: strongest first. Keys match the
 * vendor marks in brand-logos, so every row carries its model's real logo.
 */
const PLACEHOLDER_STANDINGS: readonly PlaceholderStanding[] = [
  {
    agent: { key: "claude", name: "Claude Opus 4.6", provider: "anthropic", model: "claude-opus-4-6" },
    fights: 31, wins: 12, sabotageHits: 24, sabotageSurvived: 17, backerRoi: 0.34, avgFinishSec: 168,
  },
  {
    agent: { key: "gpt", name: "GPT-5.2", provider: "openai", model: "gpt-5.2" },
    fights: 34, wins: 11, sabotageHits: 27, sabotageSurvived: 18, backerRoi: 0.19, avgFinishSec: 181,
  },
  {
    agent: { key: "gemini", name: "Gemini 3 Pro", provider: "google", model: "gemini-3-pro" },
    fights: 29, wins: 8, sabotageHits: 22, sabotageSurvived: 13, backerRoi: -0.06, avgFinishSec: 195,
  },
  {
    agent: { key: "grok", name: "Grok 4.1", provider: "xai", model: "grok-4.1" },
    fights: 27, wins: 6, sabotageHits: 21, sabotageSurvived: 11, backerRoi: -0.12, avgFinishSec: 204,
  },
  {
    agent: { key: "deepseek", name: "DeepSeek V4.1 Flash", provider: "deepseek", model: "deepseek-v4.1-flash" },
    fights: 22, wins: 4, sabotageHits: 18, sabotageSurvived: 8, backerRoi: -0.21, avgFinishSec: 212,
  },
  {
    agent: { key: "qwen", name: "Qwen 3 Max", provider: "alibaba", model: "qwen-3-max" },
    fights: 18, wins: 3, sabotageHits: 15, sabotageSurvived: 6, backerRoi: -0.28, avgFinishSec: 227,
  },
  {
    agent: { key: "mistral", name: "Mistral Large 3", provider: "mistralai", model: "mistral-large-3" },
    fights: 16, wins: 2, sabotageHits: 13, sabotageSurvived: 4, backerRoi: -0.35, avgFinishSec: 241,
  },
  {
    agent: { key: "meta", name: "Llama 4.2 405B", provider: "meta-llama", model: "llama-4.2-405b" },
    fights: 14, wins: 1, sabotageHits: 12, sabotageSurvived: 3, backerRoi: -0.44, avgFinishSec: null,
  },
];

/**
 * Hardcoded standings for the demo, used only while the backend has none of
 * its own (a fresh live deployment, before any fight has resolved). Real rows
 * always win; these never merge with them.
 */
export function buildPlaceholderLeaderboard(): LeaderboardRow[] {
  return PLACEHOLDER_STANDINGS.map((standing, index) => ({
    rank: index + 1,
    agent: standing.agent,
    fights: standing.fights,
    wins: standing.wins,
    winRate: standing.wins / standing.fights,
    sabotageHits: standing.sabotageHits,
    sabotageSurvived: standing.sabotageSurvived,
    sabotageSurvival: standing.sabotageHits === 0 ? null : standing.sabotageSurvived / standing.sabotageHits,
    backerRoi: standing.backerRoi,
    avgFinishMs: standing.avgFinishSec === null ? null : standing.avgFinishSec * 1000,
  }));
}
