/**
 * The bet slip, opened in place when a price is clicked. It quotes with the
 * market maker's own pricing (lib/order.ts over `@pricing`), so the shares,
 * average price and cost it shows are what the order fills at unless the
 * price moves first. The order tolerates SLIPPAGE on its average; past that
 * the server rejects it with the price now, and the slip re-quotes from it.
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
import {
  QUICK_AMOUNTS,
  SLIPPAGE,
  buildConfirmLabel,
  maxAmount,
  parseAmount,
  priceMovedMessage,
  quoteOrder,
  round6,
  sidePrice,
  slipPricing,
} from "../../lib/order";
import { useSession } from "../../state/session";
import { tradingBlockedReason, useEscape } from "./market";
import { rememberSlipOpener, returnFocusToSlipOpener } from "./slipFocus";
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

/** Fresher pricing from a price_moved reply, used until the stream catches up. */
type Requote = {
  racerId: string;
  logOdds: number;
  /** YES price in the reply. */
  yes: number;
  /** The stream's log-odds when the reply came; a change means it caught up. */
  streamLogOdds: number | undefined;
};

/** "12.34": the balance floored to whole cents, for the Max chip. */
function maxAmountText(balance: number): string {
  return (Math.floor(maxAmount(balance) * 100 + 1e-6) / 100).toFixed(2);
}

/** Connection trouble, which fresh live data shows is over. An unconfirmed order is not. */
function clearsWithFreshData(failure: ApiFailure): boolean {
  return !failure.unconfirmed && (failure.code === "network" || failure.code === "timeout" || failure.code === "server");
}

export function OrderForm({ fight, agent, visual, side, amount, onAmountChange, onClose, onFilled }: OrderFormProps) {
  const { userId, account, applyAccount } = useSession();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [requote, setRequote] = useState<Requote | null>(null);
  const pendingRef = useRef(false);
  /** The id of an order that may have filled: a retry reuses it, so it can never fill twice. */
  const unconfirmedRef = useRef<{ signature: string; clientOrderId: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const noticeId = useId();

  const streamLogOdds = (fight.pricing as FightDetail["pricing"] | undefined)?.logOdds[agent.racerId];
  const fresh = requote !== null && requote.racerId === agent.racerId && requote.streamLogOdds === streamLogOdds ? requote : null;
  const pricing = slipPricing(fight, agent, fresh?.logOdds ?? null);
  const livePrice = fresh ? (side === "yes" ? fresh.yes : round6(1 - fresh.yes)) : sidePrice(agent, side);
  const balance = account?.balance ?? null;
  const parsed = parseAmount(amount);
  const quote = quoteOrder({ price: livePrice, pricing, side, amount: parsed, balance: balance ?? 0 });
  const blocked = tradingBlockedReason(fight.marketStatus);
  const amountEntered = amount.trim() !== "";
  const maxText = balance !== null ? maxAmountText(balance) : null;

  // Focus the amount when the slip opens or moves to another outcome, and
  // remember the price button that did it, for when the slip closes.
  useEffect(() => {
    rememberSlipOpener(document.activeElement);
    inputRef.current?.focus({ preventScroll: true });
  }, [agent.racerId, side]);

  // A server rejection belongs to the order that was sent.
  useEffect(() => {
    setFailure(null);
  }, [agent.racerId, side, amount]);

  // Live data arriving again means the connection is back.
  useEffect(() => {
    setFailure((current) => (current && clearsWithFreshData(current) ? null : current));
  }, [fight.pricing]);

  const close = () => {
    returnFocusToSlipOpener();
    onClose();
  };
  useEscape(close, !pending);

  const canSubmit = blocked === null && account !== null && quote.error === null && !pending;

  let ctaLabel: string;
  if (blocked) ctaLabel = blocked;
  else if (!account) ctaLabel = "Connecting to your account…";
  else if (quote.error?.code === "balance") ctaLabel = "Insufficient balance";
  else if (quote.shares >= 1) {
    ctaLabel = buildConfirmLabel({ side, agentName: agent.agent.name, price: quote.avgPrice, shares: quote.shares, cost: quote.cost });
  } else ctaLabel = "Enter an amount";
  const slippageNote = quote.shares >= 1
    ? `Fills only if the average stays within ${Math.round(SLIPPAGE * 100)}% of ${formatCents(quote.avgPrice)}: at most ${formatMoney(quote.maxCost)}.`
    : undefined;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || pendingRef.current) return;
    // An order that may already have filled is resent under its first id:
    // the server then returns that fill instead of placing a second one.
    const signature = `${fight.raceId}|${agent.racerId}|${side}|${amount.trim()}`;
    const retry = unconfirmedRef.current?.signature === signature ? unconfirmedRef.current : null;
    const clientOrderId = retry?.clientOrderId ?? newClientOrderId();
    const order: OrderRequest = {
      userId,
      racerId: agent.racerId,
      side,
      action: "buy",
      quantity: quote.shares,
      limitPrice: quote.limitPrice,
      clientOrderId,
    };
    pendingRef.current = true;
    setPending(true);
    setFailure(null);
    try {
      const response = await placeOrder(fight.raceId, order);
      unconfirmedRef.current = null;
      setRequote(null);
      applyAccount(response.account, response.serverTime);
      onFilled(response);
    } catch (err) {
      if (!isAbortError(err)) {
        const next = toApiFailure(err);
        unconfirmedRef.current = next.unconfirmed ? { signature, clientOrderId } : null;
        const details = next.code === "price_moved" ? next.details : undefined;
        if (details && details.racerId === agent.racerId) {
          setRequote({
            racerId: details.racerId,
            logOdds: details.logOdds,
            yes: details.side === "yes" ? details.price : round6(1 - details.price),
            streamLogOdds,
          });
        }
        setFailure(next);
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  let notice: ReactNode = null;
  if (failure) notice = failureMessage(failure);
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
            <span className="label label-sm">{blocked ? (fight.marketStatus === "frozen" ? "Frozen" : "Closed") : "Live"}</span>
          </span>
        </div>
        <button type="button" className={styles.close} onClick={close} disabled={pending} aria-label="Close order form" title="Close (Esc)">
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
          <dd className="num" title={quote.shares > 0 ? "Your order moves the price, so the average is above the current price." : undefined}>
            {quote.shares > 0 ? formatCents(quote.avgPrice) : "—"}
          </dd>
        </div>
        <div>
          <dt className="label label-sm">Cost</dt>
          <dd className="num" title={slippageNote}>
            {formatMoney(quote.cost)}
          </dd>
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

      <Button
        type="submit"
        variant="action"
        size="lg"
        block
        loading={pending}
        disabled={!canSubmit}
        className={styles.cta}
        title={slippageNote ? `${ctaLabel}. ${slippageNote}` : ctaLabel}
      >
        {ctaLabel}
      </Button>
    </form>
  );
}

function failureMessage(failure: ApiFailure): ReactNode {
  // It may have filled: never say it failed; point to where the truth shows.
  if (failure.unconfirmed) {
    return (
      <>
        {describeError(failure)} <Link to="/portfolio">Portfolio</Link>
      </>
    );
  }
  switch (failure.code) {
    case "price_moved":
      return failure.details
        ? `${priceMovedMessage(failure.details)} The quote above is updated; confirm again.`
        : "The price moved before your order filled. Check the new quote and confirm again.";
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
