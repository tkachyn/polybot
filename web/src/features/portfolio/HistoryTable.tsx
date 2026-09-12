import { useMemo, useState } from "react";
import type { LedgerEntry, LedgerEntryType } from "@contract";
import { Link } from "react-router-dom";
import { AgentMonogram, EmptyState, Money, SegmentedControl, SignedMoney, Skeleton, TableWrap, Tag, tableStyles, type SegmentedOption, type TagTone } from "../../components";
import { cx } from "../../lib/cx";
import { formatCents, formatDateTime, formatFightNumber, formatLogTime, formatShares } from "../../lib/format";
import styles from "./Portfolio.module.css";

/** Ledger wording for this screen (settlements read as Won / Lost). */
const TYPE_LABEL: Readonly<Record<LedgerEntryType, string>> = {
  deposit: "Deposit",
  withdraw: "Withdraw",
  buy: "Buy",
  sell: "Sell",
  payout: "Won",
  loss: "Lost",
  refund: "Refund",
};

const TYPE_TONE: Readonly<Record<LedgerEntryType, TagTone>> = {
  deposit: "neutral",
  withdraw: "neutral",
  buy: "neutral",
  sell: "neutral",
  payout: "positive",
  loss: "sabotage",
  refund: "neutral",
};

const TYPE_ORDER: readonly LedgerEntryType[] = ["deposit", "withdraw", "buy", "sell", "payout", "loss", "refund"];

/** The server keeps the latest 200 entries. */
const HISTORY_LIMIT = 200;

type Filter = "all" | LedgerEntryType;

const COLUMNS = 8;

export type HistoryTableProps = {
  /** Newest first. Null while loading. */
  history: LedgerEntry[] | null;
};

export function HistoryTable({ history }: HistoryTableProps) {
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(() => {
    const out: Partial<Record<LedgerEntryType, number>> = {};
    for (const entry of history ?? []) out[entry.type] = (out[entry.type] ?? 0) + 1;
    return out;
  }, [history]);

  const options = useMemo<SegmentedOption<Filter>[]>(
    () => [
      { value: "all", label: "All", count: history?.length ?? 0 },
      ...TYPE_ORDER.map((type) => ({ value: type, label: TYPE_LABEL[type], count: counts[type] ?? 0, disabled: !counts[type] && filter !== type })),
    ],
    [counts, history, filter],
  );

  const rows = useMemo(() => (history ? (filter === "all" ? history : history.filter((e) => e.type === filter)) : null), [history, filter]);

  return (
    <section className={styles.section} aria-labelledby="portfolio-history">
      <div className={styles.sectionHeader}>
        <h2 id="portfolio-history" className={styles.sectionTitle}>
          History
        </h2>
        <div className={styles.filterScroll}>
          <SegmentedControl options={options} value={filter} onChange={setFilter} aria-label="Filter history by type" size="sm" />
        </div>
      </div>

      {rows && rows.length === 0 ? (
        <EmptyState
          size="md"
          title={filter === "all" ? "No activity yet" : `No ${TYPE_LABEL[filter].toLowerCase()} entries`}
          description={filter === "all" ? "Deposits, trades and settlements appear here, newest first." : undefined}
        />
      ) : (
        <TableWrap>
          <table className={cx(tableStyles.table, tableStyles.compact)}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Fight</th>
                <th>Outcome</th>
                <th className={tableStyles.num}>Shares</th>
                <th className={cx(tableStyles.num, styles.hideReflow)}>Price</th>
                <th className={tableStyles.num}>Amount</th>
                <th className={tableStyles.num}>Balance after</th>
              </tr>
            </thead>
            <tbody>
              {rows === null
                ? [0, 1, 2, 3].map((i) => (
                    <tr key={i}>
                      <td colSpan={COLUMNS}>
                        <Skeleton height={12} />
                      </td>
                    </tr>
                  ))
                : rows.map((entry) => <HistoryRow key={entry.id} entry={entry} />)}
            </tbody>
          </table>
        </TableWrap>
      )}
      {history && history.length >= HISTORY_LIMIT && <p className={styles.footnote}>Showing the latest {HISTORY_LIMIT} entries.</p>}
    </section>
  );
}

function HistoryRow({ entry }: { entry: LedgerEntry }) {
  return (
    <tr className={tableStyles.row}>
      <td className={cx("num", styles.nowrap, tableStyles.muted)} title={formatLogTime(entry.at)}>
        {formatDateTime(entry.at)}
      </td>
      <td>
        <Tag tone={TYPE_TONE[entry.type]}>{TYPE_LABEL[entry.type]}</Tag>
      </td>
      <td>
        {entry.raceId ? (
          <Link to={`/fights/${encodeURIComponent(entry.raceId)}`} className={cx("num", styles.fightNumLink)} title={entry.fightTitle ?? undefined}>
            {formatFightNumber(entry.fightNumber)}
          </Link>
        ) : (
          <span className={tableStyles.muted}>—</span>
        )}
      </td>
      <td>
        <Outcome entry={entry} />
      </td>
      <td className={tableStyles.num}>{formatShares(entry.quantity)}</td>
      <td className={cx(tableStyles.num, tableStyles.muted, styles.hideReflow)}>{formatCents(entry.price)}</td>
      <td className={tableStyles.num}>
        <SignedMoney value={entry.amount} size="sm" />
      </td>
      <td className={tableStyles.num}>
        <Money value={entry.balanceAfter} size="sm" tone="secondary" />
      </td>
    </tr>
  );
}

function Outcome({ entry }: { entry: LedgerEntry }) {
  if (entry.type === "deposit" || entry.type === "withdraw") {
    return <span className={tableStyles.muted}>{entry.method === "virtual" ? "Virtual credits" : "—"}</span>;
  }
  return (
    <span className={styles.outcome}>
      {entry.agent ? (
        <>
          <AgentMonogram agent={entry.agent} size="xs" />
          <span>{entry.agent.name}</span>
        </>
      ) : (
        <span className={tableStyles.muted}>—</span>
      )}
      {entry.side && <span className={cx(styles.side, entry.side === "yes" ? styles.yes : styles.no)}>{entry.side === "yes" ? "Yes" : "No"}</span>}
      {entry.type === "refund" && <Tag tone="neutral">Void</Tag>}
    </span>
  );
}
