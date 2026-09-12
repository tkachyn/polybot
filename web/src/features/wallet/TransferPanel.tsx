import { useId, useRef, useState, type FormEvent } from "react";
import type { Account, WalletTransferResponse } from "@contract";
import { deposit, describeError, isApiFailure, withdraw } from "../../api/client";
import { Button, ErrorBanner, IconAlert, IconClose, SegmentedControl, type SegmentedOption } from "../../components";
import { cx } from "../../lib/cx";
import { formatMoney, formatTimeOfDay } from "../../lib/format";
import {
  TRANSFER_PAST,
  TRANSFER_VERB,
  WALLET_QUICK_AMOUNTS,
  amountInputValue,
  inputMatches,
  maxWithdrawable,
  transferLabel,
  validateTransfer,
  type TransferKind,
} from "./transfer";
import styles from "./Wallet.module.css";

const TAB_OPTIONS: readonly SegmentedOption<TransferKind>[] = [
  { value: "deposit", label: "Deposit" },
  { value: "withdraw", label: "Withdraw" },
];

type Method = { id: string; name: string; note: string; enabled: boolean };

/** Only virtual credits move; the others are listed so the product shape is clear. */
const METHODS: readonly Method[] = [
  { id: "virtual", name: "Virtual credits", note: "Instant · arena play money", enabled: true },
  { id: "card", name: "Card", note: "Unavailable — virtual credits only", enabled: false },
  { id: "usdc", name: "USDC", note: "Unavailable — virtual credits only", enabled: false },
  { id: "bank", name: "Bank transfer", note: "Unavailable — virtual credits only", enabled: false },
];

type Receipt = { kind: TransferKind; amount: number; balance: number; at: number };

export type TransferPanelProps = {
  tab: TransferKind;
  onTabChange: (tab: TransferKind) => void;
  userId: string;
  /** Null while the session is loading; transfers are disabled until it is known. */
  account: Account | null;
  /** Called with every successful transfer response (apply the account, record the entry). */
  onTransferred: (response: WalletTransferResponse) => void;
};

function failureMessage(kind: TransferKind, err: unknown): string {
  if (kind === "withdraw" && isApiFailure(err, "insufficient_balance")) {
    return "That’s more than your available balance. Lower the amount and try again.";
  }
  if (isApiFailure(err, "not_found")) return "Your wallet isn’t ready yet. Try again in a moment.";
  return describeError(err);
}

