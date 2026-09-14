/**
 * Featured fight: the lobby's large hero card, laid out like Kalshi's
 * featured market. It shows the fight picked by ./featured, live over its
 * stream.
 *
 *   header   FEATURED · FIGHT #0412 · status pill · clock
 *            title (2 lines) · SABOTAGE + summary
 *   body     outcomes (left): monogram, name, progress, % chance, Yes / No
 *            chart (right): win probability over time, sabotage marker
 *   footer   volume · traders · sabotages · resolution · View fight
 *
 * Yes / No open the fight screen with that bet slip preselected. Once the
 * market settles, the chance and Yes / No give way to each agent's result
 * and what one YES share paid ($1.00 or $0.00). As the fight is about to
 * start, its intro plays over the whole card (./FeaturedIntro).
 */
import { useId } from "react";
import { useNavigate } from "react-router-dom";
import type { FightAgentSummary, FightSummary, RunStatus, Side } from "@contract";
import { AgentMonogram, ButtonLink, ChangeCents, EmptyState, Skeleton, StatusPill, Tag, fightPillStatus } from "../../components";
import { agentStyle, rosterVisuals, type AgentVisual } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { formatCents, formatChance, formatCompactMoney, formatMoney, formatNumber } from "../../lib/format";
import { RUN_STATUS_LABEL } from "../../lib/labels";
import { useFightStream } from "../fight/useFightStream";
import { ProbabilityChart } from "../market/ProbabilityChart";
import { SLIP_PARAM, formatSlipParam } from "../market/slipParam";
import { FeaturedIntro } from "./FeaturedIntro";
import {
  CardClock,
  DISPLAYED_SABOTAGE_COUNT,
  Resolution,
  SabotageLine,
  sabotageProgress,
} from "./FightCard";
import styles from "./FeaturedFightCard.module.css";

/** Chance as a whole percent. Lives in lib/format; re-exported for this screen. */
export { formatChance } from "../../lib/format";

/**
 * Run status as one word, so it fits beside the checkpoint count in the
 * narrow outcome column. The full label is the progress line's tooltip.
 */
const SHORT_RUN_STATUS: Readonly<Record<Exclude<RunStatus, "run">, string>> = {
  warn: "Looping",
  recovering: "Recovering",
  bad: "Blocked",
};

/** How the market settled for one agent; null until it has. */
type Settlement = "won" | "lost" | "void";

function settlementFor(fight: FightSummary, racerId: string): Settlement | null {
  if (fight.status !== "resolved") return null;
  if (fight.voided) return "void";
  if (!fight.winnerRacerId) return null;
  return fight.winnerRacerId === racerId ? "won" : "lost";
}

type OutcomeRowProps = {
  agent: FightAgentSummary;
  visual: AgentVisual;
  checkpointCount: number;
  /** The fight is running: show each agent's run status. */
  live: boolean;
  settlement: Settlement | null;
  tradable: boolean;
  closedReason: string;
  onPick: (racerId: string, side: Side) => void;
};

function OutcomeRow({ agent, visual, checkpointCount, live, settlement, tradable, closedReason, onPick }: OutcomeRowProps) {
  const name = agent.agent.name;
  const status = live && agent.runStatus !== "run" ? agent.runStatus : null;
  const progressTitle = `${formatNumber(agent.checkpoint)} of ${formatNumber(checkpointCount)} checkpoints${
    status ? ` · ${RUN_STATUS_LABEL[status]}` : ""
  }`;
  return (
    <li
      className={cx(styles.outcome, settlement === "won" && styles.winner, settlement === "lost" && styles.loser)}
      style={agentStyle(visual)}
    >
      <AgentMonogram agent={visual} size="md" />
      <div className={styles.identity}>
        <span className={styles.name} title={name}>
          {name}
        </span>
        <span className={styles.progress} title={progressTitle}>
          <span className="num">
            {formatNumber(agent.checkpoint)}/{formatNumber(checkpointCount)}
          </span>
          {status ? (
            <>
              {" · "}
              <span className={cx(styles.status, styles[status])}>{SHORT_RUN_STATUS[status]}</span>
            </>
          ) : (
            " checkpoints"
          )}
        </span>
      </div>
      {settlement ? (
        <SettlementCells settlement={settlement} />
      ) : (
        <>
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
        </>
      )}
    </li>
  );
}

