import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import styles from "./Tag.module.css";

/** sabotage = terracotta; positive = green; edge = blue edge; neutral = slate. */
export type TagTone = "sabotage" | "positive" | "edge" | "neutral";

export type TagProps = {
  tone?: TagTone;
  children: ReactNode;
  /** Solid fill instead of the tint (use sparingly: e.g. WINNER). */
  solid?: boolean;
  className?: string;
  title?: string;
};

/** Small uppercase label chip. */
export function Tag({ tone = "neutral", solid = false, children, className, title }: TagProps) {
  return (
    <span className={cx(styles.tag, styles[tone], solid && styles.solid, className)} title={title}>
      {children}
    </span>
  );
}

/** The red "SABOTAGE:" lead-in on cards, headers and trace rows. */
export function SabotageTag({ children = "Sabotage", className }: { children?: ReactNode; className?: string }) {
  return <span className={cx(styles.sabotageLabel, className)}>{children}:</span>;
}
