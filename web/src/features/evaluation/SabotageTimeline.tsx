/**
 * One agent's sabotage timeline: a row per hit, in sequence order, with the
 * reaction and its cost, the evidence (keyframes and the Steel replay) and
 * the Steel trace around the hit.
 */
import { useMemo, useState, type ReactNode } from "react";
import type { AgentEvaluation, SabotageReaction } from "@contract";
import { evidenceFrameUrl, replayUrl } from "../../api/client";
import { Button, Tag } from "../../components";
import { cx } from "../../lib/cx";
import { EMPTY, formatNumber } from "../../lib/format";
import { HAZARD_LABEL, SABOTAGE_TIER_LABEL } from "../../lib/labels";
import { ReactionChip } from "./Chip";
import { EvidenceDialog, type EvidenceItem, type EvidenceSide } from "./EvidenceDialog";
import { describeHitOffset, formatCheckpoint, formatFightTime, formatOffset, formatReplayOffset, formatScore, formatSeconds } from "./format";
import { IconPlay } from "./icons";
import { ReplayDialog } from "./ReplayPlayer";
import { SteelExcerpt } from "./TraceTables";
import styles from "./SabotageTimeline.module.css";

export type SabotageTimelineProps = {
  raceId: string;
  agent: AgentEvaluation;
  /** Fight start, for "hit at 01:12". */
  startedAt: number | null;
};

export function SabotageTimeline({ raceId, agent, startedAt }: SabotageTimelineProps) {
  const reactions = useMemo(() => [...agent.sabotage].sort((a, b) => a.stepIndex - b.stepIndex || a.appliedAt - b.appliedAt), [agent.sabotage]);
  if (reactions.length === 0) {
    return <p className={styles.none}>Not hit by any sabotage step, so robustness was not tested.</p>;
  }
  return (
    <ol className={styles.timeline}>
      {reactions.map((reaction) => (
        <ReactionRow key={reaction.stepId} raceId={raceId} agent={agent} reaction={reaction} startedAt={startedAt} />
      ))}
    </ol>
  );
}

type ReactionRowProps = {
  raceId: string;
  agent: AgentEvaluation;
  reaction: SabotageReaction;
  startedAt: number | null;
};

