/**
 * Lobby fight card (handoff 2.1): a four-part flex row that reflows when the
 * card is narrow.
 *
 *   left 150px   FIGHT #0412 · status pill · clock
 *   centre       title (2 lines) · SABOTAGE + summary (1 line) · volume / traders / checkpoints
 *   agent strip  four chips from a 78px basis: name → monogram → price → change
 *   right 104px  View (action) · resolution countdown / result
 *
 * Shared by the Fights (home) and Resolved screens.
 */
import { useId } from "react";
import type { FightAgentSummary, FightSummary, SabotageSummary } from "@contract";
import {
  AgentMonogram,
  Button,
  ButtonLink,
  ChangeCents,
  ElapsedClock,
  PriceCents,
  ProgressBar,
  SabotageTag,
  Skeleton,
  StatusPill,
  Tag,
  fightPillStatus,
  type ProgressMarker,
} from "../../components";
import { agentStyle, rosterVisuals, type AgentVisual } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { formatClock, formatCompactMoney, formatFightNumber, formatNumber, formatTimeOfDay, isoDuration } from "../../lib/format";
import { RUN_STATUS_LABEL, SABOTAGE_HIDDEN_COPY } from "../../lib/labels";
import { useNow } from "../../state/clock";
import styles from "./FightCard.module.css";

// ---------------------------------------------------------------------------
// Clocks
// ---------------------------------------------------------------------------

/** "04:07" remaining until `to` (server clock), rounded up, "00:00" once passed. */
export function RemainingClock({ to, className }: { to: number; className?: string }) {
  const now = useNow(1000);
  const remaining = Math.max(0, to - now);
  return (
    <time className={cx("num", className)} dateTime={isoDuration(remaining)}>
      {formatClock(Math.ceil(remaining / 1000) * 1000)}
    </time>
  );
}

