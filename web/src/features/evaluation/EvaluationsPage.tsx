/**
 * Route "/evaluations": the robustness matrix over final evaluations (agents
 * × hazards), the dataset export, and links to recent fight reports.
 *
 * URL: `?mode=live|simulated|all&days=7|30|90` (see ./params). Without a
 * mode the page follows the server's mode.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { FightSummary } from "@contract";
import { evaluationExportUrl, type EvaluationMode } from "../../api/client";
import {
  AgentMonogram,
  Button,
  ButtonLink,
  EmptyState,
  ErrorBanner,
  IconAlert,
  IconChevronRight,
  IconRefresh,
  Page,
  PageHeader,
  RelativeTime,
  SegmentedControl,
  Skeleton,
  type SegmentedOption,
} from "../../components";
import { cx } from "../../lib/cx";
import { formatDate, formatFightNumber, formatNumber } from "../../lib/format";
import { EVALUATION_MODE_LABEL, SIMULATED_AGENTS_COPY } from "../../lib/labels";
import { useFights } from "../../state/fights";
import { useSession } from "../../state/session";
import { resolvedNewestFirst } from "../home/filter";
import { IconDownload, IconEvaluations } from "./icons";
import {
  DAYS_PARAM,
  EVALUATION_MODES,
  EVALUATION_WINDOWS,
  MODE_PARAM,
  parseEvaluationMode,
  parseEvaluationWindow,
  type EvaluationWindow,
} from "./params";
import { RobustnessMatrix } from "./RobustnessMatrix";
import { useRobustnessMatrix } from "./useRobustnessMatrix";
import styles from "./EvaluationsPage.module.css";

/** Recent reports listed beside the export. */
const RECENT_LIMIT = 8;
/** Every fight carries exactly four agents, so an evaluation exports four rows. */
const AGENTS_PER_FIGHT = 4;
const EXPORT_FILENAME = "sabotage-markets-evaluations.jsonl";

const MODE_TITLE: Readonly<Record<EvaluationMode, string>> = {
  live: "Real models on live Steel browsers",
  simulated: "Scripted agents from simulated fights",
  all: "Live and simulated together",
};

const MODE_OPTIONS: readonly SegmentedOption<EvaluationMode>[] = EVALUATION_MODES.map((mode) => ({
  value: mode,
  label: EVALUATION_MODE_LABEL[mode],
  title: MODE_TITLE[mode],
}));

type WindowValue = `${EvaluationWindow}`;

const WINDOW_OPTIONS: readonly SegmentedOption<WindowValue>[] = EVALUATION_WINDOWS.map((days) => ({
  value: `${days}`,
  label: `${days}d`,
  title: `Last ${days} days`,
}));

