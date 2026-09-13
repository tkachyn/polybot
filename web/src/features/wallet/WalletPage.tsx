import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { LedgerEntry, WalletTransferResponse } from "@contract";
import { EmptyState, ErrorBanner, Page, PageHeader } from "../../components";
import { useSession } from "../../state/session";
import { BalanceCard } from "./BalanceCard";
import { TransferPanel } from "./TransferPanel";
import { WalletActivity } from "./WalletActivity";
import { parseTransferTab, walletActivity, type TransferKind } from "./transfer";
import styles from "./Wallet.module.css";

/** Route "/wallet". `?tab=deposit|withdraw` selects the transfer tab (the top-bar Deposit button links here). */
export function WalletPage() {
  const { userId, meta, account, portfolio, status, error, refresh, applyAccount } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = parseTransferTab(params.get("tab"));
  const [recent, setRecent] = useState<LedgerEntry[]>([]);
  const [retrying, setRetrying] = useState(false);

  const setTab = useCallback(
    (next: TransferKind) => {
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          out.set("tab", next);
          return out;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const onTransferred = useCallback(
    (res: WalletTransferResponse) => {
      applyAccount(res.account, res.serverTime);
      setRecent((prev) => [res.entry, ...prev.filter((e) => e.id !== res.entry.id)]);
    },
    [applyAccount],
  );

  const retry = useCallback(() => {
    setRetrying(true);
    void refresh().finally(() => setRetrying(false));
  }, [refresh]);

  const entries = useMemo(() => walletActivity(portfolio?.history, recent), [portfolio, recent]);

  if (meta?.demoMode) {
    return (
      <Page title="Demo bankroll">
        <PageHeader title="Demo bankroll" subtitle="Every judge starts with the same locked balance." />
        <EmptyState
          title="Wallet transfers are locked"
          description="Deposits and withdrawals are disabled during the judged demo so every participant competes from an equal starting balance."
        />
      </Page>
    );
  }

  return (
    <Page title="Wallet">
      <PageHeader title="Wallet" subtitle="Deposit and withdraw virtual arena credits." />
      <div className={styles.stack}>
        {status !== "ready" && error && <ErrorBanner error={error} title="Couldn’t load your wallet." onRetry={retry} retrying={retrying} />}
        <div className={styles.layout}>
          <BalanceCard account={account} />
          <TransferPanel tab={tab} onTabChange={setTab} userId={userId} account={account} onTransferred={onTransferred} />
        </div>
        <WalletActivity entries={entries} loaded={portfolio !== null || recent.length > 0} />
      </div>
    </Page>
  );
}
