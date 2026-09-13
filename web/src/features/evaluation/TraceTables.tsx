/**
 * An agent's full action trace, with the model's reasoning for each step, in
 * a collapsible Disclosure. The table renders only while open, and scrolls
 * in its own container.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import type { AgentEvaluation, SabotageReaction, TraceEntry } from "@contract";
import { IconChevronRight, SabotageTag, Tag, tableStyles } from "../../components";
import { cx } from "../../lib/cx";
import { EMPTY, formatNumber } from "../../lib/format";
import { BLOCKED_BY_DESCRIPTION, BLOCKED_BY_LABEL } from "../../lib/labels";
import { formatFightTime, sabotageStepTitle } from "./format";
import { interleaveHits, isTraceStep, traceReasoning, traceTotals } from "./trace";
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
          Action trace · <span className="num">{plural(totals.steps, "step", "steps")}</span>
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

/**
 * The model's stated reason, clamped to two lines. When the clamp hides text,
 * a click or tap on it opens the whole reason (and closes it again), and a
 * "Show more" button does the same from the keyboard.
 */
function ReasoningCell({ entry }: { entry: TraceEntry }) {
  const reasoning = traceReasoning(entry);
  const textRef = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  // Measured while closed, and again whenever the column's width changes.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return undefined;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [reasoning, expanded]);

  if (reasoning === null) return <span className={styles.none}>{EMPTY}</span>;
  const toggleable = clamped || expanded;
  const toggle = () => setExpanded((open) => !open);
  return (
    <span className={styles.reasoningCell}>
      <span
        ref={textRef}
        className={cx(!expanded && "clamp-2", styles.reasoning, toggleable && styles.reasoningToggle)}
        // Selecting text to copy it is not a toggle.
        onClick={toggleable ? () => !window.getSelection()?.toString() && toggle() : undefined}
      >
        {reasoning}
      </span>
      {toggleable && (
        <button type="button" className={styles.reasoningMore} aria-expanded={expanded} onClick={toggle}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
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
