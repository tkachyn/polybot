/**
 * Per-position Sell with an inline two-step confirm: "Sell 120 for $38.40?".
 *
 * Sells the whole position at the current price, guarded by
 * `limitPrice = currentPrice` (the server rejects with price_moved if the
 * price fell below it). A price_moved rejection refreshes the portfolio and
 * asks again at the new price.
 */
import { useEffect, useState } from "react";
import type { MarketStatusDTO, Position } from "@contract";
import { describeError, isApiFailure, placeOrder } from "../../api/client";
import { Button } from "../../components";
import { cx } from "../../lib/cx";
import { formatCents, formatMoney, formatShares } from "../../lib/format";
import { newClientOrderId } from "../../lib/id";
import { round6 } from "../../lib/order";
import { useSession } from "../../state/session";
import styles from "./Portfolio.module.css";

type Phase =
  | { kind: "idle" }
  | { kind: "confirm"; clientOrderId: string; note: string | null }
  | { kind: "pending"; clientOrderId: string };

const CLOSED_REASON: Readonly<Record<Exclude<MarketStatusDTO, "open">, string>> = {
  frozen: "Trading is frozen until the fight settles.",
  resolved: "This market has settled.",
  unresolved: "This market was voided.",
};

export type SellControlProps = {
  position: Position;
  onSold: (message: string) => void;
};

export function SellControl({ position, onSold }: SellControlProps) {
  const { userId, applyAccount, refresh } = useSession();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);

  const quantity = Math.floor(position.quantity + 1e-9);
  const open = position.marketStatus === "open";
  const proceeds = round6(quantity * position.currentPrice);
  const disabledReason = position.marketStatus !== "open" ? CLOSED_REASON[position.marketStatus] : quantity < 1 ? "Less than one whole share." : null;

  // The market can close while the confirm is showing: drop back to idle.
  useEffect(() => {
    if (!open) setPhase((p) => (p.kind === "confirm" ? { kind: "idle" } : p));
  }, [open]);

  const start = () => {
    setError(null);
    setPhase({ kind: "confirm", clientOrderId: newClientOrderId(), note: null });
  };

  const cancel = () => {
    setError(null);
    setPhase({ kind: "idle" });
  };

  const confirm = async () => {
    if (phase.kind !== "confirm") return;
    const { clientOrderId } = phase;
    setError(null);
    setPhase({ kind: "pending", clientOrderId });
    try {
      const res = await placeOrder(position.raceId, {
        userId,
        racerId: position.racerId,
        side: position.side,
        action: "sell",
        quantity,
        limitPrice: position.currentPrice,
        clientOrderId,
      });
      applyAccount(res.account, res.serverTime);
      const { receipt } = res;
      onSold(
        `Sold ${formatShares(receipt.quantity)} ${receipt.side === "yes" ? "YES" : "NO"} · ${position.agent.name} at ${formatCents(receipt.price)} — ${formatMoney(receipt.total)}`,
      );
      setPhase({ kind: "idle" });
      void refresh();
    } catch (err) {
      if (isApiFailure(err, "price_moved")) {
        await refresh();
        setPhase({ kind: "confirm", clientOrderId: newClientOrderId(), note: "The price moved. Check the new amount and confirm again." });
        return;
      }
      setError(describeError(err));
      if (isApiFailure(err, "market_closed") || isApiFailure(err, "insufficient_position")) {
        setPhase({ kind: "idle" });
        void refresh();
        return;
      }
      // Network or server trouble: keep the same idempotency key so a retry
      // cannot sell twice.
      setPhase({ kind: "confirm", clientOrderId, note: null });
    }
  };

  if (phase.kind === "idle") {
    return (
      <div className={styles.sell}>
        <Button size="sm" variant="ghost" onClick={start} disabled={disabledReason !== null} title={disabledReason ?? `Sell all ${formatShares(quantity)} shares`}>
          Sell
        </Button>
        {error && (
          <p className={cx(styles.sellNote, styles.sellError)} role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  const pending = phase.kind === "pending";
  const note = phase.kind === "confirm" ? phase.note : null;
  return (
    <div className={styles.sell}>
      <div className={styles.confirm}>
        <span className={cx("num", styles.confirmText)}>
          Sell {formatShares(quantity)} for {formatMoney(proceeds)}?
        </span>
        <Button size="sm" variant="action" onClick={() => void confirm()} loading={pending}>
          Confirm
        </Button>
        <Button size="sm" variant="subtle" onClick={cancel} disabled={pending}>
          Cancel
        </Button>
      </div>
      {(error || note) && (
        <p className={cx(styles.sellNote, error && styles.sellError)} role={error ? "alert" : "status"}>
          {error ?? note}
        </p>
      )}
    </div>
  );
}
