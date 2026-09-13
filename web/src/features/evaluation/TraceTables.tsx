/**
 * Collapsible traces: the Steel trace excerpt around one hit, and an agent's
 * full action trace with the model's reasoning for each step. Tables render
 * only while open, and scroll in their own container.
 */
import { useMemo, useState, type ReactNode, type SyntheticEvent } from "react";
import type { AgentEvaluation, SabotageReaction, SteelTraceEntry, TraceEntry } from "@contract";
import { IconChevronRight, SabotageTag, Tag, tableStyles } from "../../components";
import { cx } from "../../lib/cx";
import { EMPTY, formatNumber } from "../../lib/format";
import { BLOCKED_BY_DESCRIPTION, BLOCKED_BY_LABEL } from "../../lib/labels";
import { formatFightTime, formatOffset, sabotageStepTitle } from "./format";
import { STEEL_EXCERPT_RADIUS_MS, interleaveHits, isTraceStep, steelTraceAround, traceReasoning, traceTotals } from "./trace";
import styles from "./Trace.module.css";

function plural(n: number, one: string, many: string): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

export type DisclosureProps = {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
};

/** Native <details>; the body mounts only while open so closed traces cost nothing. */
export function Disclosure({ summary, children, className }: DisclosureProps) {
  const [open, setOpen] = useState(false);
  return (
    <details className={cx(styles.disclosure, className)} onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open)}>
      <summary className={styles.summary}>
        <IconChevronRight size={12} className={styles.chevron} />
        <span className={styles.summaryText}>{summary}</span>
      </summary>
      {open && <div className={styles.body}>{children}</div>}
    </details>
  );
}

function DecoyFlag({ decoy }: { decoy: boolean }) {
  return decoy ? (
    <Tag tone="sabotage" title="The target was a planted decoy">
      Decoy
    </Tag>
  ) : (
    <span className={styles.none}>{EMPTY}</span>
  );
}

// ---------------------------------------------------------------------------
// Steel trace excerpt
// ---------------------------------------------------------------------------

export type SteelExcerptProps = {
  trace: readonly SteelTraceEntry[];
  /** The hit (appliedAt); rows within ±10 s of it are shown. */
  at: number;
};

