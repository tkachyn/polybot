import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { Skeleton } from "./Feedback";
import styles from "./StatTile.module.css";

export type StatTileProps = {
  /** Uppercase label, e.g. "Equity". */
  label: ReactNode;
  /** The figure. Pass a formatted string or a figure component (Money, SignedMoney...). */
  value: ReactNode;
  /** Secondary line under the value. */
  sub?: ReactNode;
  /** Colours a plain-string value. Figure components carry their own tone. */
  tone?: "default" | "positive" | "negative";
  /** Shows skeletons instead of value and sub. */
  loading?: boolean;
  className?: string;
};

/** Surface card with a label, a big tabular figure and an optional sub-line. */
export function StatTile({ label, value, sub, tone = "default", loading = false, className }: StatTileProps) {
  return (
    <div className={cx(styles.tile, className)}>
      <span className="label">{label}</span>
      <span className={cx("num", styles.value, tone !== "default" && styles[tone])}>{loading ? <Skeleton width={96} height={20} /> : value}</span>
      {(sub !== undefined || loading) && <span className={cx("num", styles.sub)}>{loading ? <Skeleton width={64} height={10} /> : sub}</span>}
    </div>
  );
}
