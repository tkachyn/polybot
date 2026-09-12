/**
 * Display formatters. Every figure in the UI goes through one of these so
 * rounding, signs and placeholders stay consistent. Render the output inside
 * tabular numerals (the body default, or the `.num` utility).
 *
 * Conventions:
 * - Every formatter accepts `null`, `undefined` and non-finite numbers and
 *   returns {@link EMPTY} ("—") for them. Nullable DTO fields can be passed
 *   straight in.
 * - Negative values use a real minus sign (U+2212 "−"), never a hyphen.
 * - Timestamps are epoch milliseconds (server clock, see state/clock.ts).
 */

export const EMPTY = "—";
export const MINUS = "−";

export type Numeric = number | null | undefined;

export function isFiniteNumber(value: Numeric): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Rounds half away from zero to `decimals` places. The 1e-9 nudge absorbs
 * binary error (0.00055 * 1000 = 0.5499999...) without crossing a real
 * boundary for inputs with six or fewer decimals, which is all the API sends.
 */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(Math.abs(value) * factor + 1e-9) / factor;
  return value < 0 ? -rounded : rounded;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Prices in cents
// ---------------------------------------------------------------------------

/**
 * Cents from a probability, without the ¢ symbol.
 *
 * Rule:
 * - 0 → "0" and 1 → "100" exactly (settled prices).
 * - From 1¢ to 99¢ inclusive → whole cents, half up ("45", "27").
 * - Below 1¢ or above 99¢ → one decimal ("0.4", "99.6"). The result never
 *   rounds onto the boundary: 0.96¢ reads "1", 99.04¢ reads "99".
 *   Non-zero values under 0.05¢ read "<0.1"; values over 99.95¢ read ">99.9"
 *   so an open market never looks settled.
 * - Inputs are clamped to [0, 1].
 */
export function centsValue(probability: Numeric): string {
  if (!isFiniteNumber(probability)) return EMPTY;
  const cents = clamp(probability, 0, 1) * 100;
  if (cents === 0) return "0";
  if (cents === 100) return "100";
  if (cents < 1) {
    const r = roundTo(cents, 1);
    if (r < 0.1) return "<0.1";
    if (r >= 1) return "1";
    return r.toFixed(1);
  }
  if (cents > 99) {
    const r = roundTo(cents, 1);
    if (r > 99.9) return ">99.9";
    if (r <= 99) return "99";
    return r.toFixed(1);
  }
  return String(Math.round(cents));
}

/** "45¢". See {@link centsValue} for the rounding rule. */
export function formatCents(probability: Numeric): string {
  const value = centsValue(probability);
  return value === EMPTY ? EMPTY : `${value}¢`;
}

export type ChangeTone = "positive" | "negative" | "neutral";

/**
 * Rounds a change to display precision: one decimal under 10¢ (trailing ".0"
 * dropped), whole cents from 10¢. Returns signed cents.
 */
function roundedChangeCents(delta: number): number {
  const cents = Math.abs(delta * 100);
  const oneDecimal = roundTo(cents, 1);
  const shown = oneDecimal >= 10 ? Math.round(cents) : oneDecimal;
  return delta < 0 ? -shown : shown;
}

/** Tone of a price change, consistent with what {@link formatChangeCents} prints. */
export function changeTone(delta: Numeric): ChangeTone {
  if (!isFiniteNumber(delta)) return "neutral";
  const shown = roundedChangeCents(delta);
  if (shown > 0) return "positive";
  if (shown < 0) return "negative";
  return "neutral";
}

/**
 * Signed change in cents from a change in probability units (-1..1):
 * "+2.1¢", "−3¢", "+12¢", and "0¢" when it rounds to nothing.
 */
export function formatChangeCents(delta: Numeric): string {
  if (!isFiniteNumber(delta)) return EMPTY;
  const shown = roundedChangeCents(delta);
  if (shown === 0) return "0¢";
  const abs = Math.abs(shown);
  const text = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
  return `${shown > 0 ? "+" : MINUS}${text}¢`;
}

// ---------------------------------------------------------------------------
// Money, shares, numbers, percentages
// ---------------------------------------------------------------------------

const moneyFormatters = {
  0: new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
  2: new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
} as const;

const ZERO_DIGITS = /^[0.,]*$/;

export type MoneyOptions = {
  /** Fraction digits. Default 2. */
  decimals?: 0 | 2;
};

