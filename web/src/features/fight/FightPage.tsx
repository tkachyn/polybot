/**
 * Live / upcoming fight screen (handoff 2.2). Never scrolls at 1024x720 and
 * up: header strips on top, arena + 344px market rail beneath, every region
 * floored and clipped. Owns the bet slip and passes it to the rail and arena.
 * During the finish moment (see useFightStream) the sabotage strip gives its
 * place to the result.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { FightDetail, PricePoint } from "@contract";
import type { StreamStatus } from "../../api/stream";
import { Button, ErrorBanner, Skeleton, SkeletonText } from "../../components";
import { cx } from "../../lib/cx";
import { serverNow } from "../../state/clock";
import { useSession } from "../../state/session";
import { MarketRail } from "../market/MarketRail";
import { SLIP_PARAM, slipFromParam } from "../market/slipParam";
import type { Slip } from "../market/types";
import { Arena } from "./Arena";
import { FightInvite } from "../demo/FightInvite";
import { isRaceOver, rosterByRacer, rosterKey } from "./fightView";
import { FinishStrip, MasterStrip, SabotageStrip } from "./FightHeader";
import { FightIntro } from "./FightIntro";
import { hasSeenFightIntro, introOpensIn, markFightIntroSeen } from "./fightIntroState";
import { FIGHT_INTRO_MARGIN_MS } from "./introVideo";
import styles from "./FightPage.module.css";

export type FightPageProps = {
  fight: FightDetail;
  priceHistory: PricePoint[];
  streamStatus: StreamStatus;
};

export function FightPage({ fight, priceHistory, streamStatus }: FightPageProps) {
  // Judge invites promise every phone an equal bankroll, which only demo mode provides.
  const { meta } = useSession();
  const [params, setParams] = useSearchParams();
  const [introAvailable, setIntroAvailable] = useState(true);
  // "lead-in": timed to end as the fight starts (the agents wait for it); "replay": from the top, on request.
  const [intro, setIntro] = useState<"lead-in" | "replay" | null>(null);
  const { status, startsAt } = fight;
  useEffect(() => {
    if (!introAvailable || hasSeenFightIntro(fight.raceId)) return undefined;
    const opensIn = introOpensIn({ status, startsAt }, serverNow());
    if (opensIn === null) return undefined;
    const timer = setTimeout(() => setIntro((open) => open ?? "lead-in"), opensIn);
    return () => clearTimeout(timer);
  }, [fight.raceId, status, startsAt, introAvailable]);
  const closeIntro = () => {
    markFightIntroSeen(fight.raceId);
    setIntro(null);
  };
  const introUnavailable = () => {
    markFightIntroSeen(fight.raceId);
    setIntroAvailable(false);
    setIntro(null);
  };
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
      <MasterStrip
        fight={fight}
        action={
          <span className={styles.headerActions}>
            {introAvailable && (
              <Button variant="subtle" size="sm" onClick={() => setIntro("replay")}>
                Replay intro
              </Button>
            )}
            {meta?.demoMode && <FightInvite raceId={fight.raceId} />}
          </span>
        }
      />
      {isRaceOver(fight) ? <FinishStrip fight={fight} roster={roster} /> : <SabotageStrip fight={fight} roster={roster} />}
      <div className={styles.body}>
        <Arena fight={fight} roster={roster} slip={activeSlip} streamStatus={streamStatus} className={styles.arena} />
        <aside className={styles.rail} aria-label="Market">
          <MarketRail fight={fight} priceHistory={priceHistory} slip={activeSlip} onSlipChange={setSlip} />
        </aside>
      </div>
      {intro && (
        <FightIntro
          fightNumber={fight.number}
          endsAt={intro === "lead-in" && startsAt !== null ? startsAt - FIGHT_INTRO_MARGIN_MS : null}
          onClose={closeIntro}
          onUnavailable={introUnavailable}
        />
      )}
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
