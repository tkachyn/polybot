/**
 * Pure helpers over an agent's action trace and Steel trace.
 */
import type { SabotageReaction, TraceEntry } from "@contract";

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

/**
 * Actions and errors are steps; notes (the opening page load, a pause for a
 * rate limit) are logged in the trace but are not steps. The agent's own step
 * count ("Steps 40/90") counts the same way.
 */
export function isTraceStep(entry: Pick<TraceEntry, "kind">): boolean {
  return entry.kind !== "note";
}

export type TraceTotals = { steps: number; notes: number; errors: number; decoys: number; blocked: number; cleared: number };

export function traceTotals(trace: readonly TraceEntry[]): TraceTotals {
  let steps = 0;
  let errors = 0;
  let decoys = 0;
  let blocked = 0;
  let cleared = 0;
  for (const entry of trace) {
    if (isTraceStep(entry)) steps += 1;
    if (entry.kind === "error") errors += 1;
    if (entry.decoy) decoys += 1;
    if (entry.blockedBy !== null) blocked += 1;
    if (entry.clearedSabotage) cleared += 1;
  }
  return { steps, notes: trace.length - steps, errors, decoys, blocked, cleared };
}

/** The model's stated reason for a step, trimmed; null when it gave none. */
export function traceReasoning(entry: Pick<TraceEntry, "reasoning">): string | null {
  const text = entry.reasoning?.trim();
  return text ? text : null;
}