/** "$1,234.56", "−$5.00". Amounts are virtual credits shown as dollars. */
export function formatMoney(amount: Numeric, options: MoneyOptions = {}): string {
  if (!isFiniteNumber(amount)) return EMPTY;
  const text = moneyFormatters[options.decimals ?? 2].format(Math.abs(amount));
  const negative = amount < 0 && !ZERO_DIGITS.test(text);
  return `${negative ? MINUS : ""}$${text}`;
}

/** "+$12.34", "−$5.00", and "$0.00" when it rounds to zero. */
export function formatSignedMoney(amount: Numeric, options: MoneyOptions = {}): string {
  if (!isFiniteNumber(amount)) return EMPTY;
  const text = moneyFormatters[options.decimals ?? 2].format(Math.abs(amount));
  if (ZERO_DIGITS.test(text)) return `$${text}`;
  return `${amount > 0 ? "+" : MINUS}$${text}`;
}

/** Tone of a signed money amount, consistent with {@link formatSignedMoney}. */
export function moneyTone(amount: Numeric): ChangeTone {
  if (!isFiniteNumber(amount)) return "neutral";
  const cents = roundTo(amount, 2);
  if (cents > 0) return "positive";
  if (cents < 0) return "negative";
  return "neutral";
}

const COMPACT_SUFFIXES = ["K", "M", "B", "T"] as const;

/**
 * Compact money for volumes: "$950", "$12.4K", "$1.2M". Whole dollars under
 * $1,000; one decimal (trailing ".0" dropped) above, rolling to the next unit
 * when rounding would print 1000 ("$999.95K" reads "$1M").
 */
