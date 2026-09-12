/**
 * Stacked lane (layout B): identity + step, action, ETA and price on top; a
 * full-width checkpoint track beneath. The lane is a button that expands the agent.
 */
import { Fragment } from "react";
import type { AgentCheckpointState, FightAgentDetail, FightDetail } from "@contract";
import { AgentMonogram, ChangeCents, PriceCents, Tag } from "../../components";
import { agentStyle, type AgentVisual } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { EMPTY, formatCents, formatLogTime } from "../../lib/format";
import { SIDE_LABEL } from "../../lib/labels";
import type { Slip } from "../market/types";
import { agentStatusView, checkpointDot, formatEta, formatStep } from "./fightView";
import { StatusTag } from "./AgentStatus";
import styles from "./AgentLane.module.css";

export type AgentLaneProps = {
  fight: FightDetail;
  agent: FightAgentDetail;
  visual: AgentVisual;
  slip: Slip | null;
  onOpen: (racerId: string) => void;
  buttonRef: (racerId: string, el: HTMLButtonElement | null) => void;
};

export function AgentLane({ fight, agent, visual, slip, onOpen, buttonRef }: AgentLaneProps) {
  const status = agentStatusView(agent);
  const step = formatStep(agent.step, agent.maxSteps);
  const eta = formatEta(agent.etaMs, agent.phase);
  const inSlip = slip?.racerId === agent.racerId;
  const name = agent.agent.name;
  const action = agent.currentAction ?? (fight.status === "upcoming" ? "Waiting to start" : EMPTY);

  return (
    <button
      ref={(el) => buttonRef(agent.racerId, el)}
      type="button"
      className={cx(styles.lane, inSlip && styles.inSlip)}
      style={agentStyle(visual)}
      onClick={() => onOpen(agent.racerId)}
      aria-label={`${name}: ${status.label}, step ${step}, ${agent.checkpoint} of ${fight.checkpointCount} checkpoints, ETA ${eta}, YES ${formatCents(agent.yes)}. Expand browser view`}
    >
      <span className={styles.top}>
        <span className={styles.identity}>
          <AgentMonogram agent={visual} size="sm" />
          <span className={styles.name}>{name}</span>
        </span>
        <StatusTag view={status} />
        <span className={styles.meta}>
          <span className="num">
            <span className={styles.metaKey}>Step</span> {step}
          </span>
          <span className={styles.metaAction} title={agent.currentAction ?? undefined}>
            {action}
          </span>
          <span className="num">
            <span className={styles.metaKey}>ETA</span> {eta}
          </span>
        </span>
        {inSlip && slip && <Tag tone="edge">Slip · {SIDE_LABEL[slip.side]}</Tag>}
        <span className={styles.price}>
          <PriceCents value={agent.yes} size="lg" flash />
          <ChangeCents value={agent.change} />
        </span>
      </span>
      <CheckpointTrack checkpoints={agent.checkpoints} />
    </button>
  );
}

function dotTitle(c: AgentCheckpointState): string {
  const parts = [`${c.index}. ${c.label}`];
  if (c.isSabotage) parts.push(c.sabotageFired ? "sabotage fired here" : "sabotage point");
  parts.push(c.state === "cleared" ? `cleared${c.clearedAt ? ` ${formatLogTime(c.clearedAt)}` : ""}` : "pending");
  return parts.join(" · ");
}

export function CheckpointTrack({ checkpoints, className }: { checkpoints: AgentCheckpointState[]; className?: string }) {
  const cleared = checkpoints.filter((c) => c.state === "cleared").length;
  return (
    <span className={cx(styles.track, className)} role="img" aria-label={`${cleared} of ${checkpoints.length} checkpoints cleared`}>
      {checkpoints.map((c, i) => (
        <Fragment key={c.index}>
          {i > 0 && <span className={cx(styles.segment, c.state === "cleared" && styles.segmentCleared)} />}
          <span className={cx(styles.dot, styles[checkpointDot(c)])} title={dotTitle(c)} />
        </Fragment>
      ))}
    </span>
  );
}
