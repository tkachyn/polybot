/**
 * Portfolio (handoff 2.4): four stat tiles, open positions with a sell path,
 * and the ledger history. Live via the session's user stream.
 */
import { useCallback, useState } from "react";
import { ConnectionIndicator, ErrorBanner, IconClose, Money, Page, PageHeader, SignedMoney, SignedPercent, StatTile } from "../../components";
import { formatMoney, formatNumber } from "../../lib/format";
import { useSession } from "../../state/session";
import { HistoryTable } from "./HistoryTable";
import { PositionsTable } from "./PositionsTable";
import styles from "./Portfolio.module.css";

type Notice = { id: number; message: string };

export function PortfolioPage() {
  const { portfolio, account: sessionAccount, status, error, streamStatus, refresh } = useSession();
  const account = portfolio?.account ?? sessionAccount;
  const loaded = portfolio !== null;
  const [notice, setNotice] = useState<Notice | null>(null);
  const [retrying, setRetrying] = useState(false);

  const onSold = useCallback((message: string) => setNotice({ id: Date.now(), message }), []);
  const retry = useCallback(() => {
    setRetrying(true);
    void refresh().finally(() => setRetrying(false));
  }, [refresh]);

  const openPct = account && account.held > 0 ? account.unrealizedPnl / account.held : null;

  return (
    <Page title="Portfolio">
      <PageHeader
        title="Portfolio"
        subtitle={
          account ? (
            <span className="num">
              {formatNumber(account.lifetime.fightsTraded)} {account.lifetime.fightsTraded === 1 ? "fight" : "fights"} traded ·{" "}
              {formatMoney(account.lifetime.wagered)} wagered
            </span>
          ) : undefined
        }
        // Until the portfolio loads, the stream is still coming up: "Connecting", never "Live" or "Offline".
        actions={<ConnectionIndicator status={!loaded && streamStatus !== "reconnecting" ? "connecting" : streamStatus} />}
      />

      {!loaded && status === "error" && <ErrorBanner error={error} title="Couldn’t load your portfolio." onRetry={retry} retrying={retrying} className={styles.banner} />}

      {notice && (
        <div className={styles.notice} role="status" key={notice.id}>
          <span className={styles.noticeText}>{notice.message}</span>
          <button type="button" className={styles.noticeDismiss} onClick={() => setNotice(null)} aria-label="Dismiss">
            <IconClose size={14} />
          </button>
        </div>
      )}

      <div className={styles.stats}>
        <StatTile
          label="Portfolio value"
          loading={!account}
          value={<Money value={account?.equity} />}
          sub={
            <>
              <Money value={account?.positionsValue} size="sm" tone="inherit" /> in positions
            </>
          }
        />
        <StatTile
          label="Cash"
          loading={!account}
          value={<Money value={account?.balance} />}
          sub={
            <>
              <Money value={account?.held} size="sm" tone="inherit" /> cost basis held
            </>
          }
        />
        <StatTile
          label="Open P/L"
          loading={!account}
          value={<SignedMoney value={account?.unrealizedPnl} />}
          sub={openPct !== null ? <SignedPercent value={openPct} size="sm" /> : "No open positions"}
        />
        <StatTile
          label="Realized P/L"
          loading={!account}
          value={<SignedMoney value={account?.lifetime.realizedPnl} />}
          sub={
            <>
              <Money value={account?.lifetime.won} size="sm" tone="inherit" /> won lifetime
            </>
          }
        />
      </div>

      <PositionsTable positions={portfolio?.positions ?? null} onSold={onSold} />
      <HistoryTable history={portfolio?.history ?? null} />
    </Page>
  );
}