/** Deposit / withdraw tabs, amount, quick chips, method list and the CTA. */
export function TransferPanel({ tab, onTabChange, userId, account, onTransferred }: TransferPanelProps) {
  const [input, setInput] = useState("100");
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const inFlight = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = useId();

  const balance = account ? account.balance : null;
  const check = validateTransfer(tab, input, balance);
  const showError = check.error !== null && (attempted || input.trim() !== "");
  const maxOut = maxWithdrawable(balance);
  const ready = account !== null;

  const clearMessages = () => {
    setSubmitError(null);
    setReceipt(null);
  };

  const changeTab = (next: TransferKind) => {
    clearMessages();
    setAttempted(false);
    onTabChange(next);
  };

  const setAmount = (value: string) => {
    setInput(value);
    clearMessages();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttempted(true);
    if (check.error || !ready || inFlight.current) {
      if (check.error) inputRef.current?.focus();
      return;
    }
    inFlight.current = true;
    setPending(true);
    setSubmitError(null);
    setReceipt(null);
    const kind = tab;
    const amount = check.amount;
    try {
      const send = kind === "deposit" ? deposit : withdraw;
      const res = await send(userId, { amount, method: "virtual" });
      onTransferred(res);
      setReceipt({ kind, amount: Math.abs(res.entry.amount) || amount, balance: res.account.balance, at: res.entry.at });
      setAttempted(false);
      // A withdrawal usually leaves less than the old amount; clear it so no
      // stale "at most" error appears under the confirmation.
      if (kind === "withdraw") setInput("");
    } catch (err) {
      setSubmitError(failureMessage(kind, err));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const verb = TRANSFER_VERB[tab];

  return (
    <section className={styles.card} aria-labelledby={`${ids}-title`}>
      <div className={styles.cardHeader}>
        <h2 id={`${ids}-title`} className={styles.sectionTitle}>
          Move credits
        </h2>
      </div>

      <SegmentedControl options={TAB_OPTIONS} value={tab} onChange={changeTab} aria-label="Transfer type" block />

      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.field}>
          <label htmlFor={`${ids}-amount`} className="label">
            {tab === "deposit" ? "Amount to deposit" : "Amount to withdraw"}
          </label>
          <div className={cx(styles.amountBox, showError && styles.amountBoxInvalid)}>
            <span className={styles.currency} aria-hidden="true">
              $
            </span>
            <input
              ref={inputRef}
              id={`${ids}-amount`}
              className={cx("num", styles.amountInput)}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              placeholder="0.00"
              value={input}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={showError || undefined}
              aria-describedby={`${ids}-amount-msg`}
            />
          </div>
          <span id={`${ids}-amount-msg`} className={cx("num", showError ? styles.fieldError : styles.fieldHint)} aria-live="polite">
            {showError
              ? check.error
              : tab === "withdraw" && ready
                ? `Up to ${formatMoney(maxOut)} available`
                : `Up to ${formatMoney(100_000)} per transfer`}
          </span>
        </div>

        <div className={styles.chips} role="group" aria-label="Quick amounts">
          {WALLET_QUICK_AMOUNTS.map((amount) => (
            <button
              key={amount}
              type="button"
              className={cx("num", styles.chip, inputMatches(input, amount) && styles.chipSelected)}
              onClick={() => setAmount(amountInputValue(amount))}
              disabled={tab === "withdraw" && ready && amount > maxOut}
            >
              {formatMoney(amount, { decimals: 0 })}
            </button>
          ))}
          {tab === "withdraw" && (
            <button
              type="button"
              className={cx(styles.chip, ready && maxOut > 0 && inputMatches(input, maxOut) && styles.chipSelected)}
              onClick={() => setAmount(maxOut.toFixed(2))}
              disabled={!ready || maxOut <= 0}
              title={ready ? `Withdraw ${formatMoney(maxOut)}` : undefined}
            >
              Max
            </button>
          )}
        </div>

        <fieldset className={styles.methods}>
          <legend className={cx("label", styles.legend)}>
            Method
          </legend>
          {METHODS.map((method) => (
            <label
              key={method.id}
              className={cx(styles.method, method.enabled && styles.methodSelected, !method.enabled && styles.methodDisabled)}
              title={method.enabled ? undefined : method.note}
            >
              <input
                type="radio"
                name={`${ids}-method`}
                value={method.id}
                className={styles.radio}
                checked={method.enabled}
                disabled={!method.enabled}
                readOnly
              />
              <span className={styles.methodText}>
                <span className={styles.methodName}>{method.name}</span>
                <span className={styles.methodNote}>{method.note}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {receipt && (
          <div className={styles.success} role="status">
            <span className={styles.successDot} aria-hidden="true" />
            <span className={styles.successText}>
              <span className={cx("num", styles.successTitle)}>
                {TRANSFER_PAST[receipt.kind]} {formatMoney(receipt.amount)}
              </span>
              <span className={cx("num", styles.successSub)}>
                Available balance {formatMoney(receipt.balance)} · {formatTimeOfDay(receipt.at)}
              </span>
            </span>
            <button type="button" className={styles.dismiss} onClick={() => setReceipt(null)} aria-label="Dismiss confirmation">
              <IconClose size={14} />
            </button>
          </div>
        )}

        <ErrorBanner error={submitError} title={`${verb} failed.`} onDismiss={() => setSubmitError(null)} />

        <Button type="submit" variant="action" size="lg" block loading={pending} disabled={!ready || check.error !== null}>
          <span className="num">{ready ? transferLabel(tab, check) : verb}</span>
        </Button>

        <p className={styles.playMoney}>
          <IconAlert size={14} className={styles.playMoneyIcon} aria-hidden="true" />
          <span>
            <strong>Play money</strong> — virtual arena credits with no cash value.
          </span>
        </p>
      </form>
    </section>
  );
}
