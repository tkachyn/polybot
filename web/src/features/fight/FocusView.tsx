/**
 * Expanded agent view: replaces the arena with one agent. Header (logo, name,
 * price, Close), capture with the live URL overlaid, timestamped action log,
 * status line and progress bar.
 */
import { agentModelLabel } from "../../lib/agents";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ActionLogEntry, FightAgentDetail, FightDetail } from "@contract";
import { AgentMonogram, Button, ChangeCents, IconClose, PriceCents, ProgressBar, Tag, type ProgressMarker } from "../../components";
import { agentStyle, type AgentVisual } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { EMPTY, formatLogTime } from "../../lib/format";
import { ACTION_LOG_KIND_LABEL, SIDE_LABEL } from "../../lib/labels";
import type { Slip } from "../market/types";
import { agentStatusView, formatEta, formatStep, isAgentActive, isAgentUnderSabotage, isRaceOver } from "./fightView";
import { StatusTag } from "./AgentStatus";
import { LiveCapture } from "./LiveCapture";
import styles from "./FocusView.module.css";

export type FocusViewProps = {
  fight: FightDetail;
  agent: FightAgentDetail;
  visual: AgentVisual;
  slip: Slip | null;
  markers: ProgressMarker[];
  onClose: () => void;
};

export function FocusView({ fight, agent, visual, slip, markers, onClose }: FocusViewProps) {
  const status = agentStatusView(agent);
  const inSlip = slip?.racerId === agent.racerId;
  const sabotageActive = isAgentUnderSabotage(agent.phase);
  const name = agent.agent.name;
  const closeRef = useRef<HTMLButtonElement>(null);

  // Move keyboard focus into the expanded view when it opens.
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <section
      className={cx(styles.focus, inSlip && styles.inSlip)}
      style={agentStyle(visual)}
      aria-label={`${name}, expanded view${sabotageActive ? ", sabotage active" : ""}`}
    >
      <header className={styles.header}>
        <AgentMonogram agent={visual} size="md" />
        <div className={styles.identity}>
          <h2 className={styles.name}>{name}</h2>
          <span className={styles.model}>
            {agentModelLabel(agent.agent)}
          </span>
        </div>
        {inSlip && slip && <Tag tone="edge">Slip · {SIDE_LABEL[slip.side]}</Tag>}
        <span className={styles.price}>
          <span className="label label-sm">Yes</span>
          <PriceCents value={agent.yes} size="xl" flash />
          <ChangeCents value={agent.change} />
        </span>
        <Button ref={closeRef} size="sm" variant="ghost" icon={<IconClose size={12} />} onClick={onClose} aria-keyshortcuts="Escape" title="Close (Esc)">
          Close
        </Button>
      </header>

      <div className={styles.body}>
        <LiveCapture
          raceId={fight.raceId}
          racerId={agent.racerId}
          frame={agent.frame}
          browserView={agent.browserView}
          fightStatus={fight.status}
          startsAt={fight.startsAt}
          agentName={name}
          sabotageActive={sabotageActive}
          final={!isAgentActive(agent.phase) || isRaceOver(fight)}
          className={styles.capture}
          overlay={
            <span className={styles.url} title={agent.url ?? undefined}>
              {agent.url ?? "No page loaded"}
            </span>
          }
        />
        <ActionLog entries={agent.log} agentName={name} recovering={agent.phase === "recovering"} />
      </div>

      <footer className={styles.footer}>
        <div className={styles.statusLine}>
          <StatusTag view={status} />
          <span className="num">
            <span className={styles.key}>Step</span> {formatStep(agent.step, agent.maxSteps)}
          </span>
          <span className={styles.action} title={agent.currentAction ?? undefined}>
            {agent.currentAction ?? (fight.status === "upcoming" ? "Waiting to start" : EMPTY)}
          </span>
          <span className="num">
            <span className={styles.key}>ETA</span> {formatEta(agent.etaMs, agent.phase)}
          </span>
          <span className="num">
            <span className={styles.key}>Checkpoints</span> {agent.checkpoint}/{fight.checkpointCount}
          </span>
        </div>
        <ProgressBar value={agent.progress} color="var(--agent-color)" markers={markers} size="md" label={`${name} progress`} />
      </footer>
    </section>
  );
}

/** Timestamped log that scrolls in its own box and sticks to the newest entry unless scrolled up. */
function ActionLog({
  entries,
  agentName,
  recovering,
}: {
  entries: ActionLogEntry[];
  agentName: string;
  recovering: boolean;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const lastSeq = entries[entries.length - 1]?.seq ?? null;

  const onScroll = () => {
    const el = listRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lastSeq]);

  return (
    <div className={styles.log} role="log" aria-label={`${agentName} action log`}>
      <div className={styles.logHeader}>
        <span className="label">Action log</span>
        <span className={cx("label num", styles.logCount)}>{entries.length}</span>
      </div>
      {recovering && (
        <p className={styles.sabotageNotice} role="status" aria-live="polite">
          Sabotage active — agent is recovering
        </p>
      )}
      {entries.length === 0 ? (
        <p className={styles.logEmpty}>No actions yet</p>
      ) : (
        <ol ref={listRef} className={styles.logList} onScroll={onScroll} tabIndex={0}>
          {entries.map((entry) => (
            <li key={entry.seq} className={cx(styles.entry, styles[`kind_${entry.kind}`])}>
              <time className={cx("num", styles.time)} dateTime={new Date(entry.at).toISOString()}>
                {formatLogTime(entry.at)}
              </time>
              <span className={styles.text} title={entry.url ?? undefined}>
                {entry.kind !== "action" && <span className={styles.kind}>{ACTION_LOG_KIND_LABEL[entry.kind]}</span>}
                {entry.text}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
