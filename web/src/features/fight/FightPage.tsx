/**
 * Live / upcoming fight screen (handoff 2.2). Never scrolls at 1024x720 and
 * up: header strips on top, arena + 344px market rail beneath, every region
 * floored and clipped. Owns the bet slip and passes it to the rail and arena.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { FightDetail, PricePoint } from "@contract";
import type { StreamStatus } from "../../api/stream";
import { ErrorBanner, Skeleton, SkeletonText } from "../../components";
import { cx } from "../../lib/cx";
import { MarketRail } from "../market/MarketRail";
import { SLIP_PARAM, slipFromParam } from "../market/slipParam";
import type { Slip } from "../market/types";
import { Arena } from "./Arena";
import { FightInvite } from "../demo/FightInvite";
import { rosterByRacer, rosterKey } from "./fightView";
import { MasterStrip, SabotageStrip } from "./FightHeader";
import styles from "./FightPage.module.css";

export type FightPageProps = {
  fight: FightDetail;
  priceHistory: PricePoint[];
  streamStatus: StreamStatus;
};

export function FightPage({ fight, priceHistory, streamStatus }: FightPageProps) {
  const [params, setParams] = useSearchParams();
  // `?slip=racer-1:yes` (from the lobby's featured card) opens the order form once.
  const [slip, setSlip] = useState<Slip | null>(() => slipFromParam(fight, params.get(SLIP_PARAM)));
  useEffect(() => {
    if (!params.has(SLIP_PARAM)) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(SLIP_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [params, setParams]);
  // Keyed on the roster identity: `fight` is a new object on every stream update.
  const key = rosterKey(fight.agents);
  const roster = useMemo(() => rosterByRacer(fight.agents), [key]);
  const activeSlip = slip && fight.agents.some((a) => a.racerId === slip.racerId) ? slip : null;

  return (
    <div className={styles.screen}>
      <MasterStrip fight={fight} action={<FightInvite raceId={fight.raceId} />} />
      <SabotageStrip fight={fight} roster={roster} />
      <div className={styles.body}>
        <Arena fight={fight} roster={roster} slip={activeSlip} streamStatus={streamStatus} className={styles.arena} />
        <aside className={styles.rail} aria-label="Market">
          <MarketRail fight={fight} priceHistory={priceHistory} slip={activeSlip} onSlipChange={setSlip} />
        </aside>
      </div>
    </div>
  );
}

/** Loading state in the same frame as the screen, so nothing jumps when data lands. */
export function FightPageSkeleton({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className={styles.screen} aria-busy="true">
      {error ? (
        <ErrorBanner error={error} title="Couldn’t load this fight." onRetry={onRetry} />
      ) : (
        <div className={cx(styles.skeletonBox, styles.skeletonMaster)}>
          <Skeleton width={120} height={12} />
          <Skeleton width="60%" height={16} />
          <Skeleton width="40%" height={10} />
        </div>
      )}
      <div className={cx(styles.skeletonBox, styles.skeletonSabotage)}>
        <Skeleton width="45%" height={12} />
      </div>
      <div className={styles.body}>
        <div className={styles.skeletonGrid}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={styles.skeletonBox}>
              <SkeletonText lines={2} />
            </div>
          ))}
        </div>
        <div className={cx(styles.skeletonBox, styles.rail)}>
          <SkeletonText lines={4} />
        </div>
      </div>
    </div>
  );
}
