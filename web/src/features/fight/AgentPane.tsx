/**
 * Quadrant-grid pane (layout A): status band, identity + price, live capture,
 * progress bar. The whole pane is a button that expands the agent.
 */
import type { FightAgentDetail, FightDetail } from "@contract";
import { AgentMonogram, ChangeCents, PriceCents, ProgressBar, Tag, type ProgressMarker } from "../../components";
import { agentStyle, type AgentVisual } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { formatCents } from "../../lib/format";
import { SIDE_LABEL } from "../../lib/labels";
import type { Slip } from "../market/types";
import { agentStatusView, formatStep } from "./fightView";
import { StatusBand } from "./AgentStatus";
import { LiveCapture } from "./LiveCapture";
import styles from "./AgentPane.module.css";

export type AgentPaneProps = {
  fight: FightDetail;
  agent: FightAgentDetail;
  visual: AgentVisual;
  slip: Slip | null;
  markers: ProgressMarker[];
  onOpen: (racerId: string) => void;
  buttonRef: (racerId: string, el: HTMLButtonElement | null) => void;
};

export function AgentPane({ fight, agent, visual, slip, markers, onOpen, buttonRef }: AgentPaneProps) {
  const status = agentStatusView(agent);
  const step = formatStep(agent.step, agent.maxSteps);
  const inSlip = slip?.racerId === agent.racerId;
  const name = agent.agent.name;

  return (
    <button
      ref={(el) => buttonRef(agent.racerId, el)}
      type="button"
      className={cx(styles.pane, inSlip && styles.inSlip)}
      style={agentStyle(visual)}
      onClick={() => onOpen(agent.racerId)}
      aria-label={`${name}: ${status.label}, step ${step}, ${agent.checkpoint} of ${fight.checkpointCount} checkpoints, YES ${formatCents(agent.yes)}. Expand browser view`}
    >
      <StatusBand view={status} step={step} />

      <span className={styles.identity}>
        <AgentMonogram agent={visual} size="sm" />
        <span className={styles.name}>{name}</span>
        {inSlip && slip && (
          <Tag tone="edge" className={styles.slipTag}>
            Slip · {SIDE_LABEL[slip.side]}
          </Tag>
        )}
        <span className={styles.price}>
          <PriceCents value={agent.yes} size="lg" flash />
          <ChangeCents value={agent.change} />
        </span>
      </span>

      <LiveCapture
        raceId={fight.raceId}
        racerId={agent.racerId}
        frame={agent.frame}
        fightStatus={fight.status}
        startsAt={fight.startsAt}
        agentName={name}
        className={styles.capture}
      />

      <span className={styles.progressRow}>
        <ProgressBar value={agent.progress} color="var(--agent-color)" markers={markers} size="sm" className={styles.progress} />
        <span className={cx("num", styles.progressText)}>
          {agent.checkpoint}/{fight.checkpointCount}
        </span>
      </span>
    </button>
  );
}
