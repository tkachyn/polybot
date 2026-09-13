import type { Position } from "@contract";
import { Link } from "react-router-dom";
import { AgentMonogram, ButtonLink, EmptyState, Money, PriceCents, SignedMoney, SignedPercent, Skeleton, TableWrap, tableStyles } from "../../components";
import { cx } from "../../lib/cx";
import { formatFightNumber, formatNumber, formatShares } from "../../lib/format";
import { SellControl } from "./SellControl";
import styles from "./Portfolio.module.css";

export type PositionsTableProps = {
  /** Null while the portfolio is loading. */
  positions: Position[] | null;
  onSold: (message: string) => void;
};

const COLUMNS = 9;

export function PositionsTable({ positions, onSold }: PositionsTableProps) {
  return (
    <section className={styles.section} aria-labelledby="portfolio-positions">
      <div className={styles.sectionHeader}>
        <h2 id="portfolio-positions" className={styles.sectionTitle}>
          Open positions
          {positions && positions.length > 0 && <span className={cx("num", styles.count)}>{formatNumber(positions.length)}</span>}
        </h2>
      </div>

      {positions && positions.length === 0 ? (
        <EmptyState
          size="md"
          title="No open positions"
          description="Buy YES or NO on an agent in a live fight and it shows up here, marked to the live price."
          action={
            <ButtonLink to="/" variant="ghost" size="sm">
              Browse fights
            </ButtonLink>
          }
        />
      ) : (
        <TableWrap>
          <table className={tableStyles.table}>
            <thead>
              <tr>
                <th>Fight</th>
                <th>Agent</th>
                <th>Side</th>
                <th className={tableStyles.num}>Position</th>
                <th className={tableStyles.num}>Avg</th>
                <th className={tableStyles.num}>Now</th>
                <th className={tableStyles.num}>Value</th>
                <th className={tableStyles.num}>P/L</th>
                <th className={tableStyles.num}>
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {positions === null
                ? [0, 1, 2].map((i) => (
                    <tr key={i}>
                      <td colSpan={COLUMNS}>
                        <Skeleton height={14} />
                      </td>
                    </tr>
                  ))
                : positions.map((position) => (
                    <PositionRow key={`${position.raceId}:${position.racerId}:${position.side}`} position={position} onSold={onSold} />
                  ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </section>
  );
}

function PositionRow({ position, onSold }: { position: Position; onSold: (message: string) => void }) {
  return (
    <tr className={tableStyles.row}>
      <td>
        <Link to={`/fights/${encodeURIComponent(position.raceId)}`} className={styles.fightLink} title={position.fightTitle}>
          <span className={cx("label", "num")}>{formatFightNumber(position.fightNumber)}</span>
          <span className={cx(styles.fightTitle, "clamp-2")}>{position.fightTitle}</span>
        </Link>
      </td>
      <td>
        <span className={tableStyles.cellMain}>
          <AgentMonogram agent={position.agent} size="sm" />
          <span className={cx(tableStyles.strong, styles.nowrap)}>{position.agent.name}</span>
        </span>
      </td>
      <td>
        <span className={cx(styles.side, position.side === "yes" ? styles.yes : styles.no)}>{position.side === "yes" ? "Yes" : "No"}</span>
      </td>
      <td className={tableStyles.num}>{formatShares(position.quantity)}</td>
      <td className={tableStyles.num}>
        <PriceCents value={position.avgPrice} size="sm" tone="secondary" />
      </td>
      <td className={tableStyles.num}>
        <PriceCents value={position.currentPrice} size="sm" flash />
      </td>
      <td className={tableStyles.num} title={`What selling all ${formatShares(position.quantity)} shares now would return`}>
        <Money value={position.value} size="sm" />
      </td>
      <td className={tableStyles.num}>
        <span className={styles.pl}>
          <SignedMoney value={position.pnl} size="sm" />
          <SignedPercent value={position.pnlPct} size="sm" className={styles.plPct} />
        </span>
      </td>
      <td className={cx(tableStyles.num, styles.actionCell)}>
        <SellControl position={position} onSold={onSold} />
      </td>
    </tr>
  );
}
