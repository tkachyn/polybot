/**
 * The fight screen's 344px market rail (handoff 2.2 "Market rail", 2.3):
 * win-probability chart, outcome table, then the order form or receipt in
 * place, and a small market footer. Fills its column and never scrolls the
 * page: the chart collapses to a legend strip while an order panel is open
 * so the confirm button always stays on screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FightDetail, OrderResponse } from "@contract";
import { Countdown } from "../../components";
import { agentVisual, rosterVisuals } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { formatCompactMoney, formatNumber } from "../../lib/format";
import { marketStatusText } from "./market";
import { OrderForm } from "./OrderForm";
import { OutcomeTable } from "./OutcomeTable";
import { ProbabilityChart } from "./ProbabilityChart";
import { Receipt, type FilledOrder } from "./Receipt";
import type { MarketRailProps, Slip } from "./types";
import styles from "./MarketRail.module.css";

function slipKey(raceId: string, slip: Slip | null): string {
  return slip ? `${raceId}|${slip.racerId}|${slip.side}|${slip.price}` : `${raceId}|`;
}

export function MarketRail({ fight, priceHistory, slip, onSlipChange }: MarketRailProps) {
  const [amount, setAmount] = useState("");
  const [filled, setFilled] = useState<FilledOrder | null>(null);

  const onSlipChangeRef = useRef(onSlipChange);
  onSlipChangeRef.current = onSlipChange;

  const visuals = useMemo(() => rosterVisuals(fight.agents.map((a) => a.agent)), [fight.agents]);
  const agentIndex = slip ? fight.agents.findIndex((a) => a.racerId === slip.racerId) : -1;
  const slipAgent = agentIndex >= 0 ? fight.agents[agentIndex] : undefined;
  const activeSlip = slipAgent ? slip : null;
  const currentKey = slipKey(fight.raceId, activeSlip);

  // A receipt belongs to the slip that produced it: another slip (from the
  // table or the arena), no slip, or another fight dismisses it.
  useEffect(() => {
    setFilled((f) => (f && f.key !== currentKey ? null : f));
  }, [currentKey]);

  const select = useCallback((next: Slip | null) => {
    setFilled(null);
    onSlipChangeRef.current(next);
  }, []);

  const close = useCallback(() => select(null), [select]);

  const onFilled = useCallback(
    (response: OrderResponse) => {
      if (!slipAgent) return;
      setFilled({
        key: currentKey,
        receipt: response.receipt,
        agent: slipAgent.agent,
        visual: visuals[agentIndex] ?? agentVisual(slipAgent.agent),
      });
    },
    [slipAgent, currentKey, visuals, agentIndex],
  );

  const panelOpen = filled !== null || activeSlip !== null;

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
      />
    );
  }

  return (
    <div className={styles.rail}>
      <ProbabilityChart
        agents={fight.agents}
        priceHistory={priceHistory}
        sabotageAt={fight.sabotage?.firedAt ?? null}
        endAt={fight.status === "resolved" ? fight.finishedAt : null}
        volume={fight.volume}
        className={cx(styles.chartFloor, panelOpen && styles.chartFloorCompact)}
      />
      <OutcomeTable fight={fight} slip={activeSlip} onSelect={select} className={cx(styles.table, panelOpen && styles.tableShrink)} />
      {panel}
      <MarketFooter fight={fight} />
    </div>
  );
}

function MarketFooter({ fight }: { fight: FightDetail }) {
  const status = marketStatusText(fight);
  const showFreeze = status.open && fight.status === "live" && fight.freezesAt !== null;
  return (
    <footer className={styles.footer}>
      <span className={styles.status}>
        <span className={cx(styles.dot, status.open && styles.dotOpen)} aria-hidden="true" />
        <span className={styles.statusText}>
          {status.label}
          {showFreeze && (
            <>
              {" · freezes in "}
              <Countdown to={fight.freezesAt} className="num" />
            </>
          )}
        </span>
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
