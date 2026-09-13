/**
 * The fight screen's market rail (handoff 2.2 "Market rail", 2.3):
 * win-probability chart, outcome table, then the order form or receipt in
 * place, and a small market footer. The chart stays mounted while an order
 * panel is open so the user can keep seeing the price movement they are
 * trading.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FightDetail, OrderResponse } from "@contract";
import { agentVisual, rosterVisuals } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { formatCompactMoney, formatNumber } from "../../lib/format";
import { ClockPhrase } from "../fight/ClockCountdown";
import { marketStateView } from "../fight/fightView";
import { marketStatusText } from "./market";
import { OrderForm } from "./OrderForm";
import { OutcomeTable } from "./OutcomeTable";
import { ProbabilityChart } from "./ProbabilityChart";
import { Receipt, type FilledOrder } from "./Receipt";
import type { ChartSabotageMarker, ChartTradeMarker, MarketRailProps, Slip } from "./types";
import styles from "./MarketRail.module.css";
import { useSession } from "../../state/session";

function slipKey(raceId: string, slip: Slip | null): string {
  return slip ? `${raceId}|${slip.racerId}|${slip.side}|${slip.price}` : `${raceId}|`;
}

export function MarketRail({ fight, priceHistory, slip, onSlipChange }: MarketRailProps) {
  const { portfolio } = useSession();
  const [amount, setAmount] = useState("");
  const [filled, setFilled] = useState<FilledOrder | null>(null);
  const [tradeMarkers, setTradeMarkers] = useState<ChartTradeMarker[]>([]);

  const onSlipChangeRef = useRef(onSlipChange);
  onSlipChangeRef.current = onSlipChange;

  const visuals = useMemo(() => rosterVisuals(fight.agents.map((a) => a.agent)), [fight.agents]);
  const agentIndex = slip ? fight.agents.findIndex((a) => a.racerId === slip.racerId) : -1;
  const slipAgent = agentIndex >= 0 ? fight.agents[agentIndex] : undefined;
  const activeSlip = slipAgent ? slip : null;
  const position = activeSlip
    ? portfolio?.positions.find(
        (candidate) =>
          candidate.raceId === fight.raceId &&
          candidate.racerId === activeSlip.racerId &&
          candidate.side === activeSlip.side,
      ) ?? null
    : null;
  const currentKey = slipKey(fight.raceId, activeSlip);
  const persistedTradeMarkers = useMemo(
    () => (portfolio?.history ?? [])
      .filter((entry) =>
        entry.raceId === fight.raceId &&
        (entry.type === "buy" || entry.type === "sell") &&
        entry.racerId !== null &&
        entry.quantity !== null &&
        entry.price !== null,
      )
      .map((entry) => ({
        id: entry.id,
        racerId: entry.racerId!,
        at: entry.at,
        price: entry.price!,
        action: entry.type as "buy" | "sell",
        side: entry.side ?? "yes",
        quantity: entry.quantity!,
      })),
    [portfolio?.history, fight.raceId],
  );
  const chartTradeMarkers = useMemo(() => {
    const merged = [...persistedTradeMarkers, ...tradeMarkers];
    return merged.filter((marker, index) =>
      merged.findIndex((candidate) => candidate.id === marker.id) === index,
    );
  }, [persistedTradeMarkers, tradeMarkers]);

  // A receipt belongs to the slip that produced it: another slip (from the
  // table or the arena), no slip, or another fight dismisses it.
  useEffect(() => {
    setFilled((f) => (f && f.key !== currentKey ? null : f));
  }, [currentKey]);

  useEffect(() => {
    setTradeMarkers([]);
  }, [fight.raceId]);

  const select = useCallback((next: Slip | null) => {
    setFilled(null);
    onSlipChangeRef.current(next);
  }, []);

  const close = useCallback(() => select(null), [select]);

  const onFilled = useCallback(
    (response: OrderResponse) => {
      if (!slipAgent) return;
      setTradeMarkers((markers) => markers.some((marker) => marker.id === response.receipt.orderId)
        ? markers
        : [...markers, {
            id: response.receipt.orderId,
            racerId: response.receipt.racerId,
            at: response.receipt.executedAt,
            price: response.receipt.price,
            action: response.receipt.action,
            side: response.receipt.side,
            quantity: response.receipt.quantity,
          }]);
      setFilled({
        key: currentKey,
        receipt: response.receipt,
        agent: slipAgent.agent,
        visual: visuals[agentIndex] ?? agentVisual(slipAgent.agent),
      });
    },
    [slipAgent, currentKey, visuals, agentIndex],
  );

  let panel = null;
  if (filled) {
    panel = <Receipt filled={filled} onNewOrder={close} />;
  } else if (activeSlip && slipAgent) {
    panel = (
      <OrderForm
        fight={fight}
        agent={slipAgent}
        visual={visuals[agentIndex] ?? agentVisual(slipAgent.agent)}
        side={activeSlip.side}
        amount={amount}
        onAmountChange={setAmount}
        onClose={close}
        onFilled={onFilled}
        position={position}
      />
    );
  }

  return (
    <div className={styles.rail}>
      <ProbabilityChart
        agents={fight.agents}
        priceHistory={priceHistory}
        sabotageAt={fight.sabotage?.firedAt ?? null}
        sabotageMarkers={sabotageMarkersFor(fight)}
        tradeMarkers={chartTradeMarkers}
        endAt={fight.finishedAt}
        volume={fight.volume}
        className={styles.chartFloor}
      />
      <OutcomeTable fight={fight} slip={activeSlip} onSelect={select} className={styles.table} />
      {panel}
      <MarketFooter fight={fight} />
    </div>
  );
}

function sabotageMarkersFor(fight: FightDetail): ChartSabotageMarker[] {
  return fight.agents
    .filter((agent) => agent.sabotageHitAt !== null)
    .map((agent) => ({
      racerId: agent.racerId,
      at: agent.sabotageHitAt!,
      label: `${agent.agent.name} hit`,
    }));
}

function MarketFooter({ fight }: { fight: FightDetail }) {
  const status = marketStatusText(fight);
  // The screen's m:ss clock rather than a second format: the freeze while
  // trading is open, the end of the fight once it is frozen.
  const countdown = fight.status === "live" ? marketStateView(fight).countdown : null;
  return (
    <footer className={styles.footer}>
      <span className={styles.status}>
        <span className={cx(styles.dot, status.open && styles.dotOpen)} aria-hidden="true" />
        {countdown === null ? (
          <span className={styles.statusLabel}>{status.label}</span>
        ) : (
          <ClockPhrase
            to={countdown.to}
            lead={countdown.shortLead}
            approximate={countdown.approximate}
            due={countdown.shortDue}
            leadClassName={styles.statusLabel}
            clockClassName={cx(styles.statusCountdown, styles.statValue)}
          />
        )}
      </span>
      <span className={styles.stat}>
        <span className="label label-sm">Vol</span>
        <span className={cx("num", styles.statValue)}>{formatCompactMoney(fight.volume)}</span>
      </span>
      <span className={styles.stat}>
        <span className={cx("num", styles.statValue)}>{formatNumber(fight.traders)}</span>
        <span className="label label-sm">{fight.traders === 1 ? "Trader" : "Traders"}</span>
      </span>
    </footer>
  );
}
