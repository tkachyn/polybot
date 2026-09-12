import { describe, expect, it } from "vitest";
import {
  EMPTY,
  MINUS,
  changeTone,
  formatCents,
  formatChangeCents,
  formatClock,
  formatCompactMoney,
  formatCountdown,
  formatDuration,
  formatFightNumber,
  formatInitials,
  formatLogTime,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatShares,
  formatSignedMoney,
  isoDuration,
  moneyTone,
} from "./format";

describe("formatCents", () => {
  it("renders whole cents between 1¢ and 99¢", () => {
    expect(formatCents(0.45)).toBe("45¢");
    expect(formatCents(0.27)).toBe("27¢");
    expect(formatCents(0.01)).toBe("1¢");
    expect(formatCents(0.99)).toBe("99¢");
    expect(formatCents(0.505)).toBe("51¢");
  });

  it("uses one decimal below 1¢ and above 99¢", () => {
    expect(formatCents(0.004)).toBe("0.4¢");
    expect(formatCents(0.996)).toBe("99.6¢");
    expect(formatCents(0.0096)).toBe("1¢");
    expect(formatCents(0.9904)).toBe("99¢");
  });

  it("never makes an open price look settled", () => {
    expect(formatCents(0.0000001)).toBe("<0.1¢");
    expect(formatCents(0.9999999)).toBe(">99.9¢");
    expect(formatCents(0)).toBe("0¢");
    expect(formatCents(1)).toBe("100¢");
  });

  it("clamps and handles empty values", () => {
    expect(formatCents(1.2)).toBe("100¢");
    expect(formatCents(-0.1)).toBe("0¢");
    expect(formatCents(null)).toBe(EMPTY);
    expect(formatCents(undefined)).toBe(EMPTY);
    expect(formatCents(Number.NaN)).toBe(EMPTY);
  });
});

describe("formatChangeCents", () => {
  it("signs changes with + and a real minus", () => {
    expect(formatChangeCents(0.021)).toBe("+2.1¢");
    expect(formatChangeCents(-0.03)).toBe(`${MINUS}3¢`);
    expect(formatChangeCents(-0.03)).not.toContain("-");
    expect(formatChangeCents(0.12)).toBe("+12¢");
    expect(formatChangeCents(0.0001)).toBe("0¢");
    expect(formatChangeCents(null)).toBe(EMPTY);
  });

  it("agrees with changeTone", () => {
    expect(changeTone(0.021)).toBe("positive");
    expect(changeTone(-0.03)).toBe("negative");
    expect(changeTone(0.0001)).toBe("neutral");
  });
});

describe("money", () => {
  it("formats dollars with separators", () => {
    expect(formatMoney(1234.56)).toBe("$1,234.56");
    expect(formatMoney(49.95)).toBe("$49.95");
    expect(formatMoney(-5)).toBe(`${MINUS}$5.00`);
    expect(formatMoney(-0.001)).toBe("$0.00");
    expect(formatMoney(1000, { decimals: 0 })).toBe("$1,000");
    expect(formatMoney(null)).toBe(EMPTY);
  });

  it("formats signed money", () => {
    expect(formatSignedMoney(12.34)).toBe("+$12.34");
    expect(formatSignedMoney(-5)).toBe(`${MINUS}$5.00`);
    expect(formatSignedMoney(0.004)).toBe("$0.00");
    expect(moneyTone(0.004)).toBe("neutral");
    expect(moneyTone(-1)).toBe("negative");
  });

  it("formats compact volumes", () => {
    expect(formatCompactMoney(950)).toBe("$950");
    expect(formatCompactMoney(12_400)).toBe("$12.4K");
    expect(formatCompactMoney(1_200_000)).toBe("$1.2M");
    expect(formatCompactMoney(999_960)).toBe("$1M");
  });
});

describe("shares, numbers and percentages", () => {
  it("formats shares", () => {
    expect(formatShares(185)).toBe("185");
    expect(formatShares(1234)).toBe("1,234");
    expect(formatShares(1, { unit: true })).toBe("1 share");
    expect(formatShares(185, { unit: true })).toBe("185 shares");
  });

  it("formats counts", () => {
    expect(formatNumber(1204)).toBe("1,204");
    expect(formatNumber(-3)).toBe(`${MINUS}3`);
  });

  it("formats percentages", () => {
    expect(formatPercent(0.123)).toBe("12.3%");
    expect(formatPercent(0.5, { decimals: 0 })).toBe("50%");
    expect(formatPercent(0.123, { signed: true })).toBe("+12.3%");
    expect(formatPercent(-0.04, { signed: true })).toBe(`${MINUS}4.0%`);
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(null)).toBe(EMPTY);
  });
});

describe("fight numbers", () => {
  it("zero-pads to four digits", () => {
    expect(formatFightNumber(412)).toBe("#0412");
    expect(formatFightNumber(1)).toBe("#0001");
    expect(formatFightNumber(12345)).toBe("#12345");
    expect(formatFightNumber(null)).toBe(EMPTY);
  });
});

describe("clocks and durations", () => {
  it("formats elapsed clocks", () => {
    expect(formatClock(247_000)).toBe("04:07");
    expect(formatClock(247_999)).toBe("04:07");
    expect(formatClock(3_723_000)).toBe("1:02:03");
    expect(formatClock(-5)).toBe("00:00");
  });

  it("formats countdowns, rounding up", () => {
    expect(formatCountdown(42_000)).toBe("42s");
    expect(formatCountdown(999)).toBe("1s");
    expect(formatCountdown(247_000)).toBe("4m 07s");
    expect(formatCountdown(3_840_000)).toBe("1h 04m");
    expect(formatCountdown(-1)).toBe("0s");
  });

  it("formats durations, rounding down", () => {
    expect(formatDuration(134_000)).toBe("2m 14s");
    expect(formatDuration(134_999)).toBe("2m 14s");
  });

  it("builds ISO durations", () => {
    expect(isoDuration(247_000)).toBe("PT4M7S");
    expect(isoDuration(0)).toBe("PT0S");
    expect(isoDuration(3_600_000)).toBe("PT1H");
  });
});

describe("times", () => {
  it("formats log timestamps as local HH:MM:SS", () => {
    const at = new Date(2026, 8, 12, 14, 3, 22).getTime();
    expect(formatLogTime(at)).toBe("14:03:22");
    expect(formatLogTime(new Date(2026, 8, 12, 9, 5, 7).getTime())).toBe("09:05:07");
  });

  it("formats relative times", () => {
    const now = new Date(2026, 8, 12, 12, 0, 0).getTime();
    expect(formatRelativeTime(now - 5_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 32_000, now)).toBe("32s ago");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(formatRelativeTime(now + 5 * 60_000, now)).toBe("in 5m");
    expect(formatRelativeTime(new Date(2026, 8, 1, 12).getTime(), now)).toBe("Sep 1");
    expect(formatRelativeTime(new Date(2025, 8, 1, 12).getTime(), now)).toBe("Sep 1, 2025");
  });
});

describe("formatInitials", () => {
  it("derives two letters", () => {
    expect(formatInitials("Eric Chen")).toBe("EC");
    expect(formatInitials("trader-4f2a")).toBe("T4");
    expect(formatInitials("ana")).toBe("AN");
    expect(formatInitials("")).toBe("?");
  });
});
