/**
 * The evaluation report for one fight: how each agent did the task and how it
 * reacted to each sabotage hit (GET /api/fights/:raceId/evaluation, refetched
 * when the fight's evaluation pointer changes).
 *
 * Rendered near the top of the resolved-fight screen (features/settled), and
 * as EvaluationReportView by the screen for a fight that has left the lobby,
 * which loads the evaluation itself. It renders no Page of its own.
 */
import { useId, useMemo, type MouseEvent, type ReactNode } from "react";
import type { AgentEvaluation, EvaluatedSabotageStep, FightEvaluation, FightEvaluationPointer, ReactionLabel } from "@contract";
import { AgentMonogram, Button, EmptyState, ErrorBanner, IconAlert, ProgressBar, Skeleton, SkeletonText, Tag, TableWrap, tableStyles } from "../../components";
import { agentStyle, rosterVisuals, type AgentVisual } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { formatDateTime, formatFightNumber, formatNumber, isFiniteNumber } from "../../lib/format";
import { EVALUATION_MODE_LABEL, REACTION_LABEL, SIMULATED_AGENTS_COPY, SIMULATED_AGENTS_LABEL } from "../../lib/labels";
import { AgentEvaluationSection } from "./AgentEvaluationSection";
import { EvaluationStatusChip, OutcomeChip, ReactionChip } from "./Chip";
import { evaluationDisplayStatus, robustnessView, sabotageStepMeta, sabotageStepTitle } from "./format";
import { REACTION_TONE } from "./tones";
import { Disclosure } from "./TraceTables";
import { useFightEvaluation, type FightEvaluationState } from "./useFightEvaluation";
import styles from "./EvaluationReport.module.css";

/** The contract caps findings at six; the UI enforces it too. */
export const MAX_FINDINGS = 6;

export type EvaluationReportProps = {
  raceId: string;
  /** `FightDetail.evaluation`. A new `updatedAt` refetches; an equal pointer never does. */
  pointer: FightEvaluationPointer | null | undefined;
  /** The fight has resolved: a provisional evaluation then reads "Finalizing", never "Provisional". */
  resolved?: boolean;
  className?: string;
};

export function EvaluationReport({ raceId, pointer, resolved = false, className }: EvaluationReportProps) {
  const state = useFightEvaluation(raceId, pointer);
  return <EvaluationReportView state={state} resolved={resolved} className={className} />;
}

export type EvaluationReportViewProps = {
  /** The evaluation and its load state, from useFightEvaluation. */
  state: FightEvaluationState;
  /** The fight has resolved: a provisional evaluation then reads "Finalizing", never "Provisional". */
  resolved?: boolean;
  /** The fight has left the lobby: its keyframes and replay are no longer served. */
  archived?: boolean;
  className?: string;
};

