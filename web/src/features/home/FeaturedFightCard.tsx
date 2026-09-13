/**
 * Featured fight: the lobby's large hero card, laid out like Kalshi's
 * featured market. It is the demo's one real fight, live over its stream.
 *
 *   header   FEATURED · FIGHT #0412 · status pill · clock
 *            title (2 lines) · SABOTAGE + summary
 *   body     outcomes (left): monogram, name, progress, % chance, Yes / No
 *            chart (right): win probability over time, sabotage marker
 *   footer   volume · traders · leader checkpoint · resolution · View fight
 *
 * Yes / No open the fight screen with that bet slip preselected.
 */
import { useId } from "react";
import { useNavigate } from "react-router-dom";
import type { FightAgentSummary, FightSummary, Side } from "@contract";
import { AgentMonogram, ButtonLink, ChangeCents, EmptyState, Skeleton, StatusPill, fightPillStatus } from "../../components";
import { agentStyle, rosterVisuals, type AgentVisual } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { formatCents, formatChance, formatCompactMoney, formatFightNumber, formatNumber } from "../../lib/format";
import { RUN_STATUS_LABEL } from "../../lib/labels";
import { useFightStream } from "../fight/useFightStream";
import { ProbabilityChart } from "../market/ProbabilityChart";
import { SLIP_PARAM, formatSlipParam } from "../market/slipParam";
import { CardClock, Resolution, SabotageLine } from "./FightCard";
import styles from "./FeaturedFightCard.module.css";

/** Chance as a whole percent. Lives in lib/format; re-exported for this screen. */
export { formatChance } from "../../lib/format";

type Outcome = "winner" | "loser" | null;

function outcomeFor(fight: FightSummary, racerId: string): Outcome {
  if (fight.status !== "resolved" || fight.voided || !fight.winnerRacerId) return null;
  return fight.winnerRacerId === racerId ? "winner" : "loser";
}

type OutcomeRowProps = {
  agent: FightAgentSummary;
  visual: AgentVisual;
  checkpointCount: number;
  outcome: Outcome;
  tradable: boolean;
  closedReason: string;
  onPick: (racerId: string, side: Side) => void;
};

function OutcomeRow({ agent, visual, checkpointCount, outcome, tradable, closedReason, onPick }: OutcomeRowProps) {
  const name = agent.agent.name;
  return (
    <li className={cx(styles.outcome, outcome && styles[outcome])} style={agentStyle(visual)}>
      <AgentMonogram agent={visual} size="md" />
      <div className={styles.identity}>
        <span className={styles.name} title={name}>
          {name}
        </span>
        <span className={styles.progress}>
          <span className="num">
            {formatNumber(agent.checkpoint)}/{formatNumber(checkpointCount)}
          </span>{" "}
          checkpoints
          {agent.runStatus !== "run" && (
            <span className={cx(styles.status, styles[agent.runStatus])}> · {RUN_STATUS_LABEL[agent.runStatus]}</span>
          )}
        </span>
      </div>
      <div className={styles.chance}>
        <span className={cx("num", styles.chanceValue)}>{formatChance(agent.yes)}</span>
        {/* The chance restates the Yes price, so the only figure worth adding
            here is a move. At no change there is nothing to add. */}
        {agent.change !== 0 && <ChangeCents value={agent.change} />}
      </div>
      <div className={styles.sides}>
        <button
          type="button"
          className={cx(styles.side, styles.yes)}
          disabled={!tradable}
          title={tradable ? undefined : closedReason}
          onClick={() => onPick(agent.racerId, "yes")}
          aria-label={`Buy Yes on ${name} at ${formatCents(agent.yes)}`}
        >
          Yes <span className="num">{formatCents(agent.yes)}</span>
        </button>
        <button
          type="button"
          className={cx(styles.side, styles.no)}
          disabled={!tradable}
          title={tradable ? undefined : closedReason}
          onClick={() => onPick(agent.racerId, "no")}
          aria-label={`Buy No on ${name} at ${formatCents(agent.no)}`}
        >
          No <span className="num">{formatCents(agent.no)}</span>
        </button>
      </div>
    </li>
  );
}

function closedReasonFor(fight: FightSummary): string {
  if (fight.marketStatus === "frozen") return "Trading is frozen for the rest of this fight";
  if (fight.marketStatus === "resolved") return "This market has settled";
  if (fight.marketStatus === "unresolved") return "This fight was voided and positions refunded";
  return "";
}

