/**
 * Resolved fights. Route "/resolved".
 *
 * Every resolved fight from the shared lobby (useFights), newest resolution
 * first, rendered with the home screen's FightCard. Summary line: count,
 * voided count and total volume.
 */
import { useCallback, useMemo, useState } from "react";
import { ButtonLink, EmptyState, ErrorBanner, Page, PageHeader, Skeleton } from "../../components";
import { formatCompactMoney, formatNumber } from "../../lib/format";
import { useFights } from "../../state/fights";
import { FightCardList, FightCardListSkeleton } from "../home/FightCard";
import { FILTER_PARAM, resolvedNewestFirst, totalVolume } from "../home/filter";
import styles from "./ResolvedPage.module.css";

export function ResolvedPage() {
  const { fights, error, loaded, refresh } = useFights();
  const [retrying, setRetrying] = useState(false);

  const resolved = useMemo(() => resolvedNewestFirst(fights), [fights]);
  const volume = useMemo(() => totalVolume(resolved), [resolved]);
  const voided = useMemo(() => resolved.filter((f) => f.voided).length, [resolved]);
  const liveCount = useMemo(() => fights.filter((f) => f.status === "live").length, [fights]);

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      await refresh();
    } finally {
      setRetrying(false);
    }
  }, [refresh]);

  const subtitle = loaded ? (
    <span className="num">
      {formatNumber(resolved.length)} {resolved.length === 1 ? "fight" : "fights"} settled
      {voided > 0 && ` · ${formatNumber(voided)} voided`} · {formatCompactMoney(volume)} total volume
    </span>
  ) : (
    <Skeleton width={240} height={12} className={styles.subtitleSkeleton} />
  );

  return (
    <Page title="Resolved">
      <PageHeader title="Resolved" subtitle={subtitle} />

      <div className={styles.body}>
        {/* A dropped stream after the first load is the global connection banner's job. */}
        {error && !loaded && (
          <ErrorBanner
            error={error}
            title="Couldn’t load fights."
            onRetry={() => void retry()}
            retrying={retrying}
          />
        )}

        {!loaded ? (
          <FightCardListSkeleton count={4} />
        ) : resolved.length === 0 ? (
          <EmptyState
            title="No resolved fights yet"
            description="When a fight settles, its winner, final prices and volume are listed here."
            action={
              liveCount > 0 ? (
                <ButtonLink to={`/?${FILTER_PARAM}=live`} size="sm">
                  Watch live fights
                </ButtonLink>
              ) : undefined
            }
          />
        ) : (
          <FightCardList fights={resolved} label="Resolved fights" />
        )}
      </div>
    </Page>
  );
}
