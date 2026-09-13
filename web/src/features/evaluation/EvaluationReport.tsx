/**
 * A fight's results, from its evaluation (GET /api/fights/:raceId/evaluation,
 * refetched when the fight's evaluation pointer changes): the findings, then
 * one row per agent in finishing order with its outcome, checkpoints, its
 * reaction to each sabotage step and its robustness. A row opens to that
 * agent's hits, their evidence and its action trace.
 *
 * Rendered by the resolved-fight screen (features/settled), and as
 * EvaluationReportView by the screen for a fight that has left the lobby,
 * which loads the evaluation itself. It renders no Page of its own.
 */
import { useId, useMemo, useState } from "react";
import type { AgentEvaluation, EvaluatedSabotageStep, FightEvaluation, FightEvaluationPointer } from "@contract";
import { AgentMonogram, Button, ErrorBanner, IconChevronRight, ProgressBar, Skeleton, Tag } from "../../components";
import { agentStyle, rosterVisuals, type AgentVisual } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { EMPTY, formatNumber } from "../../lib/format";
import { SIMULATED_AGENTS_COPY, SIMULATED_AGENTS_LABEL } from "../../lib/labels";
import { EvaluationStatusChip, OutcomeChip, ReactionChip } from "./Chip";
import { evaluationDisplayStatus, formatCheckpoint, rankAgents, robustnessView, sabotageStepTitle } from "./format";
import { SabotageTimeline } from "./SabotageTimeline";
import { FullTrace } from "./TraceTables";
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

/** The results for an evaluation the caller loads (see useFightEvaluation). */
export function EvaluationReportView({ state, resolved = false, archived = false, className }: EvaluationReportViewProps) {
  const { evaluation, status, error, updating, reload } = state;
  const headingId = `${useId().replace(/:/g, "")}-results`;
  if (status === "idle") return null;
  const shown = status === "ready" ? evaluation : null;

  let body;
  if (shown) {
    body = <ReportBody evaluation={shown} error={error} onRetry={reload} archived={archived} />;
  } else if (status === "not_found") {
    body = (
      <p className={styles.note}>
        No results were recorded for this fight.
        <Button size="sm" variant="ghost" onClick={reload}>
          Check again
        </Button>
      </p>
    );
  } else if (status === "error") {
    body = (
      <div className={styles.pad}>
        <ErrorBanner error={error} title="Couldn’t load the results." onRetry={reload} />
      </div>
    );
  } else {
    body = <ReportSkeleton />;
  }

  return (
    <section className={cx(styles.card, className)} aria-labelledby={headingId} aria-busy={status === "loading" || updating || undefined}>
      <header className={styles.header}>
        <h2 id={headingId} className={styles.title}>
          Results
        </h2>
        {shown && <Badges evaluation={shown} updating={updating} resolved={resolved} />}
      </header>
      {body}
    </section>
  );
}

/** Only what qualifies the figures: a refresh in flight, a report that isn't final yet, scripted agents. */
function Badges({ evaluation, updating, resolved }: { evaluation: FightEvaluation; updating: boolean; resolved: boolean }) {
  const status = evaluationDisplayStatus(evaluation.status, resolved);
  return (
    <div className={styles.badges}>
      {updating && <span className={cx("label", styles.updating)}>Updating…</span>}
      {status !== "final" && <EvaluationStatusChip status={status} />}
      {evaluation.mode === "simulated" && (
        <Tag tone="edge" title={SIMULATED_AGENTS_COPY}>
          {SIMULATED_AGENTS_LABEL}
        </Tag>
      )}
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className={styles.pad}>
      <span className="sr-only" role="status">
        Loading the results
      </span>
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} height={32} radius="md" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

type ReportBodyProps = {
  evaluation: FightEvaluation;
  error: unknown;
  onRetry: () => void;
  archived: boolean;
};

function ReportBody({ evaluation, error, onRetry, archived }: ReportBodyProps) {
  const steps = useMemo(() => [...evaluation.sabotageSteps].sort((a, b) => a.index - b.index), [evaluation.sabotageSteps]);
  const findings = evaluation.findings.slice(0, MAX_FINDINGS);

  return (
    <>
      {error ? (
        <div className={styles.pad}>
          <ErrorBanner error={error} title="Couldn’t refresh the results." onRetry={onRetry} />
        </div>
      ) : null}
      {findings.length > 0 && (
        <div className={styles.findings}>
          <ul className={styles.findingList}>
            {findings.map((finding, i) => (
              <li key={`${i}-${finding}`}>{finding}</li>
            ))}
          </ul>
        </div>
      )}
      {evaluation.agents.length === 0 ? (
        <p className={styles.note}>Per-agent results appear once the fight starts.</p>
      ) : (
        <Standings evaluation={evaluation} steps={steps} archived={archived} />
      )}
      <SabotageLegend steps={steps} />
    </>
  );
}

/** "Shift the primary action at Checkpoint 1 · Product found". */
function stepText(step: EvaluatedSabotageStep): string {
  return `${sabotageStepTitle(step).title} at ${formatCheckpoint(step.checkpoint, step.checkpointLabel)}`;
}

// ---------------------------------------------------------------------------
// Standings: one row per agent, opening to its hits and trace
// ---------------------------------------------------------------------------

type StandingsProps = {
  evaluation: FightEvaluation;
  steps: readonly EvaluatedSabotageStep[];
  archived: boolean;
};

function Standings({ evaluation, steps, archived }: StandingsProps) {
  const baseId = useId().replace(/:/g, "");
  // Colours follow racer order, as everywhere else in the app, not finishing order.
  const visuals = useMemo(() => {
    const roster = rosterVisuals(evaluation.agents.map((agent) => agent.agent));
    return new Map(evaluation.agents.map((agent, i) => [agent.racerId, roster[i] ?? rosterVisuals([agent.agent])[0]!]));
  }, [evaluation.agents]);
  const ranked = useMemo(() => rankAgents(evaluation.agents), [evaluation.agents]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (racerId: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(racerId)) next.add(racerId);
      return next;
    });

  return (
    <div className={styles.standings}>
      <div className={styles.head} aria-hidden="true">
        <span>Agent</span>
        <span>Checkpoints</span>
        <span>Sabotage</span>
        <span className={styles.headScore}>Robustness</span>
      </div>
      <ul className={styles.rows} aria-label="Agents in finishing order">
        {ranked.map((agent) => (
          <AgentRow
            key={agent.racerId}
            raceId={evaluation.raceId}
            agent={agent}
            visual={visuals.get(agent.racerId)!}
            steps={steps}
            startedAt={evaluation.startedAt}
            archived={archived}
            open={open.has(agent.racerId)}
            onToggle={() => toggle(agent.racerId)}
            detailId={`${baseId}-${agent.racerId}`}
          />
        ))}
      </ul>
    </div>
  );
}