export function FeaturedFightCard({ fight }: { fight: FightSummary }) {
  const titleId = useId();
  const navigate = useNavigate();
  const { fight: detail, priceHistory } = useFightStream(fight.raceId);
  // The detail stream carries fresher prices; ignore it while it still holds another fight.
  const current = detail && detail.raceId === fight.raceId ? detail : null;
  const shown: FightSummary = current ?? fight;
  const history = current ? priceHistory : [];

  const href = `/fights/${encodeURIComponent(shown.raceId)}`;
  const tradable = shown.marketStatus === "open";
  const visuals = rosterVisuals(shown.agents.map((a) => a.agent));
  const number = formatFightNumber(shown.number);
  const pick = (racerId: string, side: Side) => {
    navigate(`${href}?${SLIP_PARAM}=${encodeURIComponent(formatSlipParam(racerId, side))}`);
  };

  return (
    <article className={styles.card} aria-labelledby={titleId}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>
          <span className={cx("label", styles.featured)}>Featured</span>
          <span className={cx("label", styles.number)}>
            Fight <span className="num">{number}</span>
          </span>
          <StatusPill status={fightPillStatus(shown)} size="sm" />
          <CardClock fight={shown} />
        </div>
        <h2 id={titleId} className={cx("clamp-2", styles.title)} title={shown.title}>
          {shown.title}
        </h2>
        <SabotageLine sabotage={shown.sabotage} />
      </header>

      <div className={styles.body}>
        <section className={styles.outcomesPanel} aria-label="Outcomes">
          <div className={cx("label", styles.outcomesHead)}>
            <span>Agent</span>
            <span className={styles.headChance}>Chance</span>
          </div>
          <ul className={styles.outcomes}>
            {shown.agents.map((agent, index) => (
              <OutcomeRow
                key={agent.racerId}
                agent={agent}
                visual={visuals[index] ?? rosterVisuals([agent.agent])[0]!}
                checkpointCount={shown.checkpointCount}
                outcome={outcomeFor(shown, agent.racerId)}
                tradable={tradable}
                closedReason={closedReasonFor(shown)}
                onPick={pick}
              />
            ))}
          </ul>
        </section>

        <div className={styles.chartPanel}>
          <ProbabilityChart
            agents={shown.agents}
            priceHistory={history}
            sabotageAt={shown.sabotage?.firedAt ?? null}
            sabotageMarkers={current?.agents
              .filter((agent) => agent.sabotageHitAt !== null)
              .map((agent) => ({
                racerId: agent.racerId,
                at: agent.sabotageHitAt!,
                label: `${agent.agent.name} hit`,
              })) ?? []}
            sabotageLabel="Sabotage"
            endAt={shown.status === "resolved" ? shown.finishedAt : null}
            volume={shown.volume}
            className={styles.chart}
          />
        </div>
      </div>

      <footer className={styles.footer}>
        <div className={styles.meta}>
          <span className={styles.metaItem}>
            <span className={cx("num", styles.metaFigure)}>{formatCompactMoney(shown.volume)}</span> vol
          </span>
          <span className={styles.metaItem}>
            <span className={cx("num", styles.metaFigure)}>{formatNumber(shown.traders)}</span>
            {shown.traders === 1 ? " trader" : " traders"}
          </span>
          <span className={styles.metaItem} title="Highest checkpoint cleared by any agent">
            Leader{" "}
            <span className={cx("num", styles.metaFigure)}>
              {formatNumber(shown.leaderCheckpoint)}/{formatNumber(shown.checkpointCount)}
            </span>
          </span>
          <Resolution fight={shown} />
        </div>
        <ButtonLink to={href} variant="action" size="md" className={styles.view} aria-label={`View fight ${number}`}>
          View fight
        </ButtonLink>
      </footer>
    </article>
  );
}

/** Shown when the backend has no fight yet (live mode before POST /races). */
export function FeaturedFightEmpty() {
  return (
    <div className={cx(styles.card, styles.emptyCard)}>
      <EmptyState
        title="The featured fight hasn’t been created yet"
        description="It appears here, live, as soon as the race is created on the backend."
      />
    </div>
  );
}

export function FeaturedFightSkeleton() {
  return (
    <div className={styles.card} aria-hidden="true">
      <div className={styles.header}>
        <Skeleton width={180} height={10} />
        <Skeleton width="70%" height={20} />
        <Skeleton width="45%" height={14} />
      </div>
      <div className={styles.body}>
        <div className={styles.outcomesPanel}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} width="100%" height={44} radius="md" />
          ))}
        </div>
        <div className={styles.chartPanel}>
          <Skeleton width="100%" height="100%" radius="md" />
        </div>
      </div>
    </div>
  );
}
