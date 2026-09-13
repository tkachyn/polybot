/**
 * Order receipt: replaces the order form in the same panel after a fill.
 */
import type { AgentIdentity, OrderReceipt } from "@contract";
import { AgentMonogram, Button, ButtonLink, IconClose, IconResolved, SignedMoney, Tag } from "../../components";
import type { AgentVisual } from "../../lib/agents";
import { formatCents, formatLogTime, formatMoney, formatShares } from "../../lib/format";
import { SIDE_LABEL } from "../../lib/labels";
import { round6 } from "../../lib/order";
import { useEscape } from "./market";
import { returnFocusToSlipOpener } from "./slipFocus";
import styles from "./OrderPanel.module.css";

/** A filled order plus what's needed to render it after the slip moves on. */
export type FilledOrder = {
  /** raceId + slip identity that produced it; a different slip dismisses the receipt. */
  key: string;
  receipt: OrderReceipt;
  agent: AgentIdentity;
  visual: AgentVisual;
};

export type ReceiptProps = {
  filled: FilledOrder;
  /** Clears slip and receipt. */
  onNewOrder: () => void;
};

export function Receipt({ filled, onNewOrder }: ReceiptProps) {
  const { receipt, agent, visual } = filled;
  const close = () => {
    returnFocusToSlipOpener();
    onNewOrder();
  };
  useEscape(close);

  return (
    <section className={styles.panel} aria-label="Order receipt">
      <div className={styles.head}>
        <span className={styles.check} aria-hidden="true">
          <IconResolved size={16} />
        </span>
        <div className={styles.outcome}>
          <p className={styles.receiptTitle} role="status">
            Order filled
          </p>
          <span className="label label-sm num">Executed {formatLogTime(receipt.executedAt)}</span>
        </div>
        <button type="button" className={styles.close} onClick={close} aria-label="Close receipt" title="Close (Esc)">
          <IconClose size={14} />
        </button>
      </div>

      <div className={styles.receiptOutcome}>
        <AgentMonogram agent={visual} size="sm" />
        <span className={styles.agentName} title={agent.name}>
          {agent.name}
        </span>
        <Tag tone={receipt.side === "yes" ? "positive" : "sabotage"}>{SIDE_LABEL[receipt.side]}</Tag>
      </div>

      <dl className={styles.summary}>
        <div>
          <dt className="label label-sm">Shares</dt>
          <dd className="num">{formatShares(receipt.quantity)}</dd>
        </div>
        <div>
          <dt className="label label-sm">Avg price</dt>
          <dd className="num">{formatCents(receipt.price)}</dd>
        </div>
        <div>
          <dt className="label label-sm">Cost</dt>
          <dd className="num">{formatMoney(receipt.total)}</dd>
        </div>
        <div className={styles.span2}>
          <dt className="label label-sm">Payout if correct</dt>
          <dd className="num">{formatMoney(receipt.payoutIfWin)}</dd>
        </div>
        <div>
          <dt className="label label-sm">Profit</dt>
          <dd>
            <SignedMoney value={round6(receipt.payoutIfWin - receipt.total)} size="md" />
          </dd>
        </div>
      </dl>

      <div className={styles.actions}>
        <ButtonLink to="/portfolio" variant="ghost" size="lg" block>
          Portfolio
        </ButtonLink>
        <Button variant="ghost" size="lg" block onClick={close}>
          New order
        </Button>
      </div>
    </section>
  );
}
