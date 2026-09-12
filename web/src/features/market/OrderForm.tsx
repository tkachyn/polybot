/**
 * The bet slip, opened in place when a price is clicked. Quotes live against
 * the current price of the chosen side; the confirm CTA is labelled with the
 * exact order and sends that price as the limit.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { FightAgentDetail, FightDetail, OrderRequest, OrderResponse, Side } from "@contract";
import { ApiFailure, describeError, isAbortError, placeOrder, toApiFailure } from "../../api/client";
import { AgentMonogram, Button, IconAlert, IconClose, PriceCents, SignedMoney, Tag } from "../../components";
import type { AgentVisual } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { formatCents, formatMoney, formatShares } from "../../lib/format";
import { newClientOrderId } from "../../lib/id";
import { SIDE_LABEL } from "../../lib/labels";
import { QUICK_AMOUNTS, buildConfirmLabel, maxAmount, parseAmount, quoteOrder, sidePrice } from "../../lib/order";
import { useSession } from "../../state/session";
import { tradingBlockedReason, useEscape } from "./market";
import styles from "./OrderPanel.module.css";

export const DEPOSIT_PATH = "/wallet?tab=deposit";

export type OrderFormProps = {
  fight: FightDetail;
  agent: FightAgentDetail;
  visual: AgentVisual;
  side: Side;
  /** Raw amount field text (owned by the rail so it survives outcome switches). */
  amount: string;
  onAmountChange: (value: string) => void;
  onClose: () => void;
  onFilled: (response: OrderResponse) => void;
};

/** "12.34": the balance floored to whole cents, for the Max chip. */
function maxAmountText(balance: number): string {
  return (Math.floor(maxAmount(balance) * 100 + 1e-6) / 100).toFixed(2);
}

