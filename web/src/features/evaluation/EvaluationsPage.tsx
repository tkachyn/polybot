/**
 * Route "/evaluations": the robustness matrix over final evaluations (agents
 * × hazards), the training dataset download, and links to recent fight
 * reports.
 *
 * URL: `?mode=live|simulated|all&days=7|30|90` (see ./params). Without a
 * mode the page follows the server's mode.
 */
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { EvaluationReportSummary } from "@contract";
import { datasetExportUrl, datasetFileUrl, type DatasetQuery, type EvaluationMode } from "../../api/client";
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
import { useSession } from "../../state/session";
import { DATASET_FILES, DATASET_ZIP_NAME, EMPTY_DATASET_COPY, datasetScope, simulatedDatasetWarning } from "./dataset";
import { IconDownload, IconEvaluations } from "./icons";
import { MethodNote } from "./MethodNote";
import {
  DAYS_PARAM,
  EVALUATION_MODES,
  EVALUATION_WINDOWS,
  MODE_PARAM,
  matchesSelection,
  parseEvaluationMode,
  parseEvaluationWindow,
  type EvaluationWindow,
} from "./params";
import { RobustnessMatrix } from "./RobustnessMatrix";
import { useRobustnessMatrix } from "./useRobustnessMatrix";
import styles from "./EvaluationsPage.module.css";

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
  // The resource keeps the previous response while the next one loads. Only a
  // response for this window and mode is shown, never the old figures.
  const current = data !== null && matchesSelection(data, days, mode) ? data : null;
  const shownMode: EvaluationMode | null = mode ?? current?.mode ?? null;

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

  const empty = current !== null && (current.evaluations === 0 || current.rows.length === 0);

  let subtitle: ReactNode;
  if (current) {
    subtitle = (
      <span className="num">
        {formatNumber(current.evaluations)} final {current.evaluations === 1 ? "evaluation" : "evaluations"} · last {formatNumber(current.windowDays)} days ·
        since {formatDate(current.since)}
      </span>
    );
  } else if (loading) {
    subtitle = <Skeleton width={280} height={12} className={styles.subtitleSkeleton} />;
  } else {
    subtitle = "How each agent withstands sabotage, by hazard";
  }

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

  // Default width: the shared content column, so this page lines up with the
  // navbar and every other screen.
  return (
    <Page title="Evaluations">
      <PageHeader title="Evaluations" subtitle={subtitle} actions={actions} />
      <div className={styles.stack}>
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
            {current && !empty && (
              <span className={styles.panelMeta}>
                Updated <RelativeTime at={current.serverTime} />
              </span>
            )}
          </div>
          {/* A failed background refresh: the figures on screen stay, with the error above them. */}
          {current && error && (
            <div className={styles.panelAlert}>
              <ErrorBanner error={error} title="Couldn’t refresh the matrix." onRetry={refresh} retrying={manual && loading} />
            </div>
          )}
          {empty ? (
            <EmptyState
              size="sm"
              icon={<IconEvaluations size={20} />}
              title="No evaluations yet"
              description={
                <>
                  No {shownMode && shownMode !== "all" ? `${EVALUATION_MODE_LABEL[shownMode].toLowerCase()} ` : ""}fight has resolved in the last{" "}
                  {formatNumber(days)} days. Evaluations accrue as fights resolve: each resolved fight adds a final evaluation of all four agents to
                  this matrix and to the training dataset.
                </>
              }
              action={
                <ButtonLink to="/" variant="ghost" size="sm">
                  Browse fights
                </ButtonLink>
              }
            />
          ) : current || !error ? (
            <>
              <RobustnessMatrix rows={current ? current.rows : null} hazards={current ? current.hazards : []} />
              <p className={styles.caption}>
                The large number is the mean reaction score (0–100) over scored hits. The small line is survival (the share of scored hits after
                which the agent progressed again: immune, recovered or deceived) and the number of scored hits; hover a cell for the counts. Cut-short
                hits are not scored. A hazard gets a column once it has a scored hit. Rows are ordered by mean robustness, then success rate.
              </p>
              <MethodNote />
            </>
          ) : (
            <div className={styles.panelBody}>
              <ErrorBanner error={error} title="Couldn’t load the robustness matrix." onRetry={refresh} retrying={manual && loading} />
            </div>
          )}
        </section>

        <div className={styles.columns}>
          <DatasetPanel days={days} mode={mode} shownMode={shownMode} evaluations={current ? current.evaluations : null} />
          <RecentReports reports={current ? current.recent : null} failed={!current && error !== null} mode={shownMode} days={days} />
        </div>
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

type DatasetPanelProps = {
  days: number;
  /** The page's mode; null leaves it to the server (its own mode). */
  mode: EvaluationMode | null;
  /** The mode the rows carry, as far as the page knows. */
  shownMode: EvaluationMode | null;
  /** Final evaluations (one per resolved fight) in the window and mode; null while unknown. */
  evaluations: number | null;
};

function DatasetPanel({ days, mode, shownMode, evaluations }: DatasetPanelProps) {
  const query: DatasetQuery = { days, mode: mode ?? undefined };
  const scope = `${shownMode ? `${EVALUATION_MODE_LABEL[shownMode]} · ` : ""}last ${formatNumber(days)} days`;
  const warning = simulatedDatasetWarning(shownMode);
  // No fight in the window: every file would be empty, so nothing downloads.
  const { empty, summary } = datasetScope(evaluations);
  const summaryId = useId();
  return (
    <section className={styles.panel} aria-labelledby="evaluations-dataset">
      <div className={styles.panelHeader}>
        <h2 id="evaluations-dataset" className={styles.panelTitle}>
          Dataset
        </h2>
        <span className={styles.panelMeta}>{scope}</span>
      </div>
      <div className={styles.panelBody}>
        <p className={styles.text}>
          Training data from every resolved fight in the window, covering all four agents, failures included. Each{" "}
          <code className={styles.code}>.jsonl</code> file holds one JSON object per line.
        </p>
        {warning && (
          <p className={styles.note}>
            <IconAlert size={14} className={styles.noteIcon} />
            <span>{warning}</span>
          </p>
        )}
        <div className={styles.exportRow}>
          {empty ? (
            <Button variant="action" icon={<IconDownload size={14} />} disabled aria-describedby={summaryId}>
              Download dataset (.zip)
            </Button>
          ) : (
            <ButtonLink to={datasetExportUrl(query)} reloadDocument download={DATASET_ZIP_NAME} variant="action" icon={<IconDownload size={14} />}>
              Download dataset (.zip)
            </ButtonLink>
          )}
          {summary !== null && (
            <span id={summaryId} className={cx("num", styles.panelMeta)}>
              {summary}
            </span>
          )}
        </div>
        <div className={styles.filesBlock}>
          <h3 className="label">In the zip</h3>
          <dl className={styles.files}>
            {DATASET_FILES.map(({ file, name, description }) => (
              <div key={file} className={styles.file}>
                <dt>
                  {empty ? (
                    <span className={cx(styles.fileLink, styles.fileLinkDisabled)} title={EMPTY_DATASET_COPY}>
                      <IconDownload size={12} className={styles.fileIcon} />
                      {name}
                    </span>
                  ) : (
                    <a href={datasetFileUrl(file, query)} download={name} className={styles.fileLink} title={`Download ${name} on its own`}>
                      <IconDownload size={12} className={styles.fileIcon} />
                      <span className="sr-only">Download </span>
                      {name}
                    </a>
                  )}
                </dt>
                <dd className={styles.fileText}>{description}</dd>
              </div>
            ))}
            <div className={styles.file}>
              <dt className={styles.fileExtra}>Screenshots, Steel traces</dt>
              <dd className={styles.fileText}>Included in the zip only; steps and episodes point to them by path.</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Recent reports
// ---------------------------------------------------------------------------

type RecentReportsProps = {
  /** The matrix's newest fights (same window and mode as its figures); null while unknown. */
  reports: readonly EvaluationReportSummary[] | null;
  /** The matrix request failed, so the reports are unknown. */
  failed: boolean;
  /** The page's mode; with both modes shown, each row names its own. */
  mode: EvaluationMode | null;
  days: number;
};

/**
 * The reports behind the matrix: its newest fights, in its window and mode.
 * They come from the stored evaluations, not the lobby, so a fight that has
 * left the lobby is listed too, and its report still opens.
 */
function RecentReports({ reports, failed, mode, days }: RecentReportsProps) {
  const modeText = mode && mode !== "all" ? `${EVALUATION_MODE_LABEL[mode].toLowerCase()} ` : "";
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
      {reports === null ? (
        failed ? (
          <p className={styles.panelNote}>Couldn’t load recent reports.</p>
        ) : (
          <div className={styles.panelBody} aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={36} radius="md" />
            ))}
          </div>
        )
      ) : reports.length === 0 ? (
        <EmptyState
          size="sm"
          title="No reports in this window"
          description={`No ${modeText}fight has resolved in the last ${formatNumber(days)} days. Each fight’s evaluation report is listed here once the fight resolves.`}
        />
      ) : (
        <ol className={styles.recent}>
          {reports.map((report) => (
            <RecentRow key={report.raceId} report={report} showMode={mode === "all"} />
          ))}
        </ol>
      )}
    </section>
  );
}

function RecentRow({ report, showMode }: { report: EvaluationReportSummary; showMode: boolean }) {
  const number = formatFightNumber(report.number);
  return (
    <li>
      <Link to={`/fights/${encodeURIComponent(report.raceId)}`} className={styles.recentRow} aria-label={`Fight ${number} evaluation report: ${report.title}`}>
        <span className={cx("num", styles.recentNumber)}>{number}</span>
        <span className={styles.recentMain}>
          <span className={cx("clamp-1", styles.recentTitle)} title={report.title}>
            {report.title}
          </span>
          <span className={styles.recentMeta}>
            {report.voided ? (
              <span>Void</span>
            ) : report.winner ? (
              <span className={styles.recentWinner}>
                <AgentMonogram agent={report.winner} size="xs" />
                {report.winner.name}
              </span>
            ) : (
              <span>No winner</span>
            )}
            <span aria-hidden="true">·</span>
            <RelativeTime at={report.finishedAt} />
            {showMode && (
              <>
                <span aria-hidden="true">·</span>
                <span>{EVALUATION_MODE_LABEL[report.mode]}</span>
              </>
            )}
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
