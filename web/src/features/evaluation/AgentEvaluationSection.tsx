/**
 * One agent in the evaluation report: identity and outcome, robustness, the
 * run's figures, the one-line summary, the crowd's YES price around the
 * first hit, the sabotage timeline and the full action trace.
 */
import type { ReactNode } from "react";
import type { AgentCrowdSignal, AgentEvaluation } from "@contract";
import { AgentMonogram, ChangeCents, PriceCents, ProgressBar } from "../../components";
import { agentModelLabel, agentStyle, type AgentVisual } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { formatDuration, formatNumber, isFiniteNumber } from "../../lib/format";
import { OutcomeChip } from "./Chip";
import { formatRobustness, formatSeconds } from "./format";
import { SabotageTimeline } from "./SabotageTimeline";
import { FullTrace } from "./TraceTables";
import styles from "./AgentEvaluation.module.css";

export type AgentEvaluationSectionProps = {
  raceId: string;
  agent: AgentEvaluation;
  /** From rosterVisuals(), so colours never collide within a fight. */
  visual: AgentVisual;
  /** Fight start, for times into the fight. */
  startedAt: number | null;
  /** Element id, the target of the report overview's links. */
  id: string;
};

export function AgentEvaluationSection({ raceId, agent, visual, startedAt, id }: AgentEvaluationSectionProps) {
  const headingId = `${id}-name`;
  const model = agentModelLabel(agent.agent);
  return (
    <section id={id} className={styles.agent} style={agentStyle(visual)} aria-labelledby={headingId} tabIndex={-1}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <AgentMonogram agent={visual} size="lg" />
          <div className={styles.identityText}>
            <div className={styles.nameRow}>
              <h3 id={headingId} className={styles.name}>
                {agent.agent.name}
              </h3>
              <OutcomeChip outcome={agent.outcome} size="lg" />
            </div>
            <span className={styles.model} title={model}>
              {model}
            </span>
          </div>
        </div>
        <Robustness value={agent.robustness} name={agent.agent.name} />
      </header>

      <dl className={styles.stats}>
        <Stat label="Duration" title="Start to verified finish">
          {agent.durationMs === null ? "Did not finish" : formatDuration(agent.durationMs)}
        </Stat>
        <Stat label="Checkpoints" title="Verified checkpoints reached">
          {formatNumber(agent.checkpointsReached)}/{formatNumber(agent.checkpointCount)}
        </Stat>
        <Stat label="Steps" title="Actions used, of the action budget">
          {formatNumber(agent.steps)}/{formatNumber(agent.maxSteps)}
        </Stat>
        <Stat label="Errors" title="Steps that ended in an error">
          {formatNumber(agent.errors)}
        </Stat>
        <Stat label="Loops" title="Episodes of three or more identical consecutive steps">
          {formatNumber(agent.loops)}
        </Stat>
        <Stat label="Normal pace" title="Median time between verified progress events outside sabotage windows">
          {formatSeconds(agent.paceMs)}
        </Stat>
      </dl>

      <p className={styles.summary}>{agent.summary}</p>
      <CrowdLine crowd={agent.crowd} />

      <div className={styles.block}>
        <h4 className="label">Sabotage timeline</h4>
        <SabotageTimeline raceId={raceId} agent={agent} startedAt={startedAt} />
      </div>

      <div className={styles.footer}>
        <FullTrace agent={agent} startedAt={startedAt} />
      </div>
    </section>
  );
}

function Stat({ label, title, negative = false, children }: { label: string; title?: string; negative?: boolean; children: ReactNode }) {
  return (
    <div className={styles.stat} title={title}>
      <dt className="label label-sm">{label}</dt>
      <dd className={cx("num", styles.statValue, negative && styles.negative)}>{children}</dd>
    </div>
  );
}

function Robustness({ value, name }: { value: number | null; name: string }) {
  const tested = isFiniteNumber(value);
  return (
    <div className={styles.robustness} title="Mean reaction score over scored hits, 0 to 100">
      <span className="label">Robustness</span>
      <span className={cx("num", styles.robustnessValue, !tested && styles.notTested)}>
        {formatRobustness(value)}
        {tested && <span className={styles.outOf}>/100</span>}
      </span>
      {tested && <ProgressBar value={value / 100} color="var(--agent-color)" size="xs" className={styles.robustnessBar} label={`${name} robustness`} />}
    </div>
  );
}

function CrowdLine({ crowd }: { crowd: AgentCrowdSignal }) {
  const shift = crowd.beforeFirstHitYes !== null && crowd.afterFirstHitYes !== null ? crowd.afterFirstHitYes - crowd.beforeFirstHitYes : null;
  return (
    <div className={styles.crowd}>
      <span className="label" title="The market’s YES price for this agent">
        Crowd YES
      </span>
      <ol className={styles.crowdPoints}>
        <CrowdPoint label="Opening" title="YES price at the start" value={crowd.openingYes} />
        <CrowdPoint label="Before hit" title="Just before the first sabotage hit" value={crowd.beforeFirstHitYes} />
        <CrowdPoint label="After hit" title="30 s after the first hit" value={crowd.afterFirstHitYes}>
          {shift !== null && <ChangeCents value={shift} />}
        </CrowdPoint>
        <CrowdPoint label="Final" title="When the fight resolved, or the latest while live" value={crowd.finalYes} />
      </ol>
    </div>
  );
}

function CrowdPoint({ label, title, value, children }: { label: string; title: string; value: number | null; children?: ReactNode }) {
  return (
    <li className={styles.crowdPoint} title={title}>
      <span className={styles.crowdLabel}>{label}</span>
      <PriceCents value={value} size="md" tone={value === null ? "muted" : "default"} />
      {children}
    </li>
  );
}
