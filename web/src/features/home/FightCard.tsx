/**
 * Lobby fight card: a self-contained block, two to a row in the lobby grid.
 *
 *   head     FIGHT #0412 · status pill · clock
 *   title    the task (2 lines) · SABOTAGE + summary (1 line)
 *   agents   one row per agent: mark, name over a progress rule, chance
 *   footer   volume / traders / checkpoints · resolution · View
 *
 * Shared by the Fights (home) and Resolved screens.
 */
import { useId } from "react";
import type { FightAgentSummary, FightSummary, SabotageSummary } from "@contract";
import {
  AgentMonogram,
  Button,
  ButtonLink,
  ElapsedClock,
  SabotageTag,
  Skeleton,
  StatusPill,
  Tag,
  fightPillStatus,
} from "../../components";
import { agentStyle, rosterVisuals, type AgentVisual } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { formatChance, formatClock, formatCompactMoney, formatFightNumber, formatNumber, formatTimeOfDay, isoDuration } from "../../lib/format";
import { RUN_STATUS_LABEL, SABOTAGE_HIDDEN_COPY } from "../../lib/labels";
import { useNow } from "../../state/clock";
import { PREVIEW_FIGHT_HINT } from "./placeholders";
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

function AgentRow({ agent, visual, outcome, live, checkpointCount }: {
  agent: FightAgentSummary;
  visual: AgentVisual;
  outcome: ChipOutcome;
  live: boolean;
  checkpointCount: number;
}) {
  const blocked = live && agent.runStatus === "bad";
  const progress = checkpointCount > 0 ? Math.min(1, agent.checkpoint / checkpointCount) : 0;
  return (
    <li className={cx(styles.agentRow, outcome && styles[outcome])} style={agentStyle(visual)}>
      <AgentMonogram agent={visual} size="sm" className={styles.agentMark} />
      <span className={styles.agentName} title={agent.agent.name}>
        {agent.agent.name}
        {/* The rule under the name is that agent's course progress. */}
        <span className={styles.agentRule} aria-hidden="true">
          <span className={styles.agentRuleFill} style={{ width: `${progress * 100}%` }} />
        </span>
      </span>
      {blocked && <span className={styles.blocked} title={RUN_STATUS_LABEL.bad} role="img" aria-label={RUN_STATUS_LABEL.bad} />}
      {outcome === "void" ? (
        <span className={cx("label", styles.chipVoid)}>Void</span>
      ) : (
        <span className={cx("num", styles.agentChance)}>{formatChance(agent.yes)}</span>
      )}
      {outcome === "winner" && <span className="sr-only">Winner</span>}
    </li>
  );
}

function AgentStrip({ fight }: { fight: FightSummary }) {
  const visuals = rosterVisuals(fight.agents.map((a) => a.agent));
  const live = fight.status === "live";
  return (
    <ul className={styles.strip} aria-label="Agents and win chance">
      {fight.agents.map((agent, i) => (
        <AgentRow
          key={agent.racerId}
          agent={agent}
          visual={visuals[i] ?? rosterVisuals([agent.agent])[0]!}
          outcome={chipOutcome(fight, agent.racerId)}
          live={live}
          checkpointCount={fight.checkpointCount}
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
  /** A sample card (./placeholders): tagged Preview, with a disabled View. */
  preview?: boolean;
};

export function FightCard({ fight, className, preview = false }: FightCardProps) {
  const titleId = useId();
  const number = formatFightNumber(fight.number);
  return (
    <article className={cx(styles.container, className)} aria-labelledby={titleId}>
      <div className={cx(styles.card, preview && styles.cardPreview)}>
        <div className={styles.head}>
          <span className={cx("label", styles.number)}>
            Fight <span className="num">{number}</span>
          </span>
          <StatusPill status={fightPillStatus(fight)} size="sm" />
          {preview && (
            <Tag tone="edge" title={PREVIEW_FIGHT_HINT}>
              Preview
            </Tag>
          )}
          <CardClock fight={fight} />
        </div>

        <h2 id={titleId} className={cx("clamp-2", styles.title)} title={fight.title}>
          {fight.title}
        </h2>
        <SabotageLine sabotage={fight.sabotage} />

        <AgentStrip fight={fight} />

        <div className={styles.footer}>
          <CardMeta fight={fight} />
          <div className={styles.footerEnd}>
            <Resolution fight={fight} />
            {preview ? (
              // aria-disabled rather than disabled: the button stays hoverable
              // and focusable, so the reason is reachable as its tooltip.
              <Button
                variant="subtle"
                size="sm"
                className={cx(styles.view, styles.viewPreview)}
                aria-disabled="true"
                title={PREVIEW_FIGHT_HINT}
                aria-label={`View fight ${number} (preview, unavailable)`}
                onClick={(event) => event.preventDefault()}
              >
                View
              </Button>
            ) : (
              <ButtonLink
                to={`/fights/${encodeURIComponent(fight.raceId)}`}
                variant="subtle"
                size="sm"
                className={styles.view}
                aria-label={`View fight ${number}`}
              >
                View
              </ButtonLink>
            )}
          </div>
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
        <div className={styles.head}>
          <Skeleton width={84} height={10} />
          <Skeleton width={56} height={18} radius="pill" />
        </div>
        <Skeleton width="88%" height={18} />
        <Skeleton width="52%" height={12} />
        <div className={styles.strip}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={styles.agentRow}>
              <Skeleton width={16} height={16} radius="sm" />
              <Skeleton width="60%" height={12} />
              <Skeleton width={32} height={14} />
            </div>
          ))}
        </div>
        <div className={styles.footer}>
          <Skeleton width="45%" height={10} />
          <Skeleton width={64} height={26} radius="md" />
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
