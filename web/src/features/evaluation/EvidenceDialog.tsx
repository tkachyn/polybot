/**
 * Enlarged keyframes around one hit: the racer's frame just before it and
 * the first frame captured at least 1.5 s after, switchable in place.
 */
import { useState } from "react";
import type { EvidenceFrame } from "@contract";
import { SegmentedControl } from "../../components";
import { formatLogTime } from "../../lib/format";
import { Dialog } from "./Dialog";
import { describeHitOffset } from "./format";
import styles from "./Replay.module.css";

export type EvidenceSide = "before" | "after";

export type EvidenceItem = { frame: EvidenceFrame; src: string };

export type EvidenceDialogProps = {
  title: string;
  subtitle?: string;
  frames: Readonly<Record<EvidenceSide, EvidenceItem | null>>;
  /** The frame to show first. */
  initial: EvidenceSide;
  /** The hit, for the caption. */
  appliedAt: number;
  onClose: () => void;
};

const SIDE_OPTIONS = [
  { value: "before", label: "Before the hit" },
  { value: "after", label: "After the hit" },
] as const;

export function EvidenceDialog({ title, subtitle, frames, initial, appliedAt, onClose }: EvidenceDialogProps) {
  const [side, setSide] = useState<EvidenceSide>(initial);
  const [failed, setFailed] = useState<ReadonlySet<EvidenceSide>>(() => new Set());
  const current = frames[side];
  const both = frames.before !== null && frames.after !== null;

  return (
    <Dialog title={title} subtitle={subtitle} onClose={onClose}>
      <div className={styles.evidence}>
        {both && <SegmentedControl options={SIDE_OPTIONS} value={side} onChange={setSide} aria-label="Keyframe" size="sm" />}
        <figure className={styles.figure}>
          <div className={styles.frameStage}>
            {current && !failed.has(side) ? (
              <img
                key={current.src}
                className={styles.frameImage}
                src={current.src}
                alt={`Browser ${describeHitOffset(current.frame.capturedAt - appliedAt)}`}
                draggable={false}
                onError={() => setFailed((prev) => new Set(prev).add(side))}
              />
            ) : (
              <p className={styles.frameMissing}>This keyframe is not available.</p>
            )}
          </div>
          {current && (
            <figcaption className={styles.caption}>
              Captured <span className="num">{describeHitOffset(current.frame.capturedAt - appliedAt)}</span> · <span className="num">{formatLogTime(current.frame.capturedAt)}</span>
            </figcaption>
          )}
        </figure>
      </div>
    </Dialog>
  );
}
