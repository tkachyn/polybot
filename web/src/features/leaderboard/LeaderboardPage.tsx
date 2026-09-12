import { useCallback, useEffect, useState } from "react";
import { Button, ErrorBanner, IconRefresh, Page, PageHeader, RelativeTime } from "../../components";
import { formatDate, formatNumber } from "../../lib/format";
import { LeaderboardTable } from "./LeaderboardTable";
import { useLeaderboard } from "./useLeaderboard";
import { buildPlaceholderLeaderboard } from "../home/placeholders";
import styles from "./Leaderboard.module.css";

/** Route "/leaderboard": 30-day agent ranking from GET /api/leaderboard. */
export function LeaderboardPage() {
  const { data, error, loading, reload } = useLeaderboard();
  const days = data?.windowDays ?? 30;
  // Only a manual refresh spins the button; background polls stay quiet.
  const [manual, setManual] = useState(false);
  const refresh = useCallback(() => {
    setManual(true);
    reload();
  }, [reload]);
  useEffect(() => {
    if (!loading) setManual(false);
  }, [loading]);

  const subtitle = data ? (
    <span className="num">
      Last {formatNumber(days)} days · since {formatDate(data.since)}
    </span>
  ) : (
    "Last 30 days"
  );

  const actions = (
    <div className={styles.headerMeta}>
      {data && (
        <span>
          Updated <RelativeTime at={data.serverTime} />
        </span>
      )}
      <Button size="sm" variant="ghost" icon={<IconRefresh size={14} />} onClick={refresh} loading={manual && loading}>
        Refresh
      </Button>
    </div>
  );

  // With no resolved fights the backend has no standings; show the demo
  // ranking rather than an empty table, so this page and the lobby rail agree.
  const rows = data ? (data.rows.length > 0 ? data.rows : buildPlaceholderLeaderboard()) : null;

  return (
    <Page title="Leaderboard">
      <PageHeader title="Leaderboard" subtitle={subtitle} actions={actions} />
      <div className={styles.stack}>
        <ErrorBanner error={error} title={data ? "Couldn’t refresh the leaderboard." : "Couldn’t load the leaderboard."} onRetry={refresh} retrying={manual && loading} />
        {(data || !error) && (
          <>
            <LeaderboardTable rows={rows} />
            <p className={styles.caption}>
              Ranked by win rate, then fights. Resolved, non-void fights only. Sabotage survival is the share of hits after which the agent cleared
              another checkpoint or finished. Backer ROI is the return on YES positions in that agent.
            </p>
          </>
        )}
      </div>
    </Page>
  );
}
