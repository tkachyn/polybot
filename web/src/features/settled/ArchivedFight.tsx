/**
 * A fight the lobby no longer has (pruned, or lost to a server restart),
 * shown from its stored final evaluation: a header built from the
 * evaluation, a short note, and the evaluation report. Read-only: the market
 * is gone, and the server no longer serves its keyframes or replay.
 *
 * Rendered by FightRoute inside a scrolling <Page>. Renders no Page of its own.
 */
import type { FightEvaluation } from "@contract";
import { ButtonLink, ErrorBanner, IconAlert, IconArrowLeft, Skeleton } from "../../components";
import { formatDateTime, formatDuration } from "../../lib/format";
import { EvaluationReportView } from "../evaluation/EvaluationReport";
import type { FightEvaluationState } from "../evaluation/useFightEvaluation";
import { ResultHeader, ResultNote, WinnerLine } from "./SettledFight";
import styles from "./SettledFight.module.css";

export type ArchivedFightProps = {
  evaluation: FightEvaluation;
  /** The state the evaluation came from (useFightEvaluation), for the report. */
  report: FightEvaluationState;
};

export function ArchivedFight({ evaluation, report }: ArchivedFightProps) {
  const winner = evaluation.voided ? null : (evaluation.agents.find((agent) => agent.racerId === evaluation.winnerRacerId)?.agent ?? null);
  const duration = evaluation.startedAt !== null && evaluation.finishedAt !== null ? evaluation.finishedAt - evaluation.startedAt : null;

  return (
    <div className={styles.root}>
      <BackLink />
      <ResultHeader
        number={evaluation.number}
        title={evaluation.title}
        status={evaluation.voided ? "voided" : "resolved"}
        pillLabel={evaluation.voided ? "Void" : undefined}
        result={
          evaluation.voided ? (
            <ResultNote>Voided — no agent finished</ResultNote>
          ) : winner ? (
            <WinnerLine agent={winner} />
          ) : (
            <ResultNote>No verified winner</ResultNote>
          )
        }
        meta={[
          { label: "Started", value: formatDateTime(evaluation.startedAt) },
          { label: "Finished", value: formatDateTime(evaluation.finishedAt) },
          { label: "Duration", value: formatDuration(duration) },
        ]}
      />
      <p className={styles.archivedNote}>
        <IconAlert size={14} className={styles.archivedIcon} />
        <span>This fight is no longer in the lobby, but its final report is kept. Its market, keyframes and replays are not.</span>
      </p>
      <EvaluationReportView state={report} resolved archived />
    </div>
  );
}

/** While the stored report loads, or when loading it failed. */
export function ArchivedFightPlaceholder({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className={styles.root} aria-busy={error ? undefined : true}>
      <BackLink />
      {error ? (
        <ErrorBanner error={error} title="Couldn’t load this fight’s report." onRetry={onRetry} />
      ) : (
        <div className={styles.header}>
          <span className="sr-only" role="status">
            Loading the fight
          </span>
          <Skeleton width={120} height={12} />
          <Skeleton width="55%" height={18} />
          <Skeleton width="30%" height={12} />
        </div>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <ButtonLink to="/resolved" variant="subtle" size="sm" icon={<IconArrowLeft size={14} />} className={styles.back}>
      Resolved fights
    </ButtonLink>
  );
}
