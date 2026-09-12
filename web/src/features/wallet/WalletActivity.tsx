import type { LedgerEntry } from "@contract";
import { EmptyState, IconWallet, RelativeTime, SkeletonText, TableWrap, tableStyles } from "../../components";
import { cx } from "../../lib/cx";
import { formatDateTime, formatMoney, formatSignedMoney } from "../../lib/format";
import { LEDGER_TYPE_LABEL } from "../../lib/labels";
import { useNow } from "../../state/clock";
import styles from "./Wallet.module.css";

export type WalletActivityProps = {
  entries: LedgerEntry[];
  /** False until the portfolio has loaded. */
  loaded: boolean;
};

const METHOD_LABEL: Record<string, string> = { virtual: "Virtual credits" };

/** Deposits and withdrawals, newest first. */
export function WalletActivity({ entries, loaded }: WalletActivityProps) {
  const now = useNow(60_000);

  return (
    <section className={styles.activity} aria-labelledby="wallet-activity-title">
      <div className={styles.activityHeader}>
        <h2 id="wallet-activity-title" className={styles.sectionTitle}>
          Recent wallet activity
        </h2>
        <span className={styles.activityNote}>Deposits and withdrawals. Trades and payouts are in Portfolio.</span>
      </div>

      {!loaded ? (
        <TableWrap>
          <div style={{ padding: "var(--space-4)" }}>
            <SkeletonText lines={3} />
          </div>
        </TableWrap>
      ) : entries.length === 0 ? (
        <EmptyState icon={<IconWallet size={20} />} title="No transfers yet" description="Deposits and withdrawals you make appear here." />
      ) : (
        <TableWrap>
          <table className={tableStyles.table}>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Type</th>
                <th scope="col">Method</th>
                <th scope="col" className={tableStyles.num}>
                  Amount
                </th>
                <th scope="col" className={tableStyles.num}>
                  Balance after
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className={tableStyles.row}>
                  <td>
                    <span className={styles.when}>
                      <span className="num">{formatDateTime(entry.at, now)}</span>
                      <RelativeTime at={entry.at} className={styles.whenSub} />
                    </span>
                  </td>
                  <td>
                    <span className={styles.typeCell}>
                      <span className={styles.typeMark} aria-hidden="true">
                        {entry.type === "deposit" ? "+" : "−"}
                      </span>
                      {LEDGER_TYPE_LABEL[entry.type]}
                    </span>
                  </td>
                  <td className={tableStyles.muted}>{entry.method ? (METHOD_LABEL[entry.method] ?? entry.method) : "—"}</td>
                  <td className={cx("num", tableStyles.num, tableStyles.strong)}>{formatSignedMoney(entry.amount)}</td>
                  <td className={cx("num", tableStyles.num, tableStyles.muted)}>{formatMoney(entry.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </section>
  );
}
