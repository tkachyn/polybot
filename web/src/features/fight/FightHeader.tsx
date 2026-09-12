/**
 * The two header strips of the fight screen: master task, then sabotage.
 */
import type { FightDetail, SabotageDetail } from "@contract";
import { AgentMonogram, ElapsedClock, SabotageTag, StatusPill, Tag, fightPillStatus } from "../../components";
import { cx } from "../../lib/cx";
import { formatCompactMoney, formatFightNumber, formatNumber } from "../../lib/format";
import { HAZARD_LABEL, SABOTAGE_HIDDEN_COPY } from "../../lib/labels";
import { marketStateView, sabotageFiredLabel, visualFor, type RosterVisuals } from "./fightView";
import { ClockCountdown } from "./ClockCountdown";
import styles from "./FightHeader.module.css";

// ---------------------------------------------------------------------------
// Master task strip
// ---------------------------------------------------------------------------

export function MasterStrip({ fight }: { fight: FightDetail }) {
  return (
    <section className={styles.master} aria-label="Master task">
      <div className={styles.idBlock}>
        <span className={cx("label num", styles.fightNo)}>Fight {formatFightNumber(fight.number)}</span>
        <StatusPill status={fightPillStatus(fight)} size="sm" />
        <FightClock fight={fight} />
      </div>

      <div className={styles.task}>
        <h1 className={cx("clamp-2", styles.title)} title={fight.title}>
          {fight.title}
        </h1>
        <div className={styles.taskLines}>
          <p className={styles.taskLine} title={fight.taskDetail}>
            <span className={cx("label label-sm", styles.taskKey)}>Task</span>
            <span className={cx("clamp-1", styles.taskText)}>{fight.taskDetail}</span>
          </p>
          <p className={styles.taskLine} title={fight.successCondition}>
            <span className={cx("label label-sm", styles.taskKey)}>Success</span>
            <span className={cx("clamp-1", styles.taskText)}>{fight.successCondition}</span>
          </p>
        </div>
      </div>

      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt className="label label-sm">Volume</dt>
          <dd className={cx("num", styles.statValue)}>{formatCompactMoney(fight.volume)}</dd>
        </div>
        <div className={styles.stat}>
          <dt className="label label-sm">Traders</dt>
          <dd className={cx("num", styles.statValue)}>{formatNumber(fight.traders)}</dd>
        </div>
        <MarketState fight={fight} />
      </dl>
    </section>
  );
}

function FightClock({ fight }: { fight: FightDetail }) {
  if (fight.status === "upcoming") {
    return (
      <span className={styles.clock}>
        <span className="label label-sm">Starts in</span>
        {fight.startsAt === null ? (
          <span className={styles.clockText}>Soon</span>
        ) : (
          <ClockCountdown to={fight.startsAt} expiredLabel="Starting…" className={styles.clockValue} />
        )}
      </span>
    );
  }
  return (
    <span className={styles.clock}>
      <span className="label label-sm">Elapsed</span>
      <ElapsedClock from={fight.startedAt} until={fight.finishedAt} className={styles.clockValue} />
    </span>
  );
}

function MarketState({ fight }: { fight: FightDetail }) {
  const market = marketStateView(fight);
  return (
    <div className={cx(styles.stat, styles.market)}>
      <dt className="label label-sm">Market</dt>
      <dd className={styles.statValue}>
        <span className={styles.marketValue}>
          <span className={cx(styles.marketDot, styles[`market_${market.tone}`])} aria-hidden="true" />
          {market.label}
        </span>
        {market.detail && (
          <span className={styles.marketSub}>
            {market.detail}
            {market.countdownTo !== null && (
              <>
                {" "}
                <ClockCountdown to={market.countdownTo} expiredLabel="now" className={styles.marketCountdown} />
              </>
            )}
          </span>
        )}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sabotage strip
// ---------------------------------------------------------------------------

export function SabotageStrip({ fight, roster }: { fight: FightDetail; roster: RosterVisuals }) {
  const sabotage = fight.sabotage;
  if (!sabotage) {
    return (
      <section className={cx(styles.sabotage, styles.sabotageNone)} aria-label="Sabotage">
        <Tag tone="neutral">No sabotage</Tag>
        <p className={cx("clamp-1", styles.sabSummary, styles.sabMuted)}>This fight runs without environment sabotage.</p>
      </section>
    );
  }

  const summary = sabotage.revealed ? sabotage.summary : null;
  const tooltip = [sabotage.summary, sabotage.detail].filter(Boolean).join(" — ");

  return (
    <section className={styles.sabotage} aria-label="Sabotage">
      <SabotageTag />
      <p className={cx("clamp-1", styles.sabSummary, !summary && styles.sabMuted)} title={tooltip || undefined}>
        {summary ?? (sabotage.revealed ? "Details pending" : SABOTAGE_HIDDEN_COPY)}
      </p>
      {sabotage.revealed && sabotage.hazardType && (
        <Tag tone="neutral" className={styles.hazard}>
          {HAZARD_LABEL[sabotage.hazardType]}
        </Tag>
      )}
      <span className={styles.sabFires} title={`Fires at checkpoint ${sabotage.checkpoint}: ${sabotage.checkpointLabel}`}>
        <span>Fires at</span>
        <span className={styles.sabCheckpoint}>{sabotage.checkpointLabel}</span>
        <span className={cx("num", styles.sabCp)}>
          {sabotage.checkpoint}/{fight.checkpointCount}
        </span>
      </span>
      <SabotageStateView sabotage={sabotage} fight={fight} roster={roster} />
    </section>
  );
}

function SabotageStateView({ sabotage, fight, roster }: { sabotage: SabotageDetail; fight: FightDetail; roster: RosterVisuals }) {
  if (sabotage.state === "armed") {
    return (
      <span className={styles.sabState}>
        <Tag tone="sabotage">Armed</Tag>
      </span>
    );
  }
  if (sabotage.state === "expired") {
    return (
      <span className={styles.sabState}>
        <Tag tone="neutral">Expired</Tag>
        <span className={styles.sabMuted}>Never triggered</span>
      </span>
    );
  }

  const hit = sabotage.hitRacerIds
    .map((id) => fight.agents.find((a) => a.racerId === id))
    .filter((a): a is NonNullable<typeof a> => a !== undefined);
  const hitNames = hit.map((a) => a.agent.name).join(", ");

  return (
    <span className={styles.sabState}>
      <Tag tone="sabotage" solid>
        Fired
      </Tag>
      {sabotage.firedAt !== null && <span className="num">at {sabotageFiredLabel(sabotage.firedAt, fight.startedAt)}</span>}
      <span className={styles.hits} title={hit.length ? `Hit: ${hitNames}` : "No agent hit"}>
        {hit.length === 0 ? (
          <span className={styles.sabMuted}>No agent hit</span>
        ) : (
          <>
            <span className="label label-sm">Hit</span>
            {hit.map((a) => (
              <span key={a.racerId} className={styles.hit}>
                <AgentMonogram agent={visualFor(roster, a)} size="xs" />
                {hit.length <= 2 && <span className={styles.hitName}>{a.agent.name}</span>}
              </span>
            ))}
            {hit.length > 2 && <span className="sr-only">{hitNames}</span>}
          </>
        )}
      </span>
    </span>
  );
}
