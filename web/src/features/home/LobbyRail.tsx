/**
 * The lobby's right rail, read top to bottom: who is winning, what is next,
 * what already happened.
 *
 *   Leaderboard  agent ranking over the leaderboard window, by win rate
 *   Upcoming     fights that have not opened yet, soonest first
 *   Past fights  one row per settled fight, with its winner
 *
 * Past fights is a compact read of the Resolved screen, so its header links
 * there. The standings have no page of their own; this is the whole of them.
 */
import { Link } from "react-router-dom";
import type { FightSummary, LeaderboardRow } from "@contract";
import { AgentMonogram, IconChevronRight, Skeleton, Tag } from "../../components";
import { useLeaderboard } from "../leaderboard/useLeaderboard";
import { agentStyle, rosterVisuals } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { formatCompactMoney, formatNumber, formatPercent, formatTimeOfDay } from "../../lib/format";
import { PREVIEW_FIGHT_HINT, PREVIEW_STANDINGS_HINT, buildPlaceholderLeaderboard } from "./placeholders";
import styles from "./LobbyRail.module.css";

/** Standings rows shown. The standings have no page of their own, so the header doesn't link. */
const RAIL_ROWS = 5;

/**
 * A card header. With `to`, the whole header leads to that screen. With
 * `preview`, the card's rows are samples (./placeholders) and say so.
 */
function CardHead({ to, title, preview = null }: { to?: string; title: string; preview?: string | null }) {
  const main = (
    <span className={styles.headMain}>
      <h2 className={styles.headTitle}>{title}</h2>
      {preview && (
        <Tag tone="edge" title={preview}>
          Preview
        </Tag>
      )}
    </span>
  );
  if (!to) {
    return <div className={styles.head}>{main}</div>;
  }
  return (
    <Link to={to} className={styles.head}>
      {main}
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
        {/* Plain text flow: in a flex row each fragment took a gap as well as its space. */}
        <span className={styles.rowSubLine}>
          Won <span className="num">{formatNumber(row.wins)}</span> of <span className="num">{formatNumber(row.fights)}</span>
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
  // demo ranking, tagged Preview, so the rail is never an empty box. Real
  // rows always win.
  const preview = data !== null && data.rows.length === 0;
  const source = data ? (preview ? buildPlaceholderLeaderboard() : data.rows) : null;
  const rows = source?.slice(0, RAIL_ROWS) ?? null;

  return (
    <section className={styles.card}>
      <CardHead title="Leaderboard" preview={preview ? PREVIEW_STANDINGS_HINT : null} />
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
              <span className={styles.rowWon}>won</span>
            </>
          ) : (
            <span className={styles.rowVoid}>Voided · positions refunded</span>
          )}
        </span>
      </span>
      {/* The result is the winner on the left; the figure is what was traded. */}
      <span className={styles.rowFigures}>
        <span className={cx("num", styles.rowFigure, styles.rowFigureSmall)}>{formatCompactMoney(fight.volume)}</span>
        <span className={styles.rowFigureSub}>volume</span>
      </span>
    </>
  );

  if (preview) {
    return (
      <li className={cx(styles.row, styles.rowTop)} title={PREVIEW_FIGHT_HINT}>
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
/** Scheduled fights shown in the rail. */
const UPCOMING_ROWS = 3;

function UpcomingRow({ fight, preview }: { fight: FightSummary; preview: boolean }) {
  const body = (
    <>
      <span className={styles.rowText}>
        <span className={cx("clamp-2", styles.rowTitle)} title={fight.title}>
          {fight.title}
        </span>
        <span className={styles.rowSubLine}>
          {fight.sabotage?.revealed && fight.sabotage.summary ? fight.sabotage.summary : "Sabotage armed"}
        </span>
      </span>
      <span className={styles.rowFigures}>
        <span className={cx("num", styles.rowFigure, styles.rowFigureSmall)}>
          {fight.startsAt === null ? "Soon" : formatTimeOfDay(fight.startsAt)}
        </span>
        <span className={styles.rowFigureSub}>opens</span>
      </span>
    </>
  );

  if (preview) {
    return (
      <li className={cx(styles.row, styles.rowTop)} title={PREVIEW_FIGHT_HINT}>
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

function UpcomingCard({ fights, preview }: { fights: readonly FightSummary[]; preview: boolean }) {
  // Soonest first; a fight with no time yet sorts last.
  const shown = [...fights]
    .sort((a, b) => (a.startsAt ?? Infinity) - (b.startsAt ?? Infinity))
    .slice(0, UPCOMING_ROWS);
  return (
    <section className={styles.card}>
      <CardHead title="Upcoming" preview={preview ? PREVIEW_FIGHT_HINT : null} />
      {shown.length === 0 ? (
        <p className={styles.empty}>Scheduled fights appear here before they open.</p>
      ) : (
        <ul className={styles.rows}>
          {shown.map((fight) => (
            <UpcomingRow key={fight.raceId} fight={fight} preview={preview} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ResolvedCard({ fights, preview }: { fights: readonly FightSummary[]; preview: boolean }) {
  const shown = fights.slice(0, PAST_FIGHT_ROWS);
  return (
    <section className={styles.card}>
      <CardHead to="/resolved" title="Past fights" preview={preview ? PREVIEW_FIGHT_HINT : null} />
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
  /** Scheduled fights. Only the soonest few are shown. */
  upcoming: readonly FightSummary[];
  /** Settled fights, newest first. Only the first few are shown. */
  resolved: readonly FightSummary[];
  /** Hardcoded demo fights: rows render, but do not link. */
  preview?: boolean;
  /** Demo upcoming fights, when the scheduled ones are placeholders. */
  upcomingPreview?: boolean;
};

export function LobbyRail({ upcoming, resolved, preview = false, upcomingPreview = preview }: LobbyRailProps) {
  return (
    <aside className={styles.rail} aria-label="Standings, upcoming and past fights">
      <LeaderboardCard />
      <UpcomingCard fights={upcoming} preview={upcomingPreview} />
      <ResolvedCard fights={resolved} preview={preview} />
    </aside>
  );
}
