/**
 * Agent identity: colour and monogram keyed on `AgentIdentity.key`.
 *
 * The four roster colours are fixed by the handoff and must never be swapped
 * between agents: the same key always renders the same colour, in tiles,
 * chart series, progress bars and legends. Unknown keys get a deterministic
 * fallback colour from a hash of the key.
 */
import type { CSSProperties } from "react";
import type { AgentIdentity } from "@contract";

export const KNOWN_AGENT_KEYS = ["gpt", "claude", "gemini", "grok"] as const;
export type KnownAgentKey = (typeof KNOWN_AGENT_KEYS)[number];

export type AgentPaletteEntry = {
  color: string;
  /** Human name for the hue, for docs and debugging. */
  hue: string;
  monogram: string;
};

export const AGENT_PALETTE: Readonly<Record<KnownAgentKey, AgentPaletteEntry>> = {
  gpt: { color: "#7fd1c1", hue: "teal", monogram: "GP" },
  claude: { color: "#e8c07a", hue: "sand", monogram: "CL" },
  gemini: { color: "#79a8e8", hue: "blue", monogram: "GE" },
  grok: { color: "#b39ae0", hue: "violet", monogram: "GR" },
};

/**
 * Fallback colours for keys outside the default roster. Chosen to stay clear
 * of the four roster hues and of the positive green and sabotage terracotta.
 */
export const FALLBACK_AGENT_COLORS = ["#e39ac4", "#c9cf7a", "#8fd0e8", "#f0b49a", "#b8c4ce", "#a3d6a0"] as const;

/** Monogram tile fill alpha (handoff: 12%). */
export const AGENT_FILL_ALPHA = 0.12;
/** Monogram tile border alpha (handoff: 33%). */
export const AGENT_BORDER_ALPHA = 0.33;

export type AgentVisual = {
  key: string;
  /** Solid identity colour: text, chart series, progress fill. */
  color: string;
  /** Colour at 12% alpha: monogram tile fill. */
  fill: string;
  /** Colour at 33% alpha: monogram tile border. */
  border: string;
  monogram: string;
  /** True for the four roster keys. */
  known: boolean;
};

/** Anything with a key: an `AgentIdentity`, or `{ key, name }`. */
export type AgentLike = Pick<AgentIdentity, "key"> & Partial<Pick<AgentIdentity, "name">>;

export function normalizeAgentKey(key: string): string {
  return key.trim().toLowerCase();
}

export function isKnownAgentKey(key: string): key is KnownAgentKey {
  return (KNOWN_AGENT_KEYS as readonly string[]).includes(key);
}

/** FNV-1a 32-bit. Deterministic across sessions and browsers. */
export function hashKey(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function fallbackColor(key: string, offset = 0): string {
  const index = (hashKey(key) + offset) % FALLBACK_AGENT_COLORS.length;
  return FALLBACK_AGENT_COLORS[index] ?? FALLBACK_AGENT_COLORS[0];
}

/** "#7fd1c1" + 0.12 → "rgba(127, 209, 193, 0.12)". Accepts #rgb and #rrggbb. */
export function withAlpha(hex: string, alpha: number): string {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = Number.parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n) || h.length < 6) return hex;
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Tile fill: identity colour at 12% alpha. */
export function agentTileFill(color: string): string {
  return withAlpha(color, AGENT_FILL_ALPHA);
}

/** Tile border: identity colour at 33% alpha. */
export function agentTileBorder(color: string): string {
  return withAlpha(color, AGENT_BORDER_ALPHA);
}

export function agentColor(key: string): string {
  const k = normalizeAgentKey(key);
  return isKnownAgentKey(k) ? AGENT_PALETTE[k].color : fallbackColor(k);
}

/**
 * Two-letter monogram. Roster keys use the handoff monograms (GP, CL, GE,
 * GR); others use the first two letters or digits of the name, else the key.
 */
export function agentMonogram(key: string, name?: string): string {
  const k = normalizeAgentKey(key);
  if (isKnownAgentKey(k)) return AGENT_PALETTE[k].monogram;
  const source = (name ?? "").replace(/[^A-Za-z0-9]/g, "") || k.replace(/[^A-Za-z0-9]/g, "");
  return source.slice(0, 2).toUpperCase() || "?";
}

function visualFor(key: string, color: string, name?: string): AgentVisual {
  const k = normalizeAgentKey(key);
  return {
    key: k,
    color,
    fill: agentTileFill(color),
    border: agentTileBorder(color),
    monogram: agentMonogram(k, name),
    known: isKnownAgentKey(k),
  };
}

/** Colour, tile fill/border and monogram for one agent. */
export function agentVisual(agent: AgentLike | string): AgentVisual {
  const key = typeof agent === "string" ? agent : agent.key;
  const name = typeof agent === "string" ? undefined : agent.name;
  return visualFor(key, agentColor(key), name);
}

/**
 * Visuals for a whole roster, in input order. Roster keys always keep their
 * own colour. Unknown keys start from their hashed fallback and step to the
 * next unused fallback colour, so no two agents in one fight share a colour.
 */
export function rosterVisuals(agents: readonly AgentLike[]): AgentVisual[] {
  const used = new Set<string>();
  for (const agent of agents) {
    const k = normalizeAgentKey(agent.key);
    if (isKnownAgentKey(k)) used.add(AGENT_PALETTE[k].color);
  }
  const assigned = new Map<string, string>();
  return agents.map((agent) => {
    const k = normalizeAgentKey(agent.key);
    if (isKnownAgentKey(k)) return visualFor(k, AGENT_PALETTE[k].color, agent.name);
    let color = assigned.get(k);
    if (!color) {
      color = fallbackColor(k);
      for (let step = 1; used.has(color) && step < FALLBACK_AGENT_COLORS.length; step += 1) {
        color = fallbackColor(k, step);
      }
      used.add(color);
      assigned.set(k, color);
    }
    return visualFor(k, color, agent.name);
  });
}

/**
 * Inline style exposing the agent colours as CSS custom properties, so CSS
 * modules can use `var(--agent-color)`, `var(--agent-fill)` and
 * `var(--agent-border)`.
 */
export function agentStyle(agent: AgentVisual | AgentLike | string): CSSProperties {
  const visual = typeof agent === "object" && "fill" in agent ? agent : agentVisual(agent);
  return {
    "--agent-color": visual.color,
    "--agent-fill": visual.fill,
    "--agent-border": visual.border,
  } as CSSProperties;
}

/** "OpenAI · gpt-5.2"; a single value when provider and model coincide (simulated agents). */
export function agentModelLabel(agent: { provider: string; model: string }): string {
  return agent.provider === agent.model ? agent.model : `${agent.provider} · ${agent.model}`;
}