function ReactionRow({ raceId, agent, reaction, startedAt }: ReactionRowProps) {
  const [evidenceOpen, setEvidenceOpen] = useState<EvidenceSide | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  const name = agent.agent.name;
  const { before, after, replayOffsetSec } = reaction.evidence;
  const delay = reaction.progressedAt !== null ? reaction.progressedAt - reaction.appliedAt : null;
  const active = reaction.expiredAt !== null ? reaction.expiredAt - reaction.appliedAt : null;
  const replayOffset = agent.steel.replayAvailable ? replayOffsetSec : null;
  const frames: Record<EvidenceSide, EvidenceItem | null> = {
    before: before ? { frame: before, src: evidenceFrameUrl(raceId, agent.racerId, before.key) } : null,
    after: after ? { frame: after, src: evidenceFrameUrl(raceId, agent.racerId, after.key) } : null,
  };

  return (
    <li className={styles.row}>
      <span className={cx("num", styles.step)} title={`Step ${reaction.stepIndex} of the sabotage sequence`}>
        {reaction.stepIndex}
      </span>
      <div className={styles.content}>
        <div className={styles.head}>
          <div className={styles.what}>
            <h5 className={styles.preset}>{reaction.label}</h5>
            <p className={styles.where}>
              <span>{HAZARD_LABEL[reaction.hazardType]}</span>
              <span>{SABOTAGE_TIER_LABEL[reaction.tier]}</span>
              <span>{formatCheckpoint(reaction.checkpoint, reaction.checkpointLabel)}</span>
              <span className="num">Hit at {formatFightTime(reaction.appliedAt, startedAt)}</span>
            </p>
          </div>
          <div className={styles.verdict}>
            <ReactionChip reaction={reaction.reaction} size="lg" />
            <span className={styles.score}>
              {reaction.score === null ? (
                "Not scored"
              ) : (
                <>
                  Score <span className={cx("num", styles.scoreValue)}>{formatScore(reaction.score)}</span>
                </>
              )}
            </span>
          </div>
        </div>

        <dl className={styles.metrics}>
          <Metric label="Time lost" title="Delay beyond the agent’s normal pace">
            {reaction.timeLostMs === null ? "Never progressed" : formatSeconds(reaction.timeLostMs)}
          </Metric>
          <Metric label="Progressed after" title="From the hit to the next verified checkpoint or the finish">
            {delay === null ? EMPTY : formatSeconds(delay)}
          </Metric>
          <Metric label="Hazard active" title="How long the hazard stayed in place before it expired">
            {active === null ? EMPTY : formatSeconds(active)}
          </Metric>
          <Metric label="Actions" title="Steps taken inside the window after the hit">
            {formatNumber(reaction.actionsInWindow)}
          </Metric>
          <Metric label="Errors" title="Errors inside the window after the hit" negative={reaction.errorsInWindow > 0}>
            {formatNumber(reaction.errorsInWindow)}
          </Metric>
          {reaction.deceived && (
            <div className={styles.metric}>
              <dt className="sr-only">Decoy</dt>
              <dd>
                <Tag tone="sabotage" title="Clicked a planted decoy inside the window">
                  Decoy click
                </Tag>
              </dd>
            </div>
          )}
        </dl>

        <p className={styles.firstResponse}>
          <span className="label label-sm">First response</span>
          {reaction.firstResponse ? <span className={styles.response}>{reaction.firstResponse}</span> : <span className={styles.muted}>No action after the hit</span>}
        </p>
        <p className={styles.explanation}>{reaction.explanation}</p>

        {frames.before || frames.after || replayOffset !== null ? (
          <div className={styles.evidence}>
            {frames.before && <EvidenceThumb side="before" item={frames.before} appliedAt={reaction.appliedAt} onOpen={() => setEvidenceOpen("before")} />}
            {frames.after && <EvidenceThumb side="after" item={frames.after} appliedAt={reaction.appliedAt} onOpen={() => setEvidenceOpen("after")} />}
            {replayOffset !== null && (
              <Button size="sm" variant="ghost" icon={<IconPlay size={12} />} onClick={() => setReplayOpen(true)} className={styles.replay}>
                Watch replay at <span className="num">{formatReplayOffset(replayOffset)}</span>
              </Button>
            )}
          </div>
        ) : (
          <p className={styles.muted}>No keyframes were captured for this hit.</p>
        )}

        {agent.steel.traceAvailable && <SteelExcerpt trace={agent.steel.trace} at={reaction.appliedAt} />}
      </div>

      {evidenceOpen && (
        <EvidenceDialog
          title={`${name} · sabotage ${reaction.stepIndex}`}
          subtitle={[
            reaction.label,
            // A step without a named preset is labelled after its hazard; don't repeat it.
            HAZARD_LABEL[reaction.hazardType].toLowerCase() === reaction.label.toLowerCase()
              ? null
              : HAZARD_LABEL[reaction.hazardType],
            reaction.checkpointLabel,
          ].filter(Boolean).join(" · ")}
          frames={frames}
          initial={evidenceOpen}
          appliedAt={reaction.appliedAt}
          onClose={() => setEvidenceOpen(null)}
        />
      )}
      {replayOpen && replayOffset !== null && (
        <ReplayDialog
          src={replayUrl(raceId, agent.racerId)}
          startAt={replayOffset}
          agentName={name}
          stepIndex={reaction.stepIndex}
          stepLabel={reaction.label}
          onClose={() => setReplayOpen(false)}
        />
      )}
    </li>
  );
}

function Metric({ label, title, negative = false, children }: { label: string; title?: string; negative?: boolean; children: ReactNode }) {
  return (
    <div className={styles.metric} title={title}>
      <dt className="label label-sm">{label}</dt>
      <dd className={cx("num", styles.metricValue, negative && styles.negative)}>{children}</dd>
    </div>
  );
}

type EvidenceThumbProps = {
  side: EvidenceSide;
  item: EvidenceItem;
  appliedAt: number;
  onOpen: () => void;
};

function EvidenceThumb({ side, item, appliedAt, onOpen }: EvidenceThumbProps) {
  const [failed, setFailed] = useState(false);
  const offset = item.frame.capturedAt - appliedAt;
  return (
    <button
      type="button"
      className={styles.thumb}
      onClick={onOpen}
      disabled={failed}
      aria-label={`Enlarge the keyframe captured ${describeHitOffset(offset)}`}
      title={failed ? "This keyframe is not available" : `Captured ${describeHitOffset(offset)}. Click to enlarge.`}
    >
      <span className={styles.thumbImage}>
        {failed ? (
          <span className={styles.thumbMissing}>No frame</span>
        ) : (
          <img src={item.src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
        )}
      </span>
      <span className={styles.thumbCaption}>
        {side === "before" ? "Before" : "After"} <span className="num">{formatOffset(offset)}</span>
      </span>
    </button>
  );
}