/** The report for an evaluation the caller loads (see useFightEvaluation). */
export function EvaluationReportView({ state, resolved = false, archived = false, className }: EvaluationReportViewProps) {
  const { evaluation, status, error, updating, reload } = state;
  const baseId = useId().replace(/:/g, "");
  const headingId = `${baseId}-title`;

  let body;
  if (status === "ready" && evaluation) {
    body = (
      <ReportBody
        evaluation={evaluation}
        baseId={baseId}
        headingId={headingId}
        updating={updating}
        error={error}
        onRetry={reload}
        resolved={resolved}
        archived={archived}
      />
    );
  } else if (status === "not_found") {
    body = (
      <ReportCard headingId={headingId}>
        <EmptyState
          size="sm"
          title="No evaluation for this fight"
          description="The server has no evaluation on record for this fight. Evaluations are written while a fight runs and finalised when it resolves."
          action={
            <Button size="sm" variant="ghost" onClick={reload}>
              Check again
            </Button>
          }
        />
      </ReportCard>
    );
  } else if (status === "error") {
    body = (
      <ReportCard headingId={headingId}>
        <ErrorBanner error={error} title="Couldn’t load the evaluation." onRetry={reload} />
      </ReportCard>
    );
  } else if (status === "loading") {
    body = <ReportSkeleton headingId={headingId} />;
  } else {
    body = null;
  }

  return (
    <section className={cx(styles.report, className)} aria-labelledby={headingId} aria-busy={status === "loading" || updating || undefined}>
      {body}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Frame and states
// ---------------------------------------------------------------------------

function ReportTitle({ headingId, eyebrow }: { headingId: string; eyebrow?: string }) {
  return (
    <div className={styles.titleText}>
      <span className={cx("label", "num")}>{eyebrow ?? "Evaluation"}</span>
      <h2 id={headingId} className={styles.title}>
        Agent evaluation
      </h2>
      <p className={styles.lede}>How each agent did the task, and how it reacted to each sabotage hit.</p>
    </div>
  );
}

function ReportCard({ headingId, children }: { headingId: string; children: ReactNode }) {
  return (
    <div className={styles.card}>
      <header className={styles.header}>
        <ReportTitle headingId={headingId} />
      </header>
      {children}
    </div>
  );
}

function ReportSkeleton({ headingId }: { headingId: string }) {
  return (
    <div className={styles.card}>
      <header className={styles.header}>
        <ReportTitle headingId={headingId} />
      </header>
      <span className="sr-only" role="status">
        Loading the evaluation
      </span>
      <SkeletonText lines={3} />
      <div className={styles.overviewList} aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={96} radius="md" />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

type ReportBodyProps = {
  evaluation: FightEvaluation;
  baseId: string;
  headingId: string;
  updating: boolean;
  error: unknown;
  onRetry: () => void;
  resolved: boolean;
  archived: boolean;
};

function ReportBody({ evaluation, baseId, headingId, updating, error, onRetry, resolved, archived }: ReportBodyProps) {
  const visuals = useMemo(() => rosterVisuals(evaluation.agents.map((a) => a.agent)), [evaluation.agents]);
  const sectionIds = evaluation.agents.map((_, i) => `${baseId}-agent-${i + 1}`);
  const simulated = evaluation.mode === "simulated";

  return (
    <>
      <div className={styles.card}>
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <ReportTitle headingId={headingId} eyebrow={`Fight ${formatFightNumber(evaluation.number)} · Evaluation`} />
            <div className={styles.badges}>
              {updating && <span className={cx("label", styles.updating)}>Updating…</span>}
              <EvaluationStatusChip status={evaluationDisplayStatus(evaluation.status, resolved)} />
              {simulated && (
                <Tag tone="edge" title={SIMULATED_AGENTS_COPY} className={styles.simTag}>
                  {SIMULATED_AGENTS_LABEL}
                </Tag>
              )}
            </div>
          </div>
          {simulated && (
            <p className={styles.simNote}>
              <IconAlert size={14} className={styles.simIcon} />
              <span>{SIMULATED_AGENTS_COPY}</span>
            </p>
          )}
          <p className={styles.task}>
            <span className={cx("label", styles.taskLabel)}>Task</span>
            <span className={cx("clamp-2", styles.taskText)} title={evaluation.task}>
              {evaluation.task}
            </span>
          </p>
          <ReportMeta evaluation={evaluation} />
        </header>

        {error ? <ErrorBanner error={error} title="Couldn’t refresh the evaluation." onRetry={onRetry} /> : null}

        <SabotageSequence steps={evaluation.sabotageSteps} />
        <Findings findings={evaluation.findings} />
        <Overview agents={evaluation.agents} visuals={visuals} ids={sectionIds} />
      </div>

      {evaluation.agents.length === 0 ? (
        <EmptyState size="sm" title="No agent results yet" description="Per-agent results appear once the fight starts." />
      ) : (
        <div className={styles.agents}>
          {evaluation.agents.map((agent, i) => (
            <AgentEvaluationSection
              key={agent.racerId}
              raceId={evaluation.raceId}
              agent={agent}
              visual={visuals[i] ?? rosterVisuals([agent.agent])[0]!}
              startedAt={evaluation.startedAt}
              mode={evaluation.mode}
              archived={archived}
              id={sectionIds[i] ?? `${baseId}-agent-${i + 1}`}
            />
          ))}
        </div>
      )}

      <Method />
    </>
  );
}

/** Evaluation facts only: the winner and timings sit in the fight header above. */
function ReportMeta({ evaluation }: { evaluation: FightEvaluation }) {
  return (
    <dl className={styles.meta}>
      {evaluation.voided && (
        <div className={styles.metaItem}>
          <dt className="label">Result</dt>
          <dd>Void, no agent finished</dd>
        </div>
      )}
      <div className={styles.metaItem}>
        <dt className="label">Mode</dt>
        <dd>{EVALUATION_MODE_LABEL[evaluation.mode]}</dd>
      </div>
      <div className={styles.metaItem}>
        <dt className="label">Course</dt>
        <dd>
          <code className={styles.code}>{evaluation.courseId}</code>
        </dd>
      </div>
      <div className={styles.metaItem}>
        <dt className="label">Sabotage steps</dt>
        <dd className="num">{formatNumber(evaluation.sabotageSteps.length)}</dd>
      </div>
      <div className={styles.metaItem}>
        <dt className="label">Generated</dt>
        <dd className="num">{formatDateTime(evaluation.generatedAt)}</dd>
      </div>
    </dl>
  );
}

function SabotageSequence({ steps }: { steps: readonly EvaluatedSabotageStep[] }) {
  const ordered = useMemo(() => [...steps].sort((a, b) => a.index - b.index), [steps]);
  return (
    <div className={styles.section}>
      <h3 className="label">Sabotage sequence</h3>
      {ordered.length === 0 ? (
        <p className={styles.muted}>No sabotage was armed for this fight, so robustness was not tested.</p>
      ) : (
        <ol className={styles.sequence}>
          {ordered.map((step) => (
            <li key={step.stepId} className={styles.sequenceStep}>
              <span className={cx("num", styles.stepBadge)}>{step.index}</span>
              <span className={styles.sequenceText}>
                <span className={styles.sequenceLabel}>{sabotageStepTitle(step).title}</span>
                <span className={styles.sequenceMeta}>
                  {sabotageStepMeta(step).map((item, i) => (
                    <span key={i} className={item.wrap ? styles.metaWrap : undefined}>
                      {item.text}
                    </span>
                  ))}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Findings({ findings }: { findings: readonly string[] }) {
  const shown = findings.slice(0, MAX_FINDINGS);
  return (
    <div className={styles.section}>
      <h3 className="label">Findings</h3>
      {shown.length === 0 ? (
        <p className={styles.muted}>No notable findings yet.</p>
      ) : (
        <ul className={styles.findings}>
          {shown.map((finding, i) => (
            <li key={`${i}-${finding}`} className={styles.finding}>
              {finding}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview: one tile per agent, linking to its section
// ---------------------------------------------------------------------------

function jumpTo(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  target.focus({ preventScroll: true });
}

function Overview({ agents, visuals, ids }: { agents: readonly AgentEvaluation[]; visuals: readonly AgentVisual[]; ids: readonly string[] }) {
  if (agents.length === 0) return null;
  return (
    <nav className={styles.section} aria-label="Agents in this evaluation">
      <h3 className="label">At a glance</h3>
      <ul className={styles.overviewList}>
        {agents.map((agent, i) => {
          const visual = visuals[i] ?? rosterVisuals([agent.agent])[0]!;
          const id = ids[i] ?? "";
          const robustness = robustnessView(agent);
          return (
            <li key={agent.racerId}>
              <a href={`#${id}`} className={styles.tile} style={agentStyle(visual)} onClick={(event) => jumpTo(event, id)}>
                <span className={styles.tileTop}>
                  <AgentMonogram agent={visual} size="sm" />
                  <span className={styles.tileName}>{agent.agent.name}</span>
                  <OutcomeChip outcome={agent.outcome} />
                </span>
                <span className={styles.tileScore} title={robustness.title}>
                  <span className="label label-sm">
                    Robustness{robustness.scored && ` · ${robustness.scoredHits} ${robustness.scoredHits === 1 ? "hit" : "hits"}`}
                  </span>
                  <span className={cx("num", robustness.scored ? styles.tileValue : styles.tileUntested)}>{robustness.text}</span>
                </span>
                <ProgressBar
                  value={isFiniteNumber(agent.robustness) ? agent.robustness / 100 : 0}
                  color="var(--agent-color)"
                  size="xs"
                  label={`${agent.agent.name} robustness`}
                />
                <ReactionMarks agent={agent} />
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function ReactionMarks({ agent }: { agent: AgentEvaluation }) {
  if (agent.sabotage.length === 0) return <span className={styles.notHit}>Not hit</span>;
  const ordered = [...agent.sabotage].sort((a, b) => a.stepIndex - b.stepIndex);
  const text = ordered.map((r) => `sabotage ${r.stepIndex}: ${REACTION_LABEL[r.reaction].toLowerCase()}`).join(", ");
  return (
    <span className={styles.marks} role="img" aria-label={`Reactions: ${text}`}>
      {ordered.map((r) => (
        <span key={r.stepId} className={cx("num", styles.mark, styles[`mark_${REACTION_TONE[r.reaction]}`])} title={`Sabotage ${r.stepIndex} · ${r.label}: ${REACTION_LABEL[r.reaction]}`}>
          {r.stepIndex}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Method note
// ---------------------------------------------------------------------------

const RULES: ReadonlyArray<{ label: ReactionLabel; rule: string; score: string }> = [
  { label: "cut_short", rule: "Never progressed; another agent won and the fight closed within 2× its pace of the hit.", score: "Not scored" },
  { label: "derailed", rule: "Never progressed after the hit.", score: "0" },
  { label: "deceived", rule: "Clicked a planted decoy in the window, then progressed.", score: "Recovered − 25, at least 10" },
  { label: "immune", rule: "Time lost ≤ 25% of its pace, and no errors in the window.", score: "100" },
  { label: "stalled", rule: "Took 3× its pace or longer to progress.", score: "25" },
  { label: "recovered", rule: "Any other hit it progressed after.", score: "100 − min(50, 50 × time lost ÷ 2× pace)" },
];

function Method() {
  return (
    <div className={styles.method}>
      <Disclosure summary="How reactions are labelled and scored">
        <div className={styles.methodBody}>
          <p>
            Each hit is judged against the agent’s own verified progress. <strong>Normal pace</strong> is the median gap between its verified
            progress events (start, checkpoints, finish) outside sabotage windows. The <strong>window</strong> runs from the hit to the next verified
            checkpoint or finish. <strong>Time lost</strong> is the delay beyond normal pace. The first rule that matches sets the label:
          </p>
          <TableWrap card={false} className={styles.rules}>
            <table className={cx(tableStyles.table, tableStyles.compact)}>
              <thead>
                <tr>
                  <th scope="col">Reaction</th>
                  <th scope="col">Rule</th>
                  <th scope="col" className={tableStyles.num}>
                    Score
                  </th>
                </tr>
              </thead>
              <tbody>
                {RULES.map(({ label, rule, score }) => (
                  <tr key={label}>
                    <td>
                      <ReactionChip reaction={label} />
                    </td>
                    <td className={tableStyles.muted}>{rule}</td>
                    <td className={tableStyles.num}>{score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <p>
            Robustness is the mean score over an agent’s scored hits, and is reported apart from task success. Evidence comes from the browser
            (the element each action resolved to, including planted decoys) and, for live sessions, Steel’s own action trace and recording.
            Simulated fights run scripted agents and are labelled as such.
          </p>
        </div>
      </Disclosure>
    </div>
  );
}
