/**
 * Label chips for the evaluation: reaction, agent outcome, report status.
 * Tones come from ./tones and render with semantic tokens only.
 */
import type { ReactNode } from "react";
import type { AgentOutcome, ReactionLabel } from "@contract";
import { IconAlert } from "../../components";
import { cx } from "../../lib/cx";
import {
  AGENT_OUTCOME_DESCRIPTION,
  AGENT_OUTCOME_LABEL,
  EVALUATION_FINALIZING_LABEL,
  EVALUATION_STATUS_LABEL,
  REACTION_DESCRIPTION,
  REACTION_LABEL,
} from "../../lib/labels";
import type { EvaluationDisplayStatus } from "./format";
import { EVALUATION_STATUS_TONE, OUTCOME_TONE, REACTION_TONE, type EvaluationTone } from "./tones";
import styles from "./Chip.module.css";

export type ToneChipProps = {
  tone: EvaluationTone;
  children: ReactNode;
  /** md 18px (default), lg 20px. */
  size?: "md" | "lg";
  title?: string;
  className?: string;
};

/** Uppercase chip. The warn tone adds the alert glyph, as LOOPING does on the fight screen. */
export function ToneChip({ tone, children, size = "md", title, className }: ToneChipProps) {
  return (
    <span className={cx(styles.chip, styles[tone], styles[size], className)} title={title}>
      {tone === "warn" && <IconAlert size={10} className={styles.glyph} />}
      {children}
    </span>
  );
}

export function ReactionChip({ reaction, size, className }: { reaction: ReactionLabel; size?: "md" | "lg"; className?: string }) {
  return (
    <ToneChip tone={REACTION_TONE[reaction]} size={size} title={REACTION_DESCRIPTION[reaction]} className={className}>
      {REACTION_LABEL[reaction]}
    </ToneChip>
  );
}

export function OutcomeChip({ outcome, size, className }: { outcome: AgentOutcome; size?: "md" | "lg"; className?: string }) {
  return (
    <ToneChip tone={OUTCOME_TONE[outcome]} size={size} title={AGENT_OUTCOME_DESCRIPTION[outcome]} className={className}>
      {AGENT_OUTCOME_LABEL[outcome]}
    </ToneChip>
  );
}

const STATUS_LABEL: Readonly<Record<EvaluationDisplayStatus, string>> = { ...EVALUATION_STATUS_LABEL, finalizing: EVALUATION_FINALIZING_LABEL };

// Finalizing is as calm as Final: the fight is over, only the write is pending.
const STATUS_TONE: Readonly<Record<EvaluationDisplayStatus, EvaluationTone>> = { ...EVALUATION_STATUS_TONE, finalizing: "neutral" };

const STATUS_TITLE: Readonly<Record<EvaluationDisplayStatus, string>> = {
  provisional: "Provisional: the fight is still running, so these figures can change.",
  finalizing: "Finalizing: the fight has resolved and its final evaluation is being written.",
  final: "Final: frozen when the fight resolved.",
};

/** The report's status; see evaluationDisplayStatus for when it reads Finalizing. */
export function EvaluationStatusChip({ status, className }: { status: EvaluationDisplayStatus; className?: string }) {
  return (
    <ToneChip tone={STATUS_TONE[status]} size="lg" title={STATUS_TITLE[status]} className={className}>
      {STATUS_LABEL[status]}
    </ToneChip>
  );
}
