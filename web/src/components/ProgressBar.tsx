import type { CSSProperties } from "react";
import { cx } from "../lib/cx";
import styles from "./ProgressBar.module.css";

export type ProgressTone = "positive" | "sabotage" | "edge" | "muted";

export type ProgressMarker = {
  /** Position 0..1 along the track. */
  at: number;
  tone?: "sabotage" | "positive" | "muted";
  /** Tooltip / accessible description. */
  label?: string;
};

export type ProgressBarProps = {
  /** 0..1; clamped. */
  value: number;
  /**
   * Fill colour. Pass an agent colour (`agentVisual(a).color` or
   * "var(--agent-color)") for per-agent bars; otherwise `tone` is used.
   */
  color?: string;
  /** Default "positive". Ignored when `color` is set. */
  tone?: ProgressTone;
  /** Ticks on the track, e.g. the sabotage checkpoint. */
  markers?: readonly ProgressMarker[];
  /** xs 2px, sm 4px (default), md 6px. */
  size?: "xs" | "sm" | "md";
  /** Accessible name, e.g. "GPT-5.2 progress". */
  label?: string;
  className?: string;
};

/** Thin progress track. */
export function ProgressBar({ value, color, tone = "positive", markers, size = "sm", label, className }: ProgressBarProps) {
  const pct = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const fillStyle: CSSProperties = { width: `${pct * 100}%`, ...(color ? { backgroundColor: color } : null) };
  return (
    <div
      className={cx(styles.track, styles[size], className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct * 100)}
    >
      <div className={cx(styles.fill, !color && styles[tone])} style={fillStyle} />
      {markers?.map((m, i) => (
        <span
          key={`${m.at}-${i}`}
          className={cx(styles.marker, styles[`marker_${m.tone ?? "muted"}`])}
          style={{ left: `${Math.min(1, Math.max(0, m.at)) * 100}%` }}
          title={m.label}
        />
      ))}
    </div>
  );
}
