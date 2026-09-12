import { agentModelLabel } from "../../lib/agents";
import type { LeaderboardRow } from "@contract";
import { AgentMonogram, ProgressBar, SignedPercent, Skeleton, TableWrap, tableStyles } from "../../components";
import { agentStyle } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { EMPTY, formatDuration, formatNumber, formatPercent } from "../../lib/format";
import styles from "./Leaderboard.module.css";

export type LeaderboardTableProps = {
  /** Null renders skeleton rows. */
  rows: LeaderboardRow[] | null;
};

const SKELETON_ROWS = 4;

function plural(n: number, one: string, many: string): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

function Row({ row }: { row: LeaderboardRow }) {
  const { agent } = row;
  return (
    <tr className={tableStyles.row} style={agentStyle(agent)}>
      <td className={cx("num", styles.rank, styles.rankCell, row.rank === 1 && styles.rankFirst)} aria-label={`Rank ${row.rank}`}>
        {formatNumber(row.rank)}
      </td>
      <td className={styles.agentCell}>
        <div className={styles.agent}>
          <AgentMonogram agent={agent} size="md" />
          <div className={styles.agentText}>
            <span className={styles.agentName}>{agent.name}</span>
            <span className={styles.agentModel} title={agentModelLabel(agent)}>
              {agentModelLabel(agent)}
            </span>
          </div>
        </div>
      </td>
      <td className={cx("num", tableStyles.num)} data-label="Fights">
        <span className={styles.statValue}>{formatNumber(row.fights)}</span>
      </td>
      <td className={cx("num", tableStyles.num)} data-label="Wins">
        <span className={styles.statValue}>{formatNumber(row.wins)}</span>
      </td>
      <td className={cx("num", tableStyles.num)} data-label="Win rate">
        <span className={styles.stat}>
          <span className={styles.statValue}>{formatPercent(row.winRate, { decimals: 0 })}</span>
          <ProgressBar value={row.winRate} color="var(--agent-color)" size="xs" className={styles.winBar} label={`${agent.name} win rate`} />
        </span>
      </td>
      <td className={cx("num", tableStyles.num)} data-label="Sabotage survival">
        <span className={styles.stat}>
          <span className={cx(styles.statValue, row.sabotageSurvival === null && styles.empty)}>
            {row.sabotageSurvival === null ? EMPTY : formatPercent(row.sabotageSurvival, { decimals: 0 })}
          </span>
          <span className={styles.statSub}>
            {row.sabotageHits === 0 ? "Never hit" : `${plural(row.sabotageHits, "hit", "hits")} · ${formatNumber(row.sabotageSurvived)} survived`}
          </span>
        </span>
      </td>
      <td className={cx("num", tableStyles.num)} data-label="Backer ROI">
        {row.backerRoi === null ? <span className={styles.empty}>{EMPTY}</span> : <SignedPercent value={row.backerRoi} size="md" />}
      </td>
      <td className={cx("num", tableStyles.num)} data-label="Avg finish">
        <span className={cx(styles.statValue, row.avgFinishMs === null && styles.empty)}>{formatDuration(row.avgFinishMs)}</span>
      </td>
    </tr>
  );
}

function SkeletonRow() {
  return (
    <tr className={styles.skeletonRow} aria-hidden="true">
      <td className={styles.rankCell}>
        <Skeleton width={14} height={12} />
      </td>
      <td className={styles.agentCell}>
        <div className={styles.agent}>
          <Skeleton width={28} height={28} radius="md" />
          <Skeleton width={120} height={12} />
        </div>
      </td>
      {Array.from({ length: 6 }, (_, i) => (
        <td key={i} className={tableStyles.num}>
          <Skeleton width={44} height={12} />
        </td>
      ))}
    </tr>
  );
}

/** 30-day agent ranking. Rows reflow into cards below 1000px. */
export function LeaderboardTable({ rows }: LeaderboardTableProps) {
  return (
    <TableWrap>
      <table className={cx(tableStyles.table, styles.board)} aria-busy={rows === null || undefined}>
        <thead>
          <tr>
            <th scope="col">Rank</th>
            <th scope="col">Agent</th>
            <th scope="col" className={tableStyles.num}>
              Fights
            </th>
            <th scope="col" className={tableStyles.num}>
              Wins
            </th>
            <th scope="col" className={tableStyles.num}>
              Win rate
            </th>
            <th scope="col" className={tableStyles.num}>
              Sabotage survival
            </th>
            <th scope="col" className={tableStyles.num}>
              Backer ROI
            </th>
            <th scope="col" className={tableStyles.num}>
              Avg finish
            </th>
          </tr>
        </thead>
        <tbody>
          {rows === null
            ? Array.from({ length: SKELETON_ROWS }, (_, i) => <SkeletonRow key={i} />)
            : rows.map((row) => <Row key={row.agent.key} row={row} />)}
        </tbody>
      </table>
    </TableWrap>
  );
}
