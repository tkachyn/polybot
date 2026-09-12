import type { ReactNode } from "react";
import type { Account } from "@contract";
import { Money, SignedMoney, Skeleton } from "../../components";
import { formatNumber } from "../../lib/format";
import styles from "./Wallet.module.css";

export type BalanceCardProps = {
  /** Null while the session is loading. */
  account: Account | null;
};

function Figure({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className={styles.figure}>
      <span className="label">{label}</span>
      <span className={styles.figureValue}>{value}</span>
      {sub !== undefined && <span className={`num ${styles.figureSub}`}>{sub}</span>}
    </div>
  );
}

function LifetimeItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.lifetimeItem}>
      <dt className="label label-sm">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Available balance, funds held in positions, portfolio value and lifetime totals. */
export function BalanceCard({ account }: BalanceCardProps) {
  const loading = account === null;
  const skeleton = <Skeleton width={72} height={14} />;
  const lifetime = account?.lifetime;

  return (
    <section className={styles.card} aria-labelledby="wallet-balance-title">
      <div className={styles.hero}>
        <span id="wallet-balance-title" className="label">
          Available balance
        </span>
        <span className={styles.heroValue}>{loading ? <Skeleton width={160} height={24} /> : <Money value={account.balance} size="xl" />}</span>
        <span className={styles.heroSub}>Virtual arena credits, ready to trade or withdraw</span>
      </div>

      <div className={styles.figures}>
        <Figure
          label="Held in positions"
          value={loading ? skeleton : <Money value={account.held} size="md" />}
          sub={loading ? undefined : "Cost basis of open positions"}
        />
        <Figure
          label="Positions value"
          value={loading ? skeleton : <Money value={account.positionsValue} size="md" />}
          sub={
            loading ? undefined : (
              <>
                Unrealized <SignedMoney value={account.unrealizedPnl} size="sm" />
              </>
            )
          }
        />
        <Figure
          label="Portfolio value"
          value={loading ? skeleton : <Money value={account.equity} size="md" />}
          sub={loading ? undefined : "Balance + positions value"}
        />
      </div>

      <div className={styles.lifetime}>
        <div className={styles.cardHeader}>
          <h2 className="label">Lifetime</h2>
          {lifetime && (
            <span className="num label label-sm">
              {formatNumber(lifetime.fightsTraded)} {lifetime.fightsTraded === 1 ? "fight" : "fights"} traded
            </span>
          )}
        </div>
        <dl className={styles.lifetimeGrid}>
          <LifetimeItem label="Deposited">{lifetime ? <Money value={lifetime.deposited} size="md" /> : skeleton}</LifetimeItem>
          <LifetimeItem label="Withdrawn">{lifetime ? <Money value={lifetime.withdrawn} size="md" /> : skeleton}</LifetimeItem>
          <LifetimeItem label="Wagered">{lifetime ? <Money value={lifetime.wagered} size="md" /> : skeleton}</LifetimeItem>
          <LifetimeItem label="Won">{lifetime ? <Money value={lifetime.won} size="md" /> : skeleton}</LifetimeItem>
          <LifetimeItem label="Refunded">{lifetime ? <Money value={lifetime.refunded} size="md" /> : skeleton}</LifetimeItem>
          <LifetimeItem label="Realized P/L">{lifetime ? <SignedMoney value={lifetime.realizedPnl} size="md" /> : skeleton}</LifetimeItem>
        </dl>
      </div>
    </section>
  );
}
