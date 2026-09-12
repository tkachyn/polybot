/**
 * One row per agent: identity, then YES (green) and NO (terracotta) price
 * buttons. Clicking a price opens the slip; clicking the selected price
 * again clears it. Disabled with a reason when the market is not open.
 */
import { useMemo } from "react";
import type { FightDetail, Side } from "@contract";
import { AgentMonogram, ChangeCents } from "../../components";
import { agentVisual, rosterVisuals } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { formatCents } from "../../lib/format";
import { SIDE_LABEL } from "../../lib/labels";
import { isTradablePrice } from "../../lib/order";
import { tradingBlockedReason } from "./market";
import type { Slip } from "./types";
import styles from "./OutcomeTable.module.css";

export type OutcomeTableProps = {
  fight: FightDetail;
  slip: Slip | null;
  onSelect: (slip: Slip | null) => void;
  className?: string;
};

export function OutcomeTable({ fight, slip, onSelect, className }: OutcomeTableProps) {
  const visuals = useMemo(() => rosterVisuals(fight.agents.map((a) => a.agent)), [fight.agents]);
  const blocked = tradingBlockedReason(fight.marketStatus);

  return (
    <section className={cx(styles.card, className)} aria-label="Outcomes">
      <div className={styles.head}>
        <span className="label">Outcome</span>
        {blocked ? (
          <span className={cx("label", styles.blocked)} role="status">
            {blocked}
          </span>
        ) : (
          <>
            <span className={cx("label", styles.colHead)}>Yes</span>
            <span className={cx("label", styles.colHead)}>No</span>
          </>
        )}
      </div>
      <ul className={styles.rows}>
        {fight.agents.map((a, i) => {
          const visual = visuals[i] ?? agentVisual(a.agent);
          const rowSelected = slip?.racerId === a.racerId;
          const toggle = (side: Side, price: number) => {
            const same = slip?.racerId === a.racerId && slip.side === side;
            onSelect(same ? null : { racerId: a.racerId, side, price });
          };
          return (
            <li key={a.racerId} className={cx(styles.row, rowSelected && styles.rowSelected)}>
              <div className={styles.identity}>
                <AgentMonogram agent={visual} size="sm" />
                <span className={styles.name} title={a.agent.name}>
                  {a.agent.name}
                </span>
                <ChangeCents value={a.change} className={styles.change} />
              </div>
              <PriceButton
                side="yes"
                price={a.yes}
                agentName={a.agent.name}
                selected={rowSelected && slip?.side === "yes"}
                blocked={blocked}
                onClick={() => toggle("yes", a.yes)}
              />
              <PriceButton
                side="no"
                price={a.no}
                agentName={a.agent.name}
                selected={rowSelected && slip?.side === "no"}
                blocked={blocked}
                onClick={() => toggle("no", a.no)}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type PriceButtonProps = {
  side: Side;
  price: number;
  agentName: string;
  selected: boolean;
  blocked: string | null;
  onClick: () => void;
};

function PriceButton({ side, price, agentName, selected, blocked, onClick }: PriceButtonProps) {
  const reason = blocked ?? (isTradablePrice(price) ? null : "Not tradable at this price");
  const label = `${SIDE_LABEL[side]} ${formatCents(price)}`;
  return (
    <button
      type="button"
      className={cx(styles.price, side === "yes" ? styles.yes : styles.no, selected && styles.selected)}
      aria-pressed={selected}
      aria-label={`${label}, ${agentName}${reason ? ` (${reason})` : ""}`}
      title={reason ?? `Buy ${SIDE_LABEL[side]} on ${agentName} at ${formatCents(price)}`}
      disabled={reason !== null}
      onClick={onClick}
    >
      <span>{SIDE_LABEL[side]}</span>
      <span className="num">{formatCents(price)}</span>
    </button>
  );
}
