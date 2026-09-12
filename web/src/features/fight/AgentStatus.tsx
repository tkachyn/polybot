import { IconAlert } from "../../components";
import { cx } from "../../lib/cx";
import type { AgentStatusView } from "./fightView";
import styles from "./AgentStatus.module.css";

function Indicator({ view }: { view: AgentStatusView }) {
  // LOOPING has no colour of its own: it reads as a warning glyph in secondary text.
  if (view.tone === "warn") return <IconAlert size={10} className={styles.icon} />;
  return <span className={styles.dot} aria-hidden="true" />;
}

/** Full-width pane band: status on the left, "STEP n/m" on the right. */
export function StatusBand({ view, step, className }: { view: AgentStatusView; step: string; className?: string }) {
  return (
    <span className={cx(styles.band, styles[view.tone], className)}>
      <Indicator view={view} />
      <span className={styles.bandLabel}>{view.label}</span>
      <span className={cx("num", styles.step)}>Step {step}</span>
    </span>
  );
}

/** Compact status chip for lanes and the expanded view. */
export function StatusTag({ view, className }: { view: AgentStatusView; className?: string }) {
  return (
    <span className={cx(styles.tag, styles[view.tone], className)}>
      <Indicator view={view} />
      {view.label}
    </span>
  );
}
