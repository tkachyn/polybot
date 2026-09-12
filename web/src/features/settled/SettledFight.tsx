/**
 * Resolved fight (handoff 2.4): settled header, per-agent settlement table
 * with the winning row tinted, sabotage recap, and the viewer's payout card.
 *
 * Rendered by FightRoute inside a scrolling <Page> when fight.status is
 * "resolved". Renders no Page of its own.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { FightAgentDetail, FightDetail, FightSettlementLine, MyFightResponse, PricePoint, SettlementResult } from "@contract";
import { getMyFight } from "../../api/client";
import {
  AgentMonogram,
  ButtonLink,
  EmptyState,
  ErrorBanner,
  IconArrowLeft,
  Money,
  PriceCents,
  ProgressBar,
  SabotageTag,
  SignedMoney,
  SignedPercent,
  Skeleton,
  StatusPill,
  TableWrap,
  Tag,
  fightPillStatus,
  tableStyles,
} from "../../components";
import { cx } from "../../lib/cx";
import { formatDateTime, formatDuration, formatFightNumber, formatLogTime, formatMoney, formatNumber, formatShares } from "../../lib/format";
import { HAZARD_LABEL, SABOTAGE_HIDDEN_COPY, SETTLEMENT_RESULT_LABEL } from "../../lib/labels";
import { useApiResource } from "../../state/resource";
import { useSession } from "../../state/session";
import { ProbabilityChart } from "../market/ProbabilityChart";
import styles from "./SettledFight.module.css";

export type SettledFightProps = { fight: FightDetail; priceHistory: PricePoint[] };

/** Poll the payout while the market is still settling. */
const SETTLING_POLL_MS = 3_000;

