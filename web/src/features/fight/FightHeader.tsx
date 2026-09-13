/**
 * The two header strips of the fight screen: master task, then sabotage.
 * Each keeps to what a spectator acts on; the details sit in tooltips.
 */
import type { ReactNode } from "react";
import type { FightDetail, SabotageDetail } from "@contract";
import { AgentMonogram, ElapsedClock, SabotageTag, StatusPill, Tag, fightPillStatus } from "../../components";
import { cx } from "../../lib/cx";
import { formatDuration, formatFightNumber } from "../../lib/format";
import { SABOTAGE_HIDDEN_COPY } from "../../lib/labels";
import { finishView, isRaceOver, visualFor, type RosterVisuals } from "./fightView";
import { ClockCountdown } from "./ClockCountdown";
import styles from "./FightHeader.module.css";

// ---------------------------------------------------------------------------
// Master task strip
// ---------------------------------------------------------------------------

export function MasterStrip({ fight, action }: { fight: FightDetail; action?: ReactNode }) {
  // During the finish moment the screen still shows the arena, but the pill says what happened.
  const pill = isRaceOver(fight) ? (fight.voided ? "voided" : "resolved") : fightPillStatus(fight);
  return (
    <section className={styles.master} aria-label="Master task">
      <div className={styles.idBlock}>
        <span className={cx("label num", styles.fightNo)}>Fight {formatFightNumber(fight.number)}</span>
        <StatusPill status={pill} size="sm" />
        <FightClock fight={fight} />
      </div>

      {/* The title names the task; one line of detail under it (whole in the tooltip). */}
      <div className={styles.task}>
        <h1 className={cx("clamp-2", styles.title)} title={fight.title}>
          {fight.title}
        </h1>
        <p className={cx("clamp-1", styles.taskText)} title={fight.taskDetail}>
          {fight.taskDetail}
        </p>
      </div>

      {/* Volume and the market's state live in the rail's footer. */}
      {action && <div className={styles.invite}>{action}</div>}
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

// ---------------------------------------------------------------------------
// Finish strip: replaces the sabotage strip during the finish moment
// ---------------------------------------------------------------------------

export function FinishStrip({ fight, roster }: { fight: FightDetail; roster: RosterVisuals }) {
  const result = finishView(fight);
  if (result.kind === "void") {
    return (
      <section className={cx(styles.finish, styles.finishVoid)} aria-label="Result" role="status">
        <Tag tone="neutral">Time’s up</Tag>
        <p className={cx("clamp-1", styles.finishText)}>No agent finished before the hard stop</p>
        <span className={styles.finishMeta}>Market void · positions refunded</span>
      </section>
    );
  }
  const winner = fight.agents.find((a) => a.racerId === result.racerId);
  return (
    <section className={styles.finish} aria-label="Result" role="status">
      <Tag tone="positive" solid>
        Winner
      </Tag>
      {winner && <AgentMonogram agent={visualFor(roster, winner)} size="xs" />}
      <p className={cx("clamp-1", styles.finishText)}>
        {result.name} finished first
        {result.durationMs !== null && (
          <>
            {" in "}
            <span className="num">{formatDuration(result.durationMs)}</span>
          </>
        )}
      </p>
      <span className={styles.finishMeta}>Market settled · results next</span>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sabotage strip
// ---------------------------------------------------------------------------

/** What the sabotage is, whether it has fired, and who it hit. The lanes' checkpoint dots mark where. */
export function SabotageStrip({ fight, roster }: { fight: FightDetail; roster: RosterVisuals }) {
  const sabotage = fight.sabotage;
  if (!sabotage) {
    return (
      <section className={cx(styles.sabotage, styles.sabotageNone)} aria-label="Sabotage">
        <Tag tone="neutral">No sabotage</Tag>
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
        <Tag tone="neutral">Never triggered</Tag>
      </span>
    );
  }

  const fired = sabotage.steps.filter((step) => step.firedAt !== null).length;
  const hit = sabotage.hitRacerIds
    .map((id) => fight.agents.find((a) => a.racerId === id))
    .filter((a): a is NonNullable<typeof a> => a !== undefined);
  const hitNames = hit.map((a) => a.agent.name).join(", ");

  return (
    <span className={styles.sabState}>
      <Tag tone="sabotage" solid title={`${fired} of ${sabotage.stepCount} sabotage steps fired`}>
        Fired{sabotage.stepCount > 1 && <span className="num"> {fired}/{sabotage.stepCount}</span>}
      </Tag>
      {hit.length > 0 && (
        <span className={styles.hits} title={`Hit: ${hitNames}`}>
          <span className="label label-sm">Hit</span>
          {hit.map((a) => (
            <AgentMonogram key={a.racerId} agent={visualFor(roster, a)} size="xs" />
          ))}
          <span className="sr-only">{hitNames}</span>
        </span>
      )}
    </span>
  );
}