export function OrderForm({ fight, agent, visual, side, amount, onAmountChange, onClose, onFilled }: OrderFormProps) {
  const { userId, account, applyAccount } = useSession();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const pendingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const noticeId = useId();

  const livePrice = sidePrice(agent, side);
  const balance = account?.balance ?? null;
  const parsed = parseAmount(amount);
  const quote = quoteOrder({ price: livePrice, amount: parsed, balance: balance ?? 0 });
  const blocked = tradingBlockedReason(fight.marketStatus);
  const amountEntered = amount.trim() !== "";
  const maxText = balance !== null ? maxAmountText(balance) : null;

  // Focus the amount when the slip opens or moves to another outcome.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, [agent.racerId, side]);

  // A server rejection belongs to the order that was sent.
  useEffect(() => {
    setFailure(null);
  }, [agent.racerId, side, amount]);

  useEscape(onClose, !pending);

  const canSubmit = blocked === null && account !== null && quote.error === null && !pending;

  let ctaLabel: string;
  if (blocked) ctaLabel = blocked;
  else if (!account) ctaLabel = "Connecting to your account…";
  else if (quote.shares >= 1) {
    ctaLabel = buildConfirmLabel({ side, agentName: agent.agent.name, price: livePrice, shares: quote.shares, cost: quote.cost });
  } else ctaLabel = "Enter an amount";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || pendingRef.current) return;
    // One idempotency key per confirm attempt.
    const order: OrderRequest = {
      userId,
      racerId: agent.racerId,
      side,
      action: "buy",
      quantity: quote.shares,
      limitPrice: livePrice,
      clientOrderId: newClientOrderId(),
    };
    pendingRef.current = true;
    setPending(true);
    setFailure(null);
    try {
      const response = await placeOrder(fight.raceId, order);
      applyAccount(response.account, response.serverTime);
      onFilled(response);
    } catch (err) {
      if (!isAbortError(err)) setFailure(toApiFailure(err));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  let notice: ReactNode = null;
  if (failure) notice = failureMessage(failure, livePrice);
  else if (!blocked && quote.error && (amountEntered || quote.error.code !== "amount")) {
    notice =
      quote.error.code === "balance" ? (
        <>
          {quote.error.message} <Link to={DEPOSIT_PATH}>Deposit</Link>
        </>
      ) : (
        quote.error.message
      );
  }

  return (
    <form className={styles.panel} onSubmit={submit} aria-label="Order form" noValidate>
      <div className={styles.head}>
        <AgentMonogram agent={visual} size="md" />
        <div className={styles.outcome}>
          <span className={styles.agentName} title={agent.agent.name}>
            {agent.agent.name}
          </span>
          <span className={styles.sideLine}>
            <Tag tone={side === "yes" ? "positive" : "sabotage"}>Buy {SIDE_LABEL[side]}</Tag>
            <PriceCents value={livePrice} size="lg" flash />
            <span className="label label-sm">Live</span>
          </span>
        </div>
        <button type="button" className={styles.close} onClick={onClose} disabled={pending} aria-label="Close order form" title="Close (Esc)">
          <IconClose size={14} />
        </button>
      </div>

      <div className={styles.field}>
        <div className={styles.fieldHead}>
          <label htmlFor={inputId} className="label">
            Amount
          </label>
          <span className={cx("label", styles.balance)}>
            Balance <span className={cx("num", styles.balanceValue)}>{formatMoney(balance)}</span>
          </span>
        </div>
        <div className={styles.amountRow}>
          <div className={cx(styles.inputWrap, notice !== null && !failure && styles.inputInvalid)}>
            <span className={styles.currency} aria-hidden="true">
              $
            </span>
            <input
              ref={inputRef}
              id={inputId}
              className={cx("num", styles.input)}
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              placeholder="0"
              value={amount}
              onChange={(e) => onAmountChange(e.target.value)}
              aria-invalid={notice !== null && !failure ? true : undefined}
              aria-describedby={notice !== null ? noticeId : undefined}
              disabled={pending}
            />
          </div>
          {QUICK_AMOUNTS.map((value) => (
            <button
              key={value}
              type="button"
              className={cx("num", styles.chip, parsed === value && styles.chipActive)}
              onClick={() => onAmountChange(String(value))}
              disabled={pending}
            >
              {formatMoney(value, { decimals: 0 })}
            </button>
          ))}
          <button
            type="button"
            className={cx(styles.chip, maxText !== null && amount === maxText && styles.chipActive)}
            onClick={() => maxText !== null && onAmountChange(maxText)}
            disabled={pending || maxText === null}
            title={maxText !== null ? `Use your whole balance (${formatMoney(balance)})` : undefined}
          >
            Max
          </button>
        </div>
      </div>

      <dl className={styles.summary}>
        <div>
          <dt className="label label-sm">Shares</dt>
          <dd className="num">{formatShares(quote.shares)}</dd>
        </div>
        <div>
          <dt className="label label-sm">Avg price</dt>
          <dd className="num">{quote.shares > 0 ? formatCents(quote.price) : "—"}</dd>
        </div>
        <div>
          <dt className="label label-sm">Cost</dt>
          <dd className="num">{formatMoney(quote.cost)}</dd>
        </div>
        <div className={styles.span2}>
          <dt className="label label-sm">Payout if correct</dt>
          <dd className="num">{formatMoney(quote.payoutIfCorrect)}</dd>
        </div>
        <div>
          <dt className="label label-sm">Profit</dt>
          <dd>
            <SignedMoney value={quote.profit} size="md" />
          </dd>
        </div>
      </dl>

      {notice !== null && (
        <p id={noticeId} className={styles.notice} role="alert">
          <IconAlert size={14} className={styles.noticeIcon} />
          <span>{notice}</span>
        </p>
      )}

      <Button type="submit" variant="action" size="lg" block loading={pending} disabled={!canSubmit} className={styles.cta} title={ctaLabel}>
        {ctaLabel}
      </Button>
    </form>
  );
}

function failureMessage(failure: ApiFailure, livePrice: number): ReactNode {
  switch (failure.code) {
    case "price_moved":
      return `Price moved to ${formatCents(livePrice)} — review and confirm again.`;
    case "insufficient_balance":
      return (
        <>
          Not enough balance for this order. <Link to={DEPOSIT_PATH}>Deposit</Link>
        </>
      );
    case "market_closed":
      return "This market is closed to new orders.";
    default:
      return describeError(failure);
  }
}
