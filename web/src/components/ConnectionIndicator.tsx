import type { StreamStatus } from "../api/stream";
import { cx } from "../lib/cx";
import styles from "./ConnectionIndicator.module.css";

const LABEL: Readonly<Record<StreamStatus, string>> = {
  open: "Live",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  closed: "Offline",
};

export type ConnectionIndicatorProps = {
  status: StreamStatus;
  /** Show the text next to the dot. Default true. */
  showLabel?: boolean;
  className?: string;
};

/** Dot + label for a stream status (combine several with combineStreamStatus). */
export function ConnectionIndicator({ status, showLabel = true, className }: ConnectionIndicatorProps) {
  return (
    <span className={cx(styles.indicator, styles[status], className)} role="status" title={`Realtime: ${LABEL[status]}`}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={showLabel ? styles.label : "sr-only"}>{LABEL[status]}</span>
    </span>
  );
}