export function formatCompactMoney(amount: Numeric): string {
  if (!isFiniteNumber(amount)) return EMPTY;
  const abs = Math.abs(amount);
  const whole = roundTo(abs, 0);
  const sign = amount < 0 && whole > 0 ? MINUS : "";
  if (whole < 1000) return `${sign}$${moneyFormatters[0].format(whole)}`;
  let scaled = abs / 1000;
  let unit = 0;
  while (roundTo(scaled, 1) >= 1000 && unit < COMPACT_SUFFIXES.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  const r = roundTo(scaled, 1);
  const text = Number.isInteger(r) ? String(r) : r.toFixed(1);
  return `${sign}$${text}${COMPACT_SUFFIXES[unit]}`;
}

const shareFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export type ShareOptions = {
  /** Append "share" / "shares". */
  unit?: boolean;
};

/** "185", "1,234", "12.5"; with `unit`: "1 share", "185 shares". */
export function formatShares(quantity: Numeric, options: ShareOptions = {}): string {
  if (!isFiniteNumber(quantity)) return EMPTY;
  const text = shareFormatter.format(quantity);
  if (!options.unit) return text;
  return `${text} ${Math.abs(quantity) === 1 ? "share" : "shares"}`;
}

const integerFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Plain count with separators: "1,204". Rounds to an integer. */
export function formatNumber(value: Numeric): string {
  if (!isFiniteNumber(value)) return EMPTY;
  const text = integerFormatter.format(Math.abs(value));
  return `${value < 0 && text !== "0" ? MINUS : ""}${text}`;
}

export type PercentOptions = {
  /** Fraction digits. Default 1. */
  decimals?: number;
  /** Prefix "+" on positive values. Negative values always carry "−". */
  signed?: boolean;
};

/** Percent from a ratio: 0.123 → "12.3%"; signed: "+12.3%", "−4.0%". */
export function formatPercent(ratio: Numeric, options: PercentOptions = {}): string {
  if (!isFiniteNumber(ratio)) return EMPTY;
  const decimals = options.decimals ?? 1;
  const value = roundTo(ratio * 100, decimals);
  const text = Math.abs(value).toFixed(decimals);
  if (value === 0) return `${text}%`;
  if (value < 0) return `${MINUS}${text}%`;
  return `${options.signed ? "+" : ""}${text}%`;
}

// ---------------------------------------------------------------------------
// Fight numbers
// ---------------------------------------------------------------------------

/** Zero-padded digits without the hash: 412 → "0412". */
export function fightNumberDigits(value: Numeric): string {
  if (!isFiniteNumber(value)) return EMPTY;
  return String(Math.trunc(Math.abs(value))).padStart(4, "0");
}

/** "#0412". Numbers past 9999 keep all their digits: "#12345". */
export function formatFightNumber(value: Numeric): string {
  const digits = fightNumberDigits(value);
  return digits === EMPTY ? EMPTY : `#${digits}`;
}

// ---------------------------------------------------------------------------
// Clocks and durations
// ---------------------------------------------------------------------------

function splitSeconds(totalSeconds: number): { h: number; m: number; s: number } {
  return {
    h: Math.floor(totalSeconds / 3600),
    m: Math.floor((totalSeconds % 3600) / 60),
    s: totalSeconds % 60,
  };
}

/**
 * Elapsed clock from milliseconds, floored to the second: "04:07" (mm:ss),
 * and "1:02:03" (h:mm:ss) from one hour. Negative input reads "00:00".
 */
export function formatClock(ms: Numeric): string {
  if (!isFiniteNumber(ms)) return EMPTY;
  const { h, m, s } = splitSeconds(Math.floor(Math.max(0, ms) / 1000));
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

function compactDuration(totalSeconds: number): string {
  const { h, m, s } = splitSeconds(totalSeconds);
  if (h > 0) return `${h}h ${pad2(m)}m`;
  if (m > 0) return `${m}m ${pad2(s)}s`;
  return `${s}s`;
}

/**
 * Countdown from remaining milliseconds, rounded UP to the second so it
 * reads "1s" until the moment it expires: "42s", "4m 07s", "1h 04m".
 * Zero or negative reads "0s"; components decide what to show on expiry.
 */
export function formatCountdown(remainingMs: Numeric): string {
  if (!isFiniteNumber(remainingMs)) return EMPTY;
  return compactDuration(Math.max(0, Math.ceil(remainingMs / 1000)));
}

/** A measured duration, floored to the second: 134000 → "2m 14s". */
export function formatDuration(ms: Numeric): string {
  if (!isFiniteNumber(ms)) return EMPTY;
  return compactDuration(Math.floor(Math.max(0, ms) / 1000));
}

/** ISO 8601 duration for `<time dateTime>`: 247000 → "PT4M7S". */
export function isoDuration(ms: Numeric): string {
  if (!isFiniteNumber(ms)) return "PT0S";
  const { h, m, s } = splitSeconds(Math.floor(Math.max(0, ms) / 1000));
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s || (!h && !m) ? `${s}S` : ""}`;
}

// ---------------------------------------------------------------------------
// Dates and times (local time zone)
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Action-log timestamp, local 24-hour "HH:MM:SS": "14:03:22". */
export function formatLogTime(at: Numeric): string {
  if (!isFiniteNumber(at)) return EMPTY;
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Local "HH:MM": "14:03". */
export function formatTimeOfDay(at: Numeric): string {
  if (!isFiniteNumber(at)) return EMPTY;
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "Sep 12, 2026". */
export function formatDate(at: Numeric): string {
  if (!isFiniteNumber(at)) return EMPTY;
  const d = new Date(at);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "Sep 12, 14:03", with the year when it differs from `now`'s year. */
export function formatDateTime(at: Numeric, now: number = Date.now()): string {
  if (!isFiniteNumber(at)) return EMPTY;
  const d = new Date(at);
  const year = d.getFullYear() === new Date(now).getFullYear() ? "" : `, ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}, ${formatTimeOfDay(at)}`;
}

/**
 * Relative time against `now` (pass server-corrected now from useNow()):
 * "just now" (<10s), "32s ago", "5m ago", "3h ago", "2d ago", then a date
 * ("Sep 4", or "Sep 4, 2025" in another year). Future times read "in 5m".
 */
export function formatRelativeTime(at: Numeric, now: number): string {
  if (!isFiniteNumber(at) || !Number.isFinite(now)) return EMPTY;
  const diff = now - at;
  const abs = Math.abs(diff);
  const seconds = Math.floor(abs / 1000);
  let text: string;
  if (seconds < 10) return "just now";
  if (seconds < 60) text = `${seconds}s`;
  else if (seconds < 3600) text = `${Math.floor(seconds / 60)}m`;
  else if (seconds < 86_400) text = `${Math.floor(seconds / 3600)}h`;
  else if (seconds < 7 * 86_400) text = `${Math.floor(seconds / 86_400)}d`;
  else {
    const d = new Date(at);
    const sameYear = d.getFullYear() === new Date(now).getFullYear();
    return `${MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? "" : `, ${d.getFullYear()}`}`;
  }
  return diff < 0 ? `in ${text}` : `${text} ago`;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Avatar initials: "Eric Chen" → "EC", "trader-4f2a" → "T4", "ana" → "AN". */
export function formatInitials(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/[\s._-]+/).filter(Boolean);
  const [first, second] = words;
  if (!first) return "?";
  if (second) return `${first[0] ?? ""}${second[0] ?? ""}`.toUpperCase();
  return first.slice(0, 2).toUpperCase();
}
