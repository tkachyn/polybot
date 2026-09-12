import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { TraderLeaderboardResponse } from "@contract";
import { getFightTraders, isAbortError } from "../../api/client";
import { ButtonLink, EmptyState, IconArrowLeft, Page, PageHeader, SignedMoney, SignedPercent } from "../../components";
import { formatMoney } from "../../lib/format";
import { useSession } from "../../state/session";
import styles from "./JudgeStandingsPage.module.css";

const POLL_MS = 2_000;

export function JudgeStandingsPage() {
  const { raceId } = useParams<{ raceId: string }>();
  const { userId } = useSession();
  const [data, setData] = useState<TraderLeaderboardResponse | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!raceId) return;
    try {
      setData(await getFightTraders(raceId, signal));
      setFailed(false);
    } catch (error) {
      if (!isAbortError(error)) setFailed(true);
    }
  }, [raceId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load]);

  if (!raceId) return <Page title="Judge standings"><EmptyState title="Fight not found" /></Page>;

  return (
    <Page title="Judge standings">
      <PageHeader
        title="Judge standings"
        subtitle="Live mark-to-market ranking for this fight"
        actions={<ButtonLink to={`/fights/${encodeURIComponent(raceId)}`} variant="ghost" icon={<IconArrowLeft size={14} />}>Back to fight</ButtonLink>}
      />
      {failed && <p className={styles.error}>Standings are reconnecting…</p>}
      {data && data.rows.length === 0 ? (
        <EmptyState title="No bets yet" description="Standings appear after the first judge places a bet." />
      ) : (
        <ol className={styles.board} aria-live="polite">
          {(data?.rows ?? []).map((row) => (
            <li key={row.userId} className={`${styles.row} ${row.userId === userId ? styles.mine : ""}`}>
              <span className={styles.rank}>{row.rank}</span>
              <span className={styles.name}>{row.displayName}{row.userId === userId ? " (you)" : ""}</span>
              <span className={styles.metric}><span>Profit</span><SignedMoney value={row.pnl} size="md" /></span>
              <span className={styles.metric}><span>Return</span><SignedPercent value={row.returnPct} size="md" /></span>
              <span className={styles.metric}><span>Wagered</span><strong>{formatMoney(row.wagered)}</strong></span>
            </li>
          ))}
        </ol>
      )}
      <p className={styles.note}>Open positions are valued at the latest market price. Rankings finalize when the fight settles.</p>
    </Page>
  );
}