/** Left column clock: elapsed (live), start countdown (upcoming), final duration (resolved). */
export function CardClock({ fight }: { fight: FightSummary }) {
  if (fight.status === "live") {
    return (
      <span className={styles.clock}>
        <ElapsedClock from={fight.startedAt} className={styles.clockFigure} />
      </span>
    );
  }
  if (fight.status === "upcoming") {
    // The countdown lives in the right column; show the scheduled time here.
    return (
      <span className={styles.clock}>
        <span className={styles.clockPrefix}>{fight.startsAt === null ? "Starting soon" : "Opens at"}</span>
        {fight.startsAt !== null && (
          <time className={cx("num", styles.clockFigure)} dateTime={new Date(fight.startsAt).toISOString()}>
            {formatTimeOfDay(fight.startsAt)}
          </time>
        )}
      </span>
    );
  }
  return (
    <span className={styles.clock} title="Final duration">
      <span className={styles.clockPrefix}>Ran</span>
      <ElapsedClock from={fight.startedAt} until={fight.finishedAt ?? fight.startedAt} className={styles.clockFigure} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Centre
// ---------------------------------------------------------------------------

export function SabotageLine({ sabotage }: { sabotage: SabotageSummary | null }) {
  if (!sabotage) {
    return <p className={cx(styles.sabotage, styles.sabotageNone)}>No sabotage armed</p>;
  }
  if (!sabotage.revealed) {
    return (
      <p className={styles.sabotage}>
        <SabotageTag />
        <span className={cx("clamp-1", styles.sabotageText, styles.sabotageHidden)}>{SABOTAGE_HIDDEN_COPY}</span>
      </p>
    );
  }
  return (
    <p className={styles.sabotage}>
      <SabotageTag />
      <span className={cx("clamp-1", styles.sabotageText)} title={`${sabotage.summary ?? "Sabotage armed"} · fires at ${sabotage.checkpointLabel}`}>
        {sabotage.summary ?? "Sabotage armed"}
      </span>
      {sabotage.state === "fired" && (
        <Tag tone="sabotage" solid>
          Fired
        </Tag>
      )}
    </p>
  );
}

function CardMeta({ fight }: { fight: FightSummary }) {
  const count = fight.checkpointCount;
  const markers: ProgressMarker[] =
    fight.sabotage && count > 0
      ? [{ at: fight.sabotage.checkpoint / count, tone: "sabotage", label: `Sabotage at ${fight.sabotage.checkpointLabel}` }]
      : [];
  return (
    <div className={styles.meta}>
      <span className={styles.metaItem}>
        <span className={cx("num", styles.metaFigure)}>{formatCompactMoney(fight.volume)}</span> vol
      </span>
      <span className={styles.metaItem}>
        <span className={cx("num", styles.metaFigure)}>{formatNumber(fight.traders)}</span>
        {fight.traders === 1 ? " trader" : " traders"}
      </span>
      <span className={styles.metaItem} title="Highest checkpoint cleared by any agent">
        <span className={styles.metaLabel}>Checkpoint</span>
        <span className={cx("num", styles.metaFigure)}>
          {formatNumber(fight.leaderCheckpoint)}/{formatNumber(count)}
        </span>
        <ProgressBar
          className={styles.metaProgress}
          value={count > 0 ? fight.leaderCheckpoint / count : 0}
          markers={markers}
          size="xs"
          label="Leader checkpoint progress"
        />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent strip
// ---------------------------------------------------------------------------

type ChipOutcome = "winner" | "loser" | "void" | null;

function chipOutcome(fight: FightSummary, racerId: string): ChipOutcome {
  if (fight.status !== "resolved") return null;
  if (fight.voided) return "void";
  if (!fight.winnerRacerId) return null;
  return fight.winnerRacerId === racerId ? "winner" : "loser";
}

function AgentChip({ agent, visual, outcome, live }: { agent: FightAgentSummary; visual: AgentVisual; outcome: ChipOutcome; live: boolean }) {
  const blocked = live && agent.runStatus === "bad";
  return (
    <li className={cx(styles.chip, outcome && styles[outcome])} style={agentStyle(visual)}>
      <span className={styles.chipName} title={agent.agent.name}>
        {agent.agent.name}
      </span>
      <AgentMonogram agent={visual} size="sm" />
      {outcome === "void" ? (
        <span className={cx("label", styles.chipVoid)}>Void</span>
      ) : (
        <>
          <PriceCents value={agent.yes} size="lg" flash={live} tone={outcome === "winner" ? "positive" : "default"} />
          <ChangeCents value={agent.change} />
        </>
      )}
      {outcome === "winner" && <span className="sr-only">Winner</span>}
      {blocked && <span className={styles.blocked} title={RUN_STATUS_LABEL.bad} role="img" aria-label={RUN_STATUS_LABEL.bad} />}
    </li>
  );
}

function AgentStrip({ fight }: { fight: FightSummary }) {
  const visuals = rosterVisuals(fight.agents.map((a) => a.agent));
  const live = fight.status === "live";
  return (
    <ul className={styles.strip} aria-label="Agents, YES price and change">
      {fight.agents.map((agent, i) => (
        <AgentChip
          key={agent.racerId}
          agent={agent}
          visual={visuals[i] ?? rosterVisuals([agent.agent])[0]!}
          outcome={chipOutcome(fight, agent.racerId)}
          live={live}
        />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Right column
// ---------------------------------------------------------------------------

export function Resolution({ fight }: { fight: FightSummary }) {
  if (fight.status === "live") {
    const estimate = fight.estimatedResolutionAt;
    const cap = fight.closesAt;
    return (
      <div
        className={styles.resolution}
        title={estimate !== null ? "Estimated from the fastest agent's pace" : "No estimate yet: time left before the safety cap"}
      >
        <span className={styles.resolutionLabel}>Resolves</span>
        <span className={styles.resolutionValue}>
          {estimate !== null ? (
            <>
              ~<RemainingClock to={estimate} />
            </>
          ) : cap !== null ? (
            <>
              <span className={styles.resolutionPrefix}>Cap</span> <RemainingClock to={cap} />
            </>
          ) : (
            <span className="num">—</span>
          )}
        </span>
      </div>
    );
  }
  if (fight.status === "upcoming") {
    return (
      <div className={styles.resolution}>
        <span className={styles.resolutionLabel}>Opens in</span>
        <span className={styles.resolutionValue}>
          {fight.startsAt !== null ? <RemainingClock to={fight.startsAt} /> : <span className="num">—</span>}
        </span>
      </div>
    );
  }
  if (fight.voided) {
    return (
      <div className={styles.resolution} title="No agent finished before the cap. Positions were refunded.">
        <span className={styles.resolutionLabel}>Result</span>
        <span className={cx(styles.resolutionValue, styles.resolutionVoid)}>Void</span>
      </div>
    );
  }
  const winner = fight.agents.find((a) => a.racerId === fight.winnerRacerId);
  return (
    <div className={styles.resolution}>
      <span className={styles.resolutionLabel}>Result</span>
      {winner ? (
        <span className={styles.resolutionWinner}>
          Won by{" "}
          <span className={styles.winnerName} style={agentStyle(winner.agent)}>
            {winner.agent.name}
          </span>
        </span>
      ) : (
        <span className={cx(styles.resolutionValue, styles.resolutionVoid)}>Settling</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export type FightCardProps = {
  fight: FightSummary;
  className?: string;
  /** A hardcoded demo card (./placeholders): looks real, but View does nothing. */
  preview?: boolean;
};

export function FightCard({ fight, className, preview = false }: FightCardProps) {
  const titleId = useId();
  const number = formatFightNumber(fight.number);
  return (
    <article className={cx(styles.container, className)} aria-labelledby={titleId}>
      <div className={styles.card}>
        <div className={styles.left}>
          <span className={cx("label", styles.number)}>
            Fight <span className="num">{number}</span>
          </span>
          <StatusPill status={fightPillStatus(fight)} size="sm" />
          <CardClock fight={fight} />
        </div>

        <div className={styles.centre}>
          <h2 id={titleId} className={cx("clamp-2", styles.title)} title={fight.title}>
            {fight.title}
          </h2>
          <SabotageLine sabotage={fight.sabotage} />
          <CardMeta fight={fight} />
        </div>

        <AgentStrip fight={fight} />

        <div className={styles.right}>
          {preview ? (
            <Button
              variant="action"
              size="sm"
              block
              className={cx(styles.view, styles.viewPreview)}
              aria-disabled="true"
              title="Preview only: this demo runs the featured fight"
              aria-label={`Fight ${number} is a preview`}
            >
              View
            </Button>
          ) : (
            <ButtonLink
              to={`/fights/${encodeURIComponent(fight.raceId)}`}
              variant="action"
              size="sm"
              block
              className={styles.view}
              aria-label={`View fight ${number}`}
            >
              View
            </ButtonLink>
          )}
          <Resolution fight={fight} />
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// List and loading state
// ---------------------------------------------------------------------------

export function FightCardList({ fights, label, preview = false }: { fights: readonly FightSummary[]; label: string; preview?: boolean }) {
  return (
    <ol className={styles.list} aria-label={label}>
      {fights.map((fight) => (
        <li key={fight.raceId}>
          <FightCard fight={fight} preview={preview} />
        </li>
      ))}
    </ol>
  );
}

export function FightCardSkeleton() {
  return (
    <div className={styles.container} aria-hidden="true">
      <div className={styles.card}>
        <div className={styles.left}>
          <Skeleton width={84} height={10} />
          <Skeleton width={56} height={18} radius="pill" />
          <Skeleton width={44} height={12} />
        </div>
        <div className={styles.centre}>
          <Skeleton width="88%" height={13} />
          <Skeleton width="60%" height={13} />
          <Skeleton width="72%" height={18} />
          <Skeleton width="50%" height={10} />
        </div>
        <div className={styles.strip}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={cx(styles.chip, styles.chipSkeleton)}>
              <Skeleton width="80%" height={10} />
              <Skeleton width={22} height={22} radius="sm" />
              <Skeleton width={36} height={16} />
              <Skeleton width={28} height={10} />
            </div>
          ))}
        </div>
        <div className={styles.right}>
          <Skeleton width="100%" height={26} radius="md" />
          <Skeleton width={60} height={10} />
          <Skeleton width={48} height={13} />
        </div>
      </div>
    </div>
  );
}

export function FightCardListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className={styles.list} role="status" aria-label="Loading fights">
      {Array.from({ length: count }, (_, i) => (
        <FightCardSkeleton key={i} />
      ))}
    </div>
  );
}
