/**
 * The lobby's right rail: standings first, then what has already settled.
 *
 *   Leaderboard  agent ranking over the leaderboard window, by win rate
 *   Past fights  one row per settled fight, with its winner
 *
 * Past fights is a compact read of the Resolved screen, so its header links
 * there. The standings have no page of their own; this is the whole of them.
 */
import { Link } from "react-router-dom";
import type { FightSummary, LeaderboardRow } from "@contract";
import { AgentMonogram, IconChevronRight, Skeleton } from "../../components";
import { useLeaderboard } from "../leaderboard/useLeaderboard";
import { agentStyle, rosterVisuals } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { formatChance, formatCompactMoney, formatNumber, formatPercent } from "../../lib/format";
import { buildPlaceholderLeaderboard } from "./placeholders";
import styles from "./LobbyRail.module.css";

/** Rows shown in the rail; the full ranking lives on /leaderboard. */
const RAIL_ROWS = 5;

/** A card header. With `to`, the whole header leads to that screen. */
function CardHead({ to, title }: { to?: string; title: string }) {
  if (!to) {
    return (
      <div className={styles.head}>
        <h2 className={styles.headTitle}>{title}</h2>
      </div>
    );
  }
  return (
    <Link to={to} className={styles.head}>
      <h2 className={styles.headTitle}>{title}</h2>
      <IconChevronRight size={14} className={styles.headIcon} />
    </Link>
  );
}

function LeaderboardRailRow({ row }: { row: LeaderboardRow }) {
  const { agent } = row;
  return (
    <li className={styles.row} style={agentStyle(agent)}>
      <span className={cx("num", styles.rank, row.rank === 1 && styles.rankFirst)}>{formatNumber(row.rank)}</span>
      <AgentMonogram agent={agent} size="sm" className={styles.rowMark} />
      <span className={styles.rowText}>
        <span className={styles.rowName} title={agent.name}>
          {agent.name}
        </span>
        <span className={styles.rowSub}>
          <span className="num">{formatNumber(row.wins)}</span> of <span className="num">{formatNumber(row.fights)}</span>
          {row.fights === 1 ? " fight" : " fights"}
        </span>
      </span>
      <span className={styles.rowFigures}>
        <span className={cx("num", styles.rowFigure)}>{formatPercent(row.winRate, { decimals: 0 })}</span>
        <span className={styles.rowFigureSub}>win rate</span>
      </span>
    </li>
  );
}

function LeaderboardCard() {
  const { data, error } = useLeaderboard();
  // A backend with no resolved fights yet has no standings; fall back to the
  // demo ranking so the rail is never an empty box. Real rows always win.
  const source = data ? (data.rows.length > 0 ? data.rows : buildPlaceholderLeaderboard()) : null;
  const rows = source?.slice(0, RAIL_ROWS) ?? null;

  return (
    <section className={styles.card}>
      <CardHead title="Leaderboard" />
      {error && !data ? (
        <p className={styles.empty}>Standings are unavailable right now.</p>
      ) : rows === null ? (
        <ul className={styles.rows} aria-hidden="true">
          {Array.from({ length: RAIL_ROWS }, (_, i) => (
            <li key={i} className={styles.row}>
              <Skeleton width={10} height={12} />
              <Skeleton width={16} height={16} radius="sm" />
              <Skeleton width="55%" height={12} />
            </li>
          ))}
        </ul>
      ) : (
        <ul className={styles.rows}>
          {rows.map((row) => (
            <LeaderboardRailRow key={row.agent.key} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ResolvedRow({ fight, preview }: { fight: FightSummary; preview: boolean }) {
  const winnerIndex = fight.agents.findIndex((a) => a.racerId === fight.winnerRacerId);
  const winner = winnerIndex >= 0 ? fight.agents[winnerIndex] : undefined;
  const visual = winner ? (rosterVisuals(fight.agents.map((a) => a.agent))[winnerIndex] ?? null) : null;

  const body = (
    <>
      <span className={styles.rowText}>
        <span className={cx("clamp-2", styles.rowTitle)} title={fight.title}>
          {fight.title}
        </span>
        <span className={styles.rowSub}>
          {winner && visual ? (
            <>
              <AgentMonogram agent={visual} size="xs" className={styles.rowMark} />
              <span className={styles.rowWinner} style={agentStyle(visual)}>
                {winner.agent.name}
              </span>
            </>
          ) : (
            <span className={styles.rowVoid}>Voided · positions refunded</span>
          )}
        </span>
      </span>
      <span className={styles.rowFigures}>
        <span className={cx("num", styles.rowFigure)}>{winner ? formatChance(winner.yes) : "—"}</span>
        <span className={cx("num", styles.rowFigureSub)}>{formatCompactMoney(fight.volume)}</span>
      </span>
    </>
  );

  if (preview) {
    return (
      <li className={cx(styles.row, styles.rowTop)} title="Preview only: this demo runs the featured fight">
        {body}
      </li>
    );
  }
  return (
    <li>
      <Link to={`/fights/${encodeURIComponent(fight.raceId)}`} className={cx(styles.row, styles.rowTop, styles.rowLink)}>
        {body}
      </Link>
    </li>
  );
}

/** Settled fights shown in the rail; the rest live on /resolved. */
const PAST_FIGHT_ROWS = 3;

function ResolvedCard({ fights, preview }: { fights: readonly FightSummary[]; preview: boolean }) {
  const shown = fights.slice(0, PAST_FIGHT_ROWS);
  return (
    <section className={styles.card}>
      <CardHead to="/resolved" title="Past fights" />
      {shown.length === 0 ? (
        <p className={styles.empty}>Settled fights appear here with their winner.</p>
      ) : (
        <ul className={styles.rows}>
          {shown.map((fight) => (
            <ResolvedRow key={fight.raceId} fight={fight} preview={preview} />
          ))}
        </ul>
      )}
    </section>
  );
}

export type LobbyRailProps = {
  /** Settled fights, newest first. Only the first few are shown. */
  resolved: readonly FightSummary[];
  /** Hardcoded demo fights: resolved rows render, but do not link. */
  preview?: boolean;
};

export function LobbyRail({ resolved, preview = false }: LobbyRailProps) {
  return (
    <aside className={styles.rail} aria-label="Standings and resolved fights">
      <LeaderboardCard />
      <ResolvedCard fights={resolved} preview={preview} />
    </aside>
  );
}