export function SettledFight({ fight, priceHistory }: SettledFightProps) {
  return (
    <div className={styles.root}>
      <ButtonLink to="/resolved" variant="subtle" size="sm" icon={<IconArrowLeft size={14} />} className={styles.back}>
        Resolved fights
      </ButtonLink>
      <SettledHeader fight={fight} />
      <AgentSettlementTable fight={fight} />
      <SabotageRecap fight={fight} />
      <PayoutCard fight={fight} />
      {priceHistory.length > 0 && (
        <section className={styles.chart} aria-label="Win probability history">
          <ProbabilityChart
            agents={fight.agents}
            priceHistory={priceHistory}
            sabotageAt={fight.sabotage?.firedAt ?? null}
            endAt={fight.finishedAt ?? priceHistory[priceHistory.length - 1]?.t ?? null}
            title="Win probability"
          />
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function SettledHeader({ fight }: { fight: FightDetail }) {
  const winner = fight.agents.find((a) => a.racerId === fight.winnerRacerId) ?? null;
  const duration = fight.startedAt !== null && fight.finishedAt !== null ? fight.finishedAt - fight.startedAt : null;

  return (
    <header className={styles.header}>
      <div className={styles.headerTop}>
        <span className={cx("label", "label-lg", "num")}>FIGHT {formatFightNumber(fight.number)}</span>
        <StatusPill status={fightPillStatus(fight)} label={fight.voided ? "Void" : undefined} />
      </div>
      <h1 className={cx(styles.title, "clamp-2")} title={fight.title}>
        {fight.title}
      </h1>
      {fight.voided ? (
        <p className={styles.voidLine}>Voided — no agent finished; positions refunded</p>
      ) : winner ? (
        <p className={styles.winner}>
          <span className="label">Winner</span>
          <AgentMonogram agent={winner.agent} size="sm" />
          <span className={styles.winnerName}>{winner.agent.name}</span>
        </p>
      ) : (
        <p className={styles.voidLine}>Winner pending verification</p>
      )}
      <dl className={styles.meta}>
        <MetaItem label="Started" value={formatDateTime(fight.startedAt)} />
        <MetaItem label="Finished" value={formatDateTime(fight.finishedAt)} />
        <MetaItem label="Duration" value={formatDuration(duration)} />
        <MetaItem label="Volume" value={formatMoney(fight.volume, { decimals: 0 })} />
        <MetaItem label="Traders" value={formatNumber(fight.traders)} />
      </dl>
    </header>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metaItem}>
      <dt className="label">{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-agent settlement
// ---------------------------------------------------------------------------

function wasHit(fight: FightDetail, agent: FightAgentDetail): boolean {
  return agent.sabotageHitAt !== null || (fight.sabotage?.hitRacerIds.includes(agent.racerId) ?? false);
}

function AgentSettlementTable({ fight }: { fight: FightDetail }) {
  const sabotageAt = fight.sabotage && fight.checkpointCount > 0 ? fight.sabotage.checkpoint / fight.checkpointCount : null;

  return (
    <section className={styles.section} aria-labelledby="settled-agents">
      <h2 id="settled-agents" className={styles.sectionTitle}>
        Settlement
      </h2>
      <TableWrap>
        <table className={tableStyles.table}>
          <thead>
            <tr>
              <th>Agent</th>
              <th className={tableStyles.num} title="Last YES price before settlement">
                Last price
              </th>
              <th className={tableStyles.num}>Settlement</th>
              <th>Result</th>
              <th className={tableStyles.num}>Checkpoints</th>
              <th>Sabotage</th>
            </tr>
          </thead>
          <tbody>
            {fight.agents.map((agent) => {
              const won = !fight.voided && agent.racerId === fight.winnerRacerId;
              const hit = wasHit(fight, agent);
              return (
                <tr key={agent.racerId} className={cx(tableStyles.row, won && tableStyles.rowPositive)}>
                  <td>
                    <span className={tableStyles.cellMain}>
                      <AgentMonogram agent={agent.agent} size="sm" />
                      <span className={cx(tableStyles.strong, styles.nowrap)}>{agent.agent.name}</span>
                    </span>
                  </td>
                  <td className={tableStyles.num}>
                    <PriceCents value={agent.yes} size="md" />
                  </td>
                  <td className={tableStyles.num}>
                    {fight.voided ? <span className={tableStyles.muted}>Void</span> : <span className="num">{formatMoney(won ? 1 : 0)}</span>}
                  </td>
                  <td>
                    {fight.voided ? (
                      <span className={tableStyles.muted}>—</span>
                    ) : won ? (
                      <Tag tone="positive">Won</Tag>
                    ) : (
                      <Tag tone="neutral">Lost</Tag>
                    )}
                  </td>
                  <td className={tableStyles.num}>
                    <span className={styles.checkpoints}>
                      <ProgressBar
                        value={fight.checkpointCount > 0 ? agent.checkpoint / fight.checkpointCount : 0}
                        tone={won ? "positive" : "muted"}
                        markers={sabotageAt !== null ? [{ at: sabotageAt, tone: "sabotage", label: "Sabotage checkpoint" }] : undefined}
                        size="xs"
                        className={styles.progress}
                        label={`${agent.agent.name} checkpoints`}
                      />
                      <span className="num">
                        {formatNumber(agent.checkpoint)}/{formatNumber(fight.checkpointCount)}
                      </span>
                    </span>
                  </td>
                  <td>
                    {hit ? (
                      <span className={styles.hitCell}>
                        <SabotageTag>Hit</SabotageTag>
                        {agent.sabotageHitAt !== null && <span className={cx("num", tableStyles.muted, styles.hideReflow)}>{formatLogTime(agent.sabotageHitAt)}</span>}
                        {agent.recoveredAt !== null && <span className={tableStyles.muted}>· recovered</span>}
                      </span>
                    ) : (
                      <span className={tableStyles.muted}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sabotage recap
// ---------------------------------------------------------------------------

function SabotageRecap({ fight }: { fight: FightDetail }) {
  const sabotage = fight.sabotage;
  if (!sabotage) {
    return (
      <p className={cx(styles.recap, styles.recapNeutral)}>
        <Tag tone="neutral">No sabotage</Tag>
        <span className={styles.recapMeta}>Obstacles were disabled for this fight.</span>
      </p>
    );
  }

  const hit = fight.agents.filter((a) => wasHit(fight, a));
  const survived = hit.filter((a) => a.recoveredAt !== null || a.racerId === fight.winnerRacerId || a.checkpoint > sabotage.checkpoint);
  const summary = sabotage.revealed ? (sabotage.summary ?? SABOTAGE_HIDDEN_COPY) : SABOTAGE_HIDDEN_COPY;

  let outcome: string;
  if (sabotage.state === "fired") {
    const at = sabotage.firedAt !== null ? `Fired ${formatLogTime(sabotage.firedAt)}` : "Fired";
    outcome = `${at} · hit ${hit.length} of ${fight.agents.length}` + (hit.length > 0 ? ` · ${survived.length} survived` : "");
  } else if (sabotage.state === "expired") {
    outcome = "Never fired — no agent reached the checkpoint in time";
  } else {
    outcome = "Armed, never fired";
  }

  return (
    <div className={styles.recap}>
      <SabotageTag />
      <span className={cx(styles.recapText, "clamp-1")} title={sabotage.detail ?? summary}>
        {summary}
      </span>
      <span className={styles.recapMeta}>
        at checkpoint <span className="num">{sabotage.checkpoint}</span> · {sabotage.checkpointLabel}
        {sabotage.hazardType && ` · ${HAZARD_LABEL[sabotage.hazardType]}`}
      </span>
      <span className={cx("num", styles.recapMeta)}>{outcome}</span>
      {hit.length > 0 && (
        <span className={styles.hitList} aria-label="Agents hit">
          {hit.map((a) => (
            <AgentMonogram key={a.racerId} agent={a.agent} size="xs" />
          ))}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payout card (GET /api/fights/:raceId/me)
// ---------------------------------------------------------------------------

const RESULT_TONE: Readonly<Record<SettlementResult, "positive" | "sabotage" | "neutral">> = {
  won: "positive",
  lost: "sabotage",
  refunded: "neutral",
};

function isMarketSettled(fight: FightDetail): boolean {
  return fight.marketStatus === "resolved" || fight.marketStatus === "unresolved";
}

function PayoutCard({ fight }: { fight: FightDetail }) {
  const { userId, status: sessionStatus } = useSession();
  const ready = sessionStatus === "ready";
  const settled = isMarketSettled(fight);
  const [settling, setSettling] = useState(!settled);
  // Polls while the market is still settling so the card fills in on its own.
  const resource = useApiResource<MyFightResponse>(
    ready ? (signal) => getMyFight(fight.raceId, userId, signal) : null,
    [fight.raceId, userId, fight.marketStatus],
    { pollMs: settling ? SETTLING_POLL_MS : undefined },
  );
  const latest = resource.data;
  const nextSettling = !settled || (latest !== null && latest.open.length > 0);
  useEffect(() => setSettling(nextSettling), [nextSettling]);

  return (
    <section className={styles.card} aria-labelledby="settled-payout">
      <div className={styles.cardHeader}>
        <h2 id="settled-payout" className={styles.sectionTitle}>
          Your payout
        </h2>
        {settling && latest !== null && <span className="label">Settling…</span>}
      </div>
      <PayoutBody
        data={latest}
        loading={latest === null && (resource.loading || !ready)}
        error={latest === null ? resource.error : null}
        onRetry={resource.reload}
        retrying={resource.loading}
      />
    </section>
  );
}

type PayoutBodyProps = {
  data: MyFightResponse | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
};

function PayoutBody({ data, loading, error, onRetry, retrying }: PayoutBodyProps) {
  if (error) {
    return (
      <div className={styles.cardBody}>
        <ErrorBanner error={error} title="Couldn’t load your payout." onRetry={onRetry} retrying={retrying} />
      </div>
    );
  }
  if (loading || !data) {
    return (
      <div className={styles.cardBody}>
        <Skeleton height={14} width="60%" />
        <Skeleton height={14} width="40%" />
      </div>
    );
  }

  const traded = data.settled.length > 0 || data.open.length > 0 || data.totals.cost > 0 || data.totals.proceeds > 0;
  if (!traded) {
    return (
      <EmptyState
        size="sm"
        title="You didn’t trade this fight"
        description="Positions you hold when a fight settles show up here with their payout."
        action={
          <ButtonLink to="/" variant="ghost" size="sm">
            Browse fights
          </ButtonLink>
        }
      />
    );
  }

  return (
    <>
      {data.settled.length > 0 ? (
        <PayoutLines lines={data.settled} />
      ) : data.open.length > 0 ? (
        <p className={styles.cardNote}>Settlement is processing. Your positions will be paid out in a moment.</p>
      ) : (
        <p className={styles.cardNote}>You closed every position before the fight settled.</p>
      )}
      <dl className={styles.totals}>
        <Total label="Cost">
          <Money value={data.totals.cost} size="lg" />
        </Total>
        <Total label="Proceeds">
          <Money value={data.totals.proceeds} size="lg" />
        </Total>
        <Total label="Payout">
          <Money value={data.totals.payout} size="lg" />
        </Total>
        <Total label="Net">
          <SignedMoney value={data.totals.net} size="lg" />
        </Total>
        <Total label="Return">
          <SignedPercent value={data.totals.returnPct} size="lg" />
        </Total>
      </dl>
    </>
  );
}

function Total({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.total}>
      <dt className="label">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function PayoutLines({ lines }: { lines: FightSettlementLine[] }) {
  return (
    <TableWrap card={false}>
      <table className={tableStyles.table}>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Side</th>
            <th className={tableStyles.num}>Shares</th>
            <th className={tableStyles.num}>Avg price</th>
            <th className={tableStyles.num}>Cost basis</th>
            <th className={cx(tableStyles.num, styles.hideReflow)}>Settlement</th>
            <th className={tableStyles.num}>Payout</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={`${line.racerId}:${line.side}`} className={cx(tableStyles.row, line.result === "won" && tableStyles.rowPositive)}>
              <td>
                <span className={tableStyles.cellMain}>
                  <AgentMonogram agent={line.agent} size="xs" />
                  <span className={cx(tableStyles.strong, styles.nowrap)}>{line.agent.name}</span>
                </span>
              </td>
              <td>
                <span className={cx(styles.side, line.side === "yes" ? styles.yes : styles.no)}>{line.side === "yes" ? "Yes" : "No"}</span>
              </td>
              <td className={tableStyles.num}>{formatShares(line.quantity)}</td>
              <td className={tableStyles.num}>
                <PriceCents value={line.avgPrice} size="sm" tone="secondary" />
              </td>
              <td className={tableStyles.num}>
                <Money value={line.costBasis} size="sm" />
              </td>
              <td className={cx(tableStyles.num, styles.hideReflow)}>
                {line.settlementPrice === null ? <span className={tableStyles.muted}>Void</span> : <Money value={line.settlementPrice} size="sm" />}
              </td>
              <td className={tableStyles.num}>
                <Money value={line.payout} size="sm" tone={line.payout > 0 ? "positive" : "muted"} />
              </td>
              <td>
                <Tag tone={RESULT_TONE[line.result]}>{SETTLEMENT_RESULT_LABEL[line.result]}</Tag>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}
