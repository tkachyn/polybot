/**
 * Pure helpers over an agent's action trace and Steel trace.
 */
import type { SabotageReaction, SteelTraceEntry, TraceEntry } from "@contract";

/** The Steel trace excerpt covers this much time either side of a hit. */
export const STEEL_EXCERPT_RADIUS_MS = 10_000;

/** Steel events within ±`radiusMs` of `at`, in trace order (oldest first). */
export function steelTraceAround(trace: readonly SteelTraceEntry[], at: number, radiusMs: number = STEEL_EXCERPT_RADIUS_MS): SteelTraceEntry[] {
  return trace.filter((entry) => Math.abs(entry.at - at) <= radiusMs);
}

export type TraceRow = { kind: "step"; entry: TraceEntry } | { kind: "hit"; reaction: SabotageReaction };

/**
 * The action trace with a marker row for each sabotage hit, placed before the
 * first step taken at or after the hit. Hits after the last step go last.
 */
export function interleaveHits(trace: readonly TraceEntry[], reactions: readonly SabotageReaction[]): TraceRow[] {
  const hits = [...reactions].sort((a, b) => a.appliedAt - b.appliedAt);
  const rows: TraceRow[] = [];
  let next = 0;
  for (const entry of trace) {
    for (let hit = hits[next]; hit && hit.appliedAt <= entry.at; hit = hits[next]) {
      rows.push({ kind: "hit", reaction: hit });
      next += 1;
    }
    rows.push({ kind: "step", entry });
  }
  for (const hit of hits.slice(next)) rows.push({ kind: "hit", reaction: hit });
  return rows;
}

export type TraceTotals = { steps: number; errors: number; decoys: number; blocked: number };

export function traceTotals(trace: readonly TraceEntry[]): TraceTotals {
  let errors = 0;
  let decoys = 0;
  let blocked = 0;
  for (const entry of trace) {
    if (entry.kind === "error") errors += 1;
    if (entry.decoy) decoys += 1;
    if (entry.blockedBy !== null) blocked += 1;
  }
  return { steps: trace.length, errors, decoys, blocked };
}
