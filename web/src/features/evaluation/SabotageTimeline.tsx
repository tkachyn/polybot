/**
 * One agent's sabotage hits, in sequence order: the step, the reaction and
 * its score, the one-line reason, and the evidence where it exists
 * (keyframes either side of the hit, and the Steel replay opened at it).
 */
import { useMemo, useState } from "react";
import type { AgentEvaluation, SabotageReaction } from "@contract";
import { evidenceFrameUrl, replayUrl } from "../../api/client";
import { Button } from "../../components";
import { cx } from "../../lib/cx";
import { ReactionChip } from "./Chip";
import { EvidenceDialog, type EvidenceItem, type EvidenceSide } from "./EvidenceDialog";
import { describeHitOffset, formatOffset, formatReplayOffset, formatScore, sabotageStepTitle } from "./format";
import { IconPlay } from "./icons";
import { ReplayDialog } from "./ReplayPlayer";
import styles from "./SabotageTimeline.module.css";

export type SabotageTimelineProps = {
  raceId: string;
  agent: AgentEvaluation;
  /** The fight has left the lobby, so its keyframes and replay are no longer served. */
  archived?: boolean;
};

/** Renders nothing for an agent that was never hit. */
export function SabotageTimeline({ raceId, agent, archived = false }: SabotageTimelineProps) {
  const reactions = useMemo(() => [...agent.sabotage].sort((a, b) => a.stepIndex - b.stepIndex || a.appliedAt - b.appliedAt), [agent.sabotage]);
  if (reactions.length === 0) return null;
  return (
    <ol className={styles.timeline} aria-label={`Sabotage hits on ${agent.agent.name}`}>
      {reactions.map((reaction) => (
        <ReactionRow key={reaction.stepId} raceId={raceId} agent={agent} reaction={reaction} archived={archived} />
      ))}
    </ol>
  );
}

type ReactionRowProps = {
  raceId: string;
  agent: AgentEvaluation;
  reaction: SabotageReaction;
  archived: boolean;
};

function ReactionRow({ raceId, agent, reaction, archived }: ReactionRowProps) {
  const [evidenceOpen, setEvidenceOpen] = useState<EvidenceSide | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  const name = agent.agent.name;
  const { title, hazard } = sabotageStepTitle(reaction);
  const { before, after, replayOffsetSec } = reaction.evidence;
  // A fight that has left the lobby no longer serves its keyframes or replay: don't offer them.
  const replayOffset = agent.steel.replayAvailable && !archived ? replayOffsetSec : null;
  const frames: Record<EvidenceSide, EvidenceItem | null> = {
    before: before && !archived ? { frame: before, src: evidenceFrameUrl(raceId, agent.racerId, before.key) } : null,
    after: after && !archived ? { frame: after, src: evidenceFrameUrl(raceId, agent.racerId, after.key) } : null,
  };

  return (
    <li className={styles.row}>
      <span className={cx("num", styles.step)} title={`Sabotage ${reaction.stepIndex}`}>
        {reaction.stepIndex}
      </span>
      <div className={styles.content}>
        <p className={styles.head}>
          <span className={styles.title}>{title}</span>
          <ReactionChip reaction={reaction.reaction} />
          {reaction.score !== null && (
            <span className={styles.score} title="Reaction score, 0 to 100">
              Score <span className={cx("num", styles.scoreValue)}>{formatScore(reaction.score)}</span>
            </span>
          )}
        </p>
        <p className={styles.explanation}>{reaction.explanation}</p>
      </div>

      {(frames.before || frames.after || replayOffset !== null) && (
        <div className={styles.evidence}>
          {frames.before && <EvidenceThumb side="before" item={frames.before} appliedAt={reaction.appliedAt} onOpen={() => setEvidenceOpen("before")} />}
          {frames.after && <EvidenceThumb side="after" item={frames.after} appliedAt={reaction.appliedAt} onOpen={() => setEvidenceOpen("after")} />}
          {replayOffset !== null && (
            <Button size="sm" variant="ghost" icon={<IconPlay size={12} />} onClick={() => setReplayOpen(true)}>
              Replay <span className="num">{formatReplayOffset(replayOffset)}</span>
            </Button>
          )}
        </div>
      )}

      {evidenceOpen && (
        <EvidenceDialog
          title={`${name} · sabotage ${reaction.stepIndex}`}
          subtitle={[title, hazard, reaction.checkpointLabel].filter(Boolean).join(" · ")}
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
          stepLabel={title}
          onClose={() => setReplayOpen(false)}
        />
      )}
    </li>
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
