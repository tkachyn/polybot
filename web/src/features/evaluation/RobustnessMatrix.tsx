/**
 * Robustness matrix: agents × hazards over final evaluations. A cell shows
 * survival (the share of scored hits after which the agent progressed)
 * prominently and the mean reaction score small; its tooltip lists the
 * reaction counts. The table scrolls in its own container; the agent column
 * stays pinned.
 */
import type { HazardType, RobustnessCell, RobustnessRow } from "@contract";
import { AgentMonogram, ProgressBar, Skeleton, tableStyles } from "../../components";
import { agentModelLabel, agentStyle } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { formatNumber, formatPercent } from "../../lib/format";
import { HAZARD_LABEL } from "../../lib/labels";
import { matrixCellView } from "./format";
import styles from "./EvaluationsPage.module.css";

export type RobustnessMatrixProps = {
  /** Null renders skeleton rows (while a window or mode loads). */
  rows: readonly RobustnessRow[] | null;
  /** Hazard columns, in catalogue order (the response's `hazards`). */
  hazards: readonly HazardType[];
};

const SKELETON_ROWS = 4;

function plural(n: number, one: string, many: string): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

export function RobustnessMatrix({ rows, hazards }: RobustnessMatrixProps) {
  return (
    <div className={styles.matrixWrap}>
      <table className={cx(tableStyles.table, styles.matrix)} aria-busy={rows === null || undefined}>
        <caption className="sr-only">
          Sabotage robustness by agent and hazard. Each cell gives the mean reaction score (0–100), the survival rate and the number of scored hits.
        </caption>
        <thead>
          <tr>
            <th scope="col" className={styles.agentHead}>
              Agent
            </th>
            <th scope="col" className={tableStyles.num}>
              Fights
            </th>
            <th scope="col" className={tableStyles.num} title="Share of fights with a verified finish">
              Success
            </th>
            {hazards.map((hazard) => (
              <th key={hazard} scope="col" className={tableStyles.num}>
                {HAZARD_LABEL[hazard]}
              </th>
            ))}
            <th scope="col" className={cx(tableStyles.num, styles.overallHead)}>
              Overall
            </th>
          </tr>
        </thead>
        <tbody>
          {rows === null
            ? Array.from({ length: SKELETON_ROWS }, (_, i) => <SkeletonRow key={i} columns={hazards.length + 3} />)
            : rows.map((row) => <MatrixRow key={row.agent.key} row={row} hazards={hazards} />)}
        </tbody>
      </table>
    </div>
  );
}

function MatrixRow({ row, hazards }: { row: RobustnessRow; hazards: readonly HazardType[] }) {
  const model = agentModelLabel(row.agent);
  return (
    <tr className={tableStyles.row} style={agentStyle(row.agent)}>
      <td className={styles.agentCell}>
        <span className={styles.agent}>
          <AgentMonogram agent={row.agent} size="md" />
          <span className={styles.agentText}>
            <span className={styles.agentName}>{row.agent.name}</span>
            <span className={styles.agentModel} title={model}>
              {model}
            </span>
          </span>
        </span>
      </td>
      <td className={tableStyles.num}>
        <span className={styles.cellInner}>
          <span className={styles.figure}>{formatNumber(row.fights)}</span>
          <span className={styles.sub}>{plural(row.wins, "win", "wins")}</span>
        </span>
      </td>
      <td className={tableStyles.num}>
        <span className={styles.cellInner}>
          <span className={styles.figure}>{formatPercent(row.successRate, { decimals: 0 })}</span>
          <ProgressBar value={row.successRate} color="var(--agent-color)" size="xs" className={styles.bar} label={`${row.agent.name} success rate`} />
        </span>
      </td>
      {hazards.map((hazard) => (
        <MatrixCell key={hazard} cell={row.byHazard[hazard]} />
      ))}
      <MatrixCell cell={row.overall} overall />
    </tr>
  );
}

function MatrixCell({ cell, overall = false }: { cell: RobustnessCell | undefined; overall?: boolean }) {
  const view = matrixCellView(cell);
  return (
    <td className={cx(tableStyles.num, styles.cell, overall && styles.overallCell, view.empty && styles.cellEmpty)} title={view.tooltip}>
      <span className={styles.cellInner} aria-hidden="true">
        <span className={styles.headline}>{view.headline}</span>
        <span className={styles.sub}>{view.detail}</span>
      </span>
      <span className="sr-only">
        {view.empty ? view.tooltip : `Mean score ${view.headline}, ${view.detail}. ${view.tooltip}`}
      </span>
    </td>
  );
}

function SkeletonRow({ columns }: { columns: number }) {
  return (
    <tr aria-hidden="true">
      <td className={styles.agentCell}>
        <span className={styles.agent}>
          <Skeleton width={28} height={28} radius="md" />
          <Skeleton width={120} height={12} />
        </span>
      </td>
      {Array.from({ length: columns }, (_, i) => (
        <td key={i} className={tableStyles.num}>
          <span className={styles.cellInner}>
            <Skeleton width={40} height={14} />
            <Skeleton width={64} height={9} />
          </span>
        </td>
      ))}
    </tr>
  );
}