type AgentRowProps = {
  raceId: string;
  agent: AgentEvaluation;
  /** From rosterVisuals(), so colours never collide within a fight. */
  visual: AgentVisual;
  steps: readonly EvaluatedSabotageStep[];
  /** Fight start, for times into the fight in the trace. */
  startedAt: number | null;
  archived: boolean;
  open: boolean;
  onToggle: () => void;
  detailId: string;
};

function AgentRow({ raceId, agent, visual, steps, startedAt, archived, open, onToggle, detailId }: AgentRowProps) {
  const name = agent.agent.name;
  const robustness = robustnessView(agent);
  const hits = steps.flatMap((step) => {
    const reaction = agent.sabotage.find((r) => r.stepId === step.stepId);
    return reaction ? [{ step, reaction }] : [];
  });
  const markers =
    agent.checkpointCount > 0
      ? steps.map((step) => ({ at: step.checkpoint / agent.checkpointCount, tone: "sabotage" as const, label: `Sabotage ${step.index}` }))
      : undefined;

  return (
    <li className={cx(styles.agent, agent.outcome === "won" && styles.won)} style={agentStyle(visual)}>
      {/* The whole row opens the agent. The button is its keyboard and screen-reader control; its click bubbles here. */}
      <div className={styles.row} onClick={onToggle}>
        <span className={styles.who}>
          <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={open ? detailId : undefined}>
            <IconChevronRight size={12} className={styles.chevron} />
            <AgentMonogram agent={visual} size="sm" />
            <span className={styles.name}>{name}</span>
          </button>
          <OutcomeChip outcome={agent.outcome} />
        </span>
        <span className={styles.progress}>
          <ProgressBar
            value={agent.checkpointCount > 0 ? agent.checkpointsReached / agent.checkpointCount : 0}
            color="var(--agent-color)"
            markers={markers}
            size="xs"
            className={styles.bar}
            label={`${name} checkpoints`}
          />
          <span className="num">
            {formatNumber(agent.checkpointsReached)}/{formatNumber(agent.checkpointCount)}
          </span>
        </span>
        <span className={styles.hits}>
          <span className="sr-only">Sabotage: </span>
          {hits.length === 0 ? (
            <span className={styles.none}>Not hit</span>
          ) : (
            hits.map(({ step, reaction }) => (
              <span key={step.stepId} className={styles.hit} title={stepText(step)}>
                <span className={cx("num", styles.stepBadge)}>{step.index}</span>
                <ReactionChip reaction={reaction.reaction} />
              </span>
            ))
          )}
        </span>
        <span className={styles.score} title={robustness.title}>
          <span className={styles.scoreLabel}>Robustness</span>
          <span className={cx("num", robustness.scored ? styles.scoreValue : styles.none)}>{robustness.scored ? robustness.text : EMPTY}</span>
        </span>
      </div>
      {open && (
        <div id={detailId} className={styles.detail}>
          <SabotageTimeline raceId={raceId} agent={agent} archived={archived} />
          <FullTrace agent={agent} startedAt={startedAt} />
        </div>
      )}
    </li>
  );
}

/** What each numbered step in the Sabotage column was. */
function SabotageLegend({ steps }: { steps: readonly EvaluatedSabotageStep[] }) {
  if (steps.length === 0) return <p className={styles.legendNone}>No sabotage in this fight.</p>;
  return (
    <div className={styles.legend}>
      <ol className={styles.legendList} aria-label="Sabotage steps">
        {steps.map((step) => (
          <li key={step.stepId} className={styles.legendItem}>
            <span className={cx("num", styles.stepBadge)}>{step.index}</span>
            <span className={styles.legendTitle}>{sabotageStepTitle(step).title}</span>
            <span>at {formatCheckpoint(step.checkpoint, step.checkpointLabel)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
