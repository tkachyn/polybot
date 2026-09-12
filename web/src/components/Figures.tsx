/**
 * Figure primitives. All render tabular numerals via `.num` and take the
 * nullable DTO values directly ("—" for null).
 */
import { useEffect, useRef, useState } from "react";
import { cx } from "../lib/cx";
import {
  changeTone,
  formatCents,
  formatChangeCents,
  formatMoney,
  formatPercent,
  formatSignedMoney,
  moneyTone,
  type ChangeTone,
  type MoneyOptions,
  type Numeric,
} from "../lib/format";
import styles from "./Figures.module.css";

/** sm 12px, md 13px, lg 16px (price), xl 17px (price). */
export type FigureSize = "sm" | "md" | "lg" | "xl";
/** default = primary text, inherit = parent colour. */
export type FigureTone = "default" | "positive" | "negative" | "muted" | "secondary" | "inherit";

type FigureBase = {
  size?: FigureSize;
  className?: string;
};

function toneClass(tone: FigureTone | ChangeTone): string | undefined {
  switch (tone) {
    case "positive":
      return styles.positive;
    case "negative":
      return styles.negative;
    case "muted":
    case "neutral":
      return styles.muted;
    case "secondary":
      return styles.secondary;
    case "inherit":
      return styles.inherit;
    default:
      return undefined;
  }
}

export type PriceCentsProps = FigureBase & {
  /** Probability 0..1. */
  value: Numeric;
  tone?: FigureTone;
  /** Briefly tint green/terracotta when the value ticks up/down. */
  flash?: boolean;
};

/** "45¢" (see formatCents for the sub-1¢ / above-99¢ rule). */
export function PriceCents({ value, size = "lg", tone = "default", flash = false, className }: PriceCentsProps) {
  const text = formatCents(value);
  const previous = useRef(value);
  const [tick, setTick] = useState<{ dir: "up" | "down"; n: number } | null>(null);

  useEffect(() => {
    const prev = previous.current;
    previous.current = value;
    if (!flash || typeof prev !== "number" || typeof value !== "number" || prev === value) return;
    setTick((t) => ({ dir: value > prev ? "up" : "down", n: (t?.n ?? 0) + 1 }));
  }, [value, flash]);

  return (
    <span
      key={tick ? tick.n : undefined}
      className={cx("num", styles.figure, styles[size], toneClass(tone), tick && (tick.dir === "up" ? styles.flashUp : styles.flashDown), className)}
    >
      {text}
    </span>
  );
}

export type ChangeCentsProps = FigureBase & {
  /** Change in probability units (-1..1), e.g. FightAgentSummary.change. */
  value: Numeric;
};

/** "+2.1¢" green, "−3¢" terracotta, "0¢" muted. */
export function ChangeCents({ value, size = "sm", className }: ChangeCentsProps) {
  return <span className={cx("num", styles.figure, styles[size], toneClass(changeTone(value)), className)}>{formatChangeCents(value)}</span>;
}

export type MoneyProps = FigureBase & MoneyOptions & { value: Numeric; tone?: FigureTone };

/** "$1,234.56". */
export function Money({ value, size = "md", tone = "default", decimals, className }: MoneyProps) {
  return <span className={cx("num", styles.figure, styles[size], toneClass(tone), className)}>{formatMoney(value, { decimals })}</span>;
}

export type SignedMoneyProps = FigureBase & MoneyOptions & { value: Numeric };

/** "+$12.34" green, "−$5.00" terracotta, "$0.00" muted. */
export function SignedMoney({ value, size = "md", decimals, className }: SignedMoneyProps) {
  return (
    <span className={cx("num", styles.figure, styles[size], toneClass(moneyTone(value)), className)}>
      {formatSignedMoney(value, { decimals })}
    </span>
  );
}

export type SignedPercentProps = FigureBase & { value: Numeric; decimals?: number };

/** Ratio as "+12.3%" green / "−4.0%" terracotta / "0.0%" muted. */
export function SignedPercent({ value, size = "md", decimals = 1, className }: SignedPercentProps) {
  const text = formatPercent(value, { decimals, signed: true });
  const tone: ChangeTone = text.startsWith("+") ? "positive" : text.startsWith("−") ? "negative" : "neutral";
  return <span className={cx("num", styles.figure, styles[size], toneClass(tone), className)}>{text}</span>;
}