export function SteelExcerpt({ trace, at }: SteelExcerptProps) {
  const rows = useMemo(() => steelTraceAround(trace, at), [trace, at]);
  const decoys = rows.reduce((n, row) => n + (row.decoy ? 1 : 0), 0);
  const seconds = STEEL_EXCERPT_RADIUS_MS / 1000;
  return (
    <Disclosure
      summary={
        <>
          Steel trace · <span className="num">{plural(rows.length, "event", "events")}</span> within ±{seconds} s of the hit
          {decoys > 0 && <span className={styles.summaryAlert}> · {plural(decoys, "decoy click", "decoy clicks")}</span>}
        </>
      }
    >
      {rows.length === 0 ? (
        <p className={styles.empty}>Steel recorded no events within {seconds} s of the hit.</p>
      ) : (
        <div className={styles.scroll}>
          <table className={cx(tableStyles.table, tableStyles.compact, styles.table)}>
            <thead>
              <tr>
                <th scope="col" className={tableStyles.num} title="Time relative to the hit">
                  Offset
                </th>
                <th scope="col">Event</th>
                <th scope="col">Target</th>
                <th scope="col">Role</th>
                <th scope="col">Selector</th>
                <th scope="col">Decoy</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.at}-${index}`} className={cx(tableStyles.row, row.decoy && styles.decoyRow)}>
                  <td className={cx(tableStyles.num, styles.offset)}>{formatOffset(row.at - at)}</td>
                  <td className={styles.type}>{row.type}</td>
                  <td className={styles.text} title={row.url ?? undefined}>
                    {row.label ?? <span className={styles.none}>{EMPTY}</span>}
                  </td>
                  <td>{row.role ? <code className={styles.code}>{row.role}</code> : <span className={styles.none}>{EMPTY}</span>}</td>
                  <td className={styles.selectorCell}>
                    {row.selector ? (
                      <code className={cx(styles.code, styles.selector)} title={row.selector}>
                        {row.selector}
                      </code>
                    ) : (
                      <span className={styles.none}>{EMPTY}</span>
                    )}
                  </td>
                  <td>
                    <DecoyFlag decoy={row.decoy} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// Full action trace
// ---------------------------------------------------------------------------

export type FullTraceProps = {
  agent: AgentEvaluation;
  /** Fight start, for the time column. */
  startedAt: number | null;
};

export function FullTrace({ agent, startedAt }: FullTraceProps) {
  const totals = useMemo(() => traceTotals(agent.trace), [agent.trace]);
  if (agent.trace.length === 0) return <p className={styles.empty}>No steps recorded.</p>;
  return (
    <Disclosure
      summary={
        <>
          Full action trace · <span className="num">{plural(totals.steps, "step", "steps")}</span>
          {totals.errors > 0 && <span className="num"> · {plural(totals.errors, "error", "errors")}</span>}
          {totals.decoys > 0 && <span className={cx("num", styles.summaryAlert)}> · {plural(totals.decoys, "decoy click", "decoy clicks")}</span>}
          {totals.cleared > 0 && (
            <span className={cx("num", styles.summaryPositive)}> · {plural(totals.cleared, "sabotage cleared", "sabotages cleared")}</span>
          )}
        </>
      }
    >
      <FullTraceTable agent={agent} startedAt={startedAt} />
    </Disclosure>
  );
}

function TargetCell({ entry }: { entry: TraceEntry }) {
  if (!entry.targetRole && !entry.targetText) return <span className={styles.none}>{EMPTY}</span>;
  return (
    <span className={styles.target}>
      {entry.targetRole && <code className={styles.code}>{entry.targetRole}</code>}
      {entry.targetText && <span className={styles.targetText}>{entry.targetText}</span>}
    </span>
  );
}

/** The model's stated reason: two lines, with the full text in the title. */
function ReasoningCell({ entry }: { entry: TraceEntry }) {
  const reasoning = traceReasoning(entry);
  if (reasoning === null) return <span className={styles.none}>{EMPTY}</span>;
  return (
    <span className={cx("clamp-2", styles.reasoning)} title={reasoning}>
      {reasoning}
    </span>
  );
}

/** What the step did to the run: cleared a sabotage, clicked a decoy, or was blocked. */
function ResultCell({ entry }: { entry: TraceEntry }) {
  if (!entry.clearedSabotage && !entry.decoy && !entry.blockedBy) return <span className={styles.none}>{EMPTY}</span>;
  return (
    <span className={styles.flags}>
      {entry.clearedSabotage && (
        <Tag tone="positive" title="This step cleared the active sabotage">
          Cleared sabotage
        </Tag>
      )}
      {entry.decoy && (
        <Tag tone="sabotage" title="The target was a planted decoy">
          Decoy
        </Tag>
      )}
      {entry.blockedBy && (
        <Tag tone="neutral" title={BLOCKED_BY_DESCRIPTION[entry.blockedBy]}>
          Blocked · {BLOCKED_BY_LABEL[entry.blockedBy]}
        </Tag>
      )}
    </span>
  );
}

/** Columns in the full trace; the sabotage marker rows span all of them. */
const TRACE_COLUMNS = 6;

/** "Plant a decoy control · Decoy control", or just "Insert decoy" when the step is named after its hazard. */
function hitText(reaction: SabotageReaction): string {
  const { title, hazard } = sabotageStepTitle(reaction);
  return hazard ? `${title} · ${hazard}` : title;
}

function FullTraceTable({ agent, startedAt }: FullTraceProps) {
  const rows = useMemo(() => interleaveHits(agent.trace, agent.sabotage), [agent.trace, agent.sabotage]);
  return (
    <div className={cx(styles.scroll, styles.scrollTall)}>
      <table className={cx(tableStyles.table, tableStyles.compact, styles.table, styles.traceTable)}>
        <thead>
          <tr>
            <th scope="col" className={tableStyles.num}>
              Step
            </th>
            <th scope="col" className={tableStyles.num} title={startedAt === null ? "Local time" : "Time into the fight"}>
              Time
            </th>
            <th scope="col">Action</th>
            <th scope="col">Target</th>
            <th scope="col" title="The model’s stated reason for the step">
              Reasoning
            </th>
            <th scope="col" title="Cleared a sabotage, clicked a decoy, or was blocked">
              Result
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) =>
            row.kind === "hit" ? (
              <tr key={`hit-${row.reaction.stepId}-${index}`} className={styles.hitRow}>
                <td colSpan={TRACE_COLUMNS}>
                  <span className={styles.hitMarker}>
                    <SabotageTag>Sabotage {row.reaction.stepIndex}</SabotageTag>
                    <span className={styles.hitText}>{hitText(row.reaction)}</span>
                    <span className={cx("num", styles.hitTime)}>hit at {formatFightTime(row.reaction.appliedAt, startedAt)}</span>
                  </span>
                </td>
              </tr>
            ) : (
              <tr
                key={`step-${row.entry.step}-${index}`}
                className={cx(tableStyles.row, row.entry.kind === "error" && styles.errorRow, row.entry.clearedSabotage && styles.clearedRow)}
              >
                {/* A note is not a step, so it takes no step number (see isTraceStep). */}
                <td className={tableStyles.num}>{isTraceStep(row.entry) ? formatNumber(row.entry.step) : <span className={styles.none}>{EMPTY}</span>}</td>
                <td className={cx(tableStyles.num, styles.time)}>{formatFightTime(row.entry.at, startedAt)}</td>
                <td className={styles.actionCell} title={row.entry.url ?? undefined}>
                  <span className={cx(row.entry.kind === "error" && styles.errorText, row.entry.kind === "note" && styles.noteText)}>
                    {row.entry.kind !== "action" && <span className={styles.kind}>{row.entry.kind === "error" ? "Error" : "Note"} </span>}
                    {row.entry.text}
                  </span>
                </td>
                <td className={styles.targetCell}>
                  <TargetCell entry={row.entry} />
                </td>
                <td>
                  <ReasoningCell entry={row.entry} />
                </td>
                <td>
                  <ResultCell entry={row.entry} />
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