/** Result and settlement in place of chance and Yes / No, once the market settles. */
function SettlementCells({ settlement }: { settlement: Settlement }) {
  if (settlement === "void") {
    return (
      <>
        <div className={styles.chance}>
          <span className={cx("label", styles.resultVoid)}>Void</span>
        </div>
        <div className={styles.settlement} title="No agent finished before the cap. Positions were refunded.">
          <span className={styles.settleNote}>Refunded</span>
        </div>
      </>
    );
  }
  const won = settlement === "won";
  return (
    <>
      <div className={styles.chance}>
        <Tag tone={won ? "positive" : "neutral"}>{won ? "Won" : "Lost"}</Tag>
      </div>
      <div className={styles.settlement} title={won ? "Each YES share paid $1.00" : "YES shares paid nothing"}>
        <span className={cx("num", styles.settleValue)}>{formatMoney(won ? 1 : 0)}</span>
      </div>
    </>
  );
}

function closedReasonFor(fight: FightSummary): string {
  if (fight.marketStatus === "pending") return "Trading opens as the fight starts, when its intro ends";
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
  const frozen = shown.status === "live" && shown.marketStatus === "frozen";
  const settled = shown.status === "resolved" && (shown.voided || shown.winnerRacerId !== null);
  const visuals = rosterVisuals(shown.agents.map((a) => a.agent));
  const pick = (racerId: string, side: Side) => {
    navigate(`${href}?${SLIP_PARAM}=${encodeURIComponent(formatSlipParam(racerId, side))}`);
  };

  return (
    <article className={styles.card} aria-labelledby={titleId}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>
          <span className={cx("label", styles.featured)}>Featured</span>
          <StatusPill status={fightPillStatus(shown)} size="sm" />
          {frozen && (
            <Tag tone="neutral" title={closedReasonFor(shown)}>
              Trading frozen
            </Tag>
          )}
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
            <span className={styles.headChance}>{settled ? "Result" : "Chance"}</span>
            {settled && (
              <span className={styles.headSettle} title="What one YES share paid at settlement">
                Settlement
              </span>
            )}
          </div>
          <ul className={styles.outcomes}>
            {shown.agents.map((agent, index) => (
              <OutcomeRow
                key={agent.racerId}
                agent={agent}
                visual={visuals[index] ?? rosterVisuals([agent.agent])[0]!}
                checkpointCount={shown.checkpointCount}
                live={shown.status === "live"}
                settlement={settlementFor(shown, agent.racerId)}
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
          <span className={styles.metaItem} title="Sabotages triggered in this fight">
            Sabotages{" "}
            <span className={cx("num", styles.metaFigure)}>
              {formatNumber(sabotageProgress(shown.sabotage))}/{formatNumber(DISPLAYED_SABOTAGE_COUNT)}
            </span>
          </span>
          <Resolution fight={shown} />
        </div>
        <ButtonLink to={href} variant="action" size="md" className={styles.view} aria-label={`View fight: ${shown.title}`}>
          View fight
        </ButtonLink>
      </footer>
      <FeaturedIntro key={shown.raceId} status={shown.status} startsAt={shown.startsAt} />
    </article>
  );
}

/** Shown when there is no fight at all yet. */
export function FeaturedFightEmpty() {
  return (
    <div className={cx(styles.card, styles.emptyCard)}>
      <EmptyState
        title="No fights yet"
        description="The next fight shows up here as soon as it’s scheduled, with its market open for trading."
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
