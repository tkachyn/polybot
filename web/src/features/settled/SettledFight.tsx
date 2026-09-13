/**
 * Resolved fight: the result, the viewer's payout (only when they traded
 * it), the results (features/evaluation: one row per agent, which opens to
 * its sabotage evidence and action trace) and the price history.
 *
 * Rendered by FightRoute inside a scrolling <Page> when fight.status is
 * "resolved". Renders no Page of its own.
 */
import { useEffect, useState, type ReactNode } from "react";
import type {
  AgentIdentity,
  FightDetail,
  FightEvaluationPointer,
  FightSettlementLine,
  MyFightResponse,
  PricePoint,
  SettlementResult,
} from "@contract";
import { getMyFight } from "../../api/client";
import {
  AgentMonogram,
  ButtonLink,
  ErrorBanner,
  IconArrowLeft,
  Money,
  SignedMoney,
  SignedPercent,
  StatusPill,
  TableWrap,
  Tag,
  fightPillStatus,
  tableStyles,
  type PillStatus,
} from "../../components";
import { cx } from "../../lib/cx";
import { formatDateTime, formatDuration, formatFightNumber, formatMoney, formatNumber, formatShares } from "../../lib/format";
import { SETTLEMENT_RESULT_LABEL } from "../../lib/labels";
import { useApiResource } from "../../state/resource";
import { useSession } from "../../state/session";
import { EvaluationReport } from "../evaluation/EvaluationReport";
import { ProbabilityChart } from "../market/ProbabilityChart";
import styles from "./SettledFight.module.css";

export type SettledFightProps = {
  fight: FightDetail;
  priceHistory: PricePoint[];
  /**
   * The evaluation pointer (`fight.evaluation`), passed through by FightRoute.
   * The report refetches only when its `updatedAt` changes. Defaults to
   * `fight.evaluation` when omitted.
   */
  evaluation?: FightEvaluationPointer | null;
};

/** Poll the payout while the market is still settling. */
const SETTLING_POLL_MS = 3_000;