export function EvaluationsPage() {
  const [params, setParams] = useSearchParams();
  const { meta } = useSession();
  const days = parseEvaluationWindow(params.get(DAYS_PARAM));
  const mode: EvaluationMode | null = parseEvaluationMode(params.get(MODE_PARAM)) ?? meta?.mode ?? null;
  const { data, error, loading, reload } = useRobustnessMatrix(days, mode);
  const shownMode: EvaluationMode | null = mode ?? data?.mode ?? null;

  // Only a manual refresh spins the button; background reloads stay quiet.
  const [manual, setManual] = useState(false);
  const refresh = useCallback(() => {
    setManual(true);
    reload();
  }, [reload]);
  useEffect(() => {
    if (!loading) setManual(false);
  }, [loading]);

  const setParam = useCallback(
    (key: string, value: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const stale = loading && data !== null && (data.windowDays !== days || (mode !== null && data.mode !== mode));
  const empty = data !== null && (data.evaluations === 0 || data.rows.length === 0);

  const subtitle = data ? (
    <span className="num">
      {formatNumber(data.evaluations)} final {data.evaluations === 1 ? "evaluation" : "evaluations"} · last {formatNumber(data.windowDays)} days · since{" "}
      {formatDate(data.since)}
    </span>
  ) : (
    "How each agent withstands sabotage, by hazard"
  );

  const actions = (
    <div className={styles.controls}>
      {shownMode ? (
        <SegmentedControl options={MODE_OPTIONS} value={shownMode} onChange={(next) => setParam(MODE_PARAM, next)} aria-label="Evaluation mode" size="sm" />
      ) : (
        <Skeleton width={176} height={28} radius="md" />
      )}
      <SegmentedControl
        options={WINDOW_OPTIONS}
        value={`${days}`}
        onChange={(next) => setParam(DAYS_PARAM, next)}
        aria-label="Window"
        size="sm"
      />
      <Button size="sm" variant="ghost" icon={<IconRefresh size={14} />} onClick={refresh} loading={manual && loading}>
        Refresh
      </Button>
    </div>
  );

  return (
    <Page title="Evaluations" width="wide">
      <PageHeader title="Evaluations" subtitle={subtitle} actions={actions} />
      <div className={styles.stack}>
        <ErrorBanner
          error={error}
          title={data ? "Couldn’t refresh the matrix." : "Couldn’t load the robustness matrix."}
          onRetry={refresh}
          retrying={manual && loading}
        />

        {shownMode === "simulated" && (
          <p className={styles.note}>
            <IconAlert size={14} className={styles.noteIcon} />
            <span>{SIMULATED_AGENTS_COPY}</span>
          </p>
        )}

        <section className={styles.panel} aria-labelledby="evaluations-matrix">
          <div className={styles.panelHeader}>
            <h2 id="evaluations-matrix" className={styles.panelTitle}>
              Robustness matrix
            </h2>
            {data && !empty && (
              <span className={styles.panelMeta}>
                Updated <RelativeTime at={data.serverTime} />
              </span>
            )}
          </div>
          {empty ? (
            <EmptyState
              size="sm"
              icon={<IconEvaluations size={20} />}
              title="No evaluations yet"
              description={
                <>
                  No {shownMode && shownMode !== "all" ? `${EVALUATION_MODE_LABEL[shownMode].toLowerCase()} ` : ""}fight has resolved in the last{" "}
                  {formatNumber(days)} days. Evaluations accrue as fights resolve: each resolved fight adds a final evaluation of all four agents to
                  this matrix and to the dataset export.
                </>
              }
              action={
                <ButtonLink to="/" variant="ghost" size="sm">
                  Browse fights
                </ButtonLink>
              }
            />
          ) : data || !error ? (
            <>
              <RobustnessMatrix rows={data ? data.rows : null} hazards={data ? data.hazards : []} stale={stale} />
              <p className={styles.caption}>
                The large number is the mean reaction score (0–100) over scored hits. The small line is survival (the share of scored hits after
                which the agent progressed again: immune, recovered or deceived) and the number of scored hits; hover a cell for the counts. Cut-short
                hits are not scored. A hazard gets a column once it has a scored hit. Rows are ordered by mean robustness, then success rate.
              </p>
            </>
          ) : null}
        </section>

        <div className={styles.columns}>
          <ExportPanel days={days} mode={mode} shownMode={shownMode} evaluations={data && !stale ? data.evaluations : null} />
          <RecentReports />
        </div>
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Dataset export
// ---------------------------------------------------------------------------

const SCHEMA: ReadonlyArray<{ group: string; fields: readonly string[]; note?: string }> = [
  { group: "Fight", fields: ["raceId", "fightNumber", "mode", "task", "courseId", "startedAt", "finishedAt", "sabotageSteps[]"] },
  { group: "Agent", fields: ["agent", "outcome", "success", "durationMs", "steps", "errors", "loops", "robustness"] },
  { group: "Reactions", fields: ["sabotage[]"], note: "each hit’s label, score, time lost, window counts, first response and explanation; keyframes omitted" },
  { group: "Traces", fields: ["trace[]", "steelTrace[]"], note: "runner steps with browser evidence; Steel’s own events for live sessions" },
  { group: "Crowd", fields: ["crowd"], note: "opening, before-hit, after-hit and final YES prices" },
];

type ExportPanelProps = {
  days: number;
  mode: EvaluationMode | null;
  shownMode: EvaluationMode | null;
  /** Evaluations in the current window and mode; null while unknown. */
  evaluations: number | null;
};

function ExportPanel({ days, mode, shownMode, evaluations }: ExportPanelProps) {
  const href = evaluationExportUrl({ days, mode: mode ?? undefined });
  const scope = `${shownMode ? `${EVALUATION_MODE_LABEL[shownMode]} · ` : ""}last ${formatNumber(days)} days`;
  return (
    <section className={styles.panel} aria-labelledby="evaluations-export">
      <div className={styles.panelHeader}>
        <h2 id="evaluations-export" className={styles.panelTitle}>
          Dataset
        </h2>
        <span className={styles.panelMeta}>{scope}</span>
      </div>
      <div className={styles.panelBody}>
        <p className={styles.text}>
          JSON Lines: one <code className={styles.code}>EvaluationExportRow</code> per agent per final evaluation, for the window and mode above. Every row
          carries <code className={styles.code}>schemaVersion: 1</code>, and simulated rows say <code className={styles.code}>mode: "simulated"</code>.
        </p>
        <dl className={styles.schema}>
          {SCHEMA.map(({ group, fields, note }) => (
            <div key={group} className={styles.schemaRow}>
              <dt className="label label-sm">{group}</dt>
              <dd>
                <span className={styles.fields}>
                  {fields.map((field) => (
                    <code key={field} className={styles.code}>
                      {field}
                    </code>
                  ))}
                </span>
                {note && <span className={styles.fieldNote}>{note}</span>}
              </dd>
            </div>
          ))}
        </dl>
        <div className={styles.exportRow}>
          {evaluations === 0 ? (
            <Button variant="action" icon={<IconDownload size={14} />} disabled title="Nothing to export in this window yet">
              Export dataset (.jsonl)
            </Button>
          ) : (
            <ButtonLink to={href} reloadDocument download={EXPORT_FILENAME} variant="action" icon={<IconDownload size={14} />}>
              Export dataset (.jsonl)
            </ButtonLink>
          )}
          {evaluations !== null && (
            <span className={cx("num", styles.panelMeta)}>
              {formatNumber(evaluations * AGENTS_PER_FIGHT)} {evaluations * AGENTS_PER_FIGHT === 1 ? "row" : "rows"} from {formatNumber(evaluations)}{" "}
              {evaluations === 1 ? "evaluation" : "evaluations"}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Recent reports
// ---------------------------------------------------------------------------

function RecentReports() {
  const { fights, loaded, error } = useFights();
  const recent = useMemo(() => resolvedNewestFirst(fights).slice(0, RECENT_LIMIT), [fights]);
  return (
    <section className={styles.panel} aria-labelledby="evaluations-recent">
      <div className={styles.panelHeader}>
        <h2 id="evaluations-recent" className={styles.panelTitle}>
          Recent reports
        </h2>
        <ButtonLink to="/resolved" variant="subtle" size="sm">
          All resolved
        </ButtonLink>
      </div>
      {!loaded ? (
        error ? (
          <p className={styles.panelNote}>Couldn’t load fights. Retrying…</p>
        ) : (
          <div className={styles.panelBody} aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={36} radius="md" />
            ))}
          </div>
        )
      ) : recent.length === 0 ? (
        <EmptyState size="sm" title="No resolved fights yet" description="Each fight’s evaluation report is listed here once the fight resolves." />
      ) : (
        <ol className={styles.recent}>
          {recent.map((fight) => (
            <RecentRow key={fight.raceId} fight={fight} />
          ))}
        </ol>
      )}
    </section>
  );
}

function RecentRow({ fight }: { fight: FightSummary }) {
  const winner = fight.voided ? null : (fight.agents.find((a) => a.racerId === fight.winnerRacerId) ?? null);
  const number = formatFightNumber(fight.number);
  return (
    <li>
      <Link to={`/fights/${encodeURIComponent(fight.raceId)}`} className={styles.recentRow} aria-label={`Fight ${number} evaluation report: ${fight.title}`}>
        <span className={cx("num", styles.recentNumber)}>{number}</span>
        <span className={styles.recentMain}>
          <span className={cx("clamp-1", styles.recentTitle)} title={fight.title}>
            {fight.title}
          </span>
          <span className={styles.recentMeta}>
            {fight.voided ? (
              <span>Void</span>
            ) : winner ? (
              <span className={styles.recentWinner}>
                <AgentMonogram agent={winner.agent} size="xs" />
                {winner.agent.name}
              </span>
            ) : (
              <span>Settling</span>
            )}
            <span aria-hidden="true">·</span>
            <RelativeTime at={fight.finishedAt} />
          </span>
        </span>
        <span className={styles.recentGo}>
          Report
          <IconChevronRight size={12} />
        </span>
      </Link>
    </li>
  );
}
