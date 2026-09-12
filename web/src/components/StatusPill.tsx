import type { FightStatus } from "@contract";
import { cx } from "../lib/cx";
import { FIGHT_STATUS_LABEL } from "../lib/labels";
import styles from "./StatusPill.module.css";

/** A fight's display status; "voided" is a resolved fight that refunded. */
export type PillStatus = FightStatus | "voided";

/** Maps a fight (summary or detail) to its pill status. */
export function fightPillStatus(fight: { status: FightStatus; voided: boolean }): PillStatus {
  return fight.status === "resolved" && fight.voided ? "voided" : fight.status;
}

const LABEL: Readonly<Record<PillStatus, string>> = { ...FIGHT_STATUS_LABEL, voided: "Voided" };

export type StatusPillProps = {
  status: PillStatus;
  /** Override the text (default: Live / Upcoming / Resolved / Voided). */
  label?: string;
  size?: "sm" | "md";
  className?: string;
};

/** Live (pulsing green dot) / Upcoming / Resolved / Voided. */
export function StatusPill({ status, label, size = "md", className }: StatusPillProps) {
  return (
    <span className={cx(styles.pill, styles[status], styles[size], className)}>
      <span className={styles.dot} aria-hidden="true" />
      {label ?? LABEL[status]}
    </span>
  );
}