export function SettledFight({ fight, priceHistory, evaluation }: SettledFightProps) {
  return (
    <div className={styles.root}>
      <ButtonLink to="/resolved" variant="subtle" size="sm" icon={<IconArrowLeft size={14} />} className={styles.back}>
        Resolved fights
      </ButtonLink>
      <SettledHeader fight={fight} />
      <PayoutCard fight={fight} />
      <EvaluationReport
        raceId={fight.raceId}
        pointer={evaluation === undefined ? fight.evaluation : evaluation}
        resolved={fight.status === "resolved"}
      />
      {priceHistory.length > 0 && (
        <section className={styles.chart} aria-label="Win probability history">
          <ProbabilityChart
            agents={fight.agents}
            priceHistory={priceHistory}
            sabotageAt={fight.sabotage?.firedAt ?? null}
            sabotageMarkers={fight.agents
              .filter((agent) => agent.sabotageHitAt !== null)
              .map((agent) => ({
                racerId: agent.racerId,
                at: agent.sabotageHitAt!,
                label: `${agent.agent.name} hit`,
              }))}
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
    <ResultHeader
      number={fight.number}
      title={fight.title}
      status={fightPillStatus(fight)}
      pillLabel={fight.voided ? "Void" : undefined}
      result={
        fight.voided ? (
          <ResultNote>Voided — no agent finished; positions refunded</ResultNote>
        ) : winner ? (
          <WinnerLine agent={winner.agent} />
        ) : (
          <ResultNote>Winner pending verification</ResultNote>
        )
      }
      meta={[
        { label: "Duration", value: formatDuration(duration) },
        { label: "Volume", value: formatMoney(fight.volume, { decimals: 0 }) },
        { label: "Traders", value: formatNumber(fight.traders) },
        { label: "Ended", value: formatDateTime(fight.finishedAt) },
      ]}
    />
  );
}

export type ResultHeaderProps = {
  number: number;
  title: string;
  status: PillStatus;
  /** Replaces the pill's text ("Void"). */
  pillLabel?: string;
  /** The winner (WinnerLine), or why there is none (ResultNote). */
  result: ReactNode;
  /** Figures beside the result, already formatted. */
  meta: ReadonlyArray<{ label: string; value: string }>;
};

/** A finished fight's header: number and status, title, then the result beside its figures. Shared with ArchivedFight. */
export function ResultHeader({ number, title, status, pillLabel, result, meta }: ResultHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.headerTop}>
        <span className={cx("label", "label-lg", "num")}>FIGHT {formatFightNumber(number)}</span>
        <StatusPill status={status} label={pillLabel} />
      </div>
      <h1 className={cx(styles.title, "clamp-2")} title={title}>
        {title}
      </h1>
      <div className={styles.summary}>
        {result}
        <dl className={styles.meta}>
          {meta.map(({ label, value }) => (
            <div key={label} className={styles.metaItem}>
              <dt className="label">{label}</dt>
              <dd className="num">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </header>
  );
}

export function WinnerLine({ agent }: { agent: AgentIdentity }) {
  return (
    <p className={styles.winner}>
      <span className="label">Winner</span>
      <AgentMonogram agent={agent} size="sm" />
      <span className={styles.winnerName}>{agent.name}</span>
    </p>
  );
}

/** The result line when there is no winner to show. */
export function ResultNote({ children }: { children: ReactNode }) {
  return <p className={styles.voidLine}>{children}</p>;
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

function hasTraded(data: MyFightResponse): boolean {
  return data.settled.length > 0 || data.open.length > 0 || data.totals.cost > 0 || data.totals.proceeds > 0;
}

/** The viewer's result on this fight. A viewer who didn't trade it sees nothing here. */
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
  const data = resource.data;
  const nextSettling = !settled || (data !== null && data.open.length > 0);
  useEffect(() => setSettling(nextSettling), [nextSettling]);

  if (data === null) {
    return resource.error ? (
      <ErrorBanner error={resource.error} title="Couldn’t load your payout." onRetry={resource.reload} retrying={resource.loading} />
    ) : null;
  }
  if (!hasTraded(data)) return null;

  const { totals } = data;
  return (
    <section className={styles.card} aria-labelledby="settled-payout">
      <div className={styles.cardHeader}>
        <h2 id="settled-payout" className={styles.sectionTitle}>
          Your payout
        </h2>
        {settling && <span className="label">Settling…</span>}
      </div>
      <div className={styles.payout}>
        <div className={styles.net}>
          <span className="label">Net</span>
          <span className={styles.netFigures}>
            <SignedMoney value={totals.net} size="xl" />
            <SignedPercent value={totals.returnPct} size="md" />
          </span>
        </div>
        <dl className={styles.figures}>
          <Figure label="Cost" value={totals.cost} />
          {totals.proceeds > 0 && <Figure label="Proceeds" value={totals.proceeds} />}
          <Figure label="Payout" value={totals.payout} />
        </dl>
      </div>
      {data.settled.length > 0 ? (
        <PayoutLines lines={data.settled} />
      ) : (
        <p className={styles.cardNote}>
          {data.open.length > 0 ? "Settlement is processing. Your positions will be paid out in a moment." : "You closed every position before the fight settled."}
        </p>
      )}
    </section>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.figure}>
      <dt className="label">{label}</dt>
      <dd>
        <Money value={value} size="md" />
      </dd>
    </div>
  );
}

function PayoutLines({ lines }: { lines: FightSettlementLine[] }) {
  return (
    <TableWrap card={false} className={styles.lines}>
      <table className={tableStyles.table}>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Side</th>
            <th className={cx(tableStyles.num, styles.hideCompact)}>Shares</th>
            <th className={cx(tableStyles.num, styles.hideCompact)}>Cost</th>
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
              <td className={cx(tableStyles.num, styles.hideCompact)}>{formatShares(line.quantity)}</td>
              <td className={cx(tableStyles.num, styles.hideCompact)}>
                <Money value={line.costBasis} size="sm" />
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
