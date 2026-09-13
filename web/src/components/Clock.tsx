/**
 * Ticking figures. Each subscribes to the shared server-corrected clock
 * (state/clock.ts) itself, so only the figure re-renders on a tick.
 */
import { cx } from "../lib/cx";
import { formatClock, formatCountdown, formatRelativeTime, isoDuration, type Numeric } from "../lib/format";
import { useNow } from "../state/clock";

export type ElapsedClockProps = {
  /** Start timestamp (e.g. fight.startedAt). Null renders "—". */
  from: Numeric;
  /** End timestamp (e.g. fight.finishedAt). When set the clock stops there. */
  until?: Numeric;
  className?: string;
};

/** "04:07" / "1:02:03" since `from`, ticking every second until `until`. */
export function ElapsedClock({ from, until, className }: ElapsedClockProps) {
  const running = typeof from === "number" && (until === null || until === undefined);
  // Tick on `from`'s own second boundaries, so the clock turns over with the server's.
  const now = useNow(1000, running, typeof from === "number" ? from : 0);
  const end = typeof until === "number" ? until : now;
  const ms = typeof from === "number" ? end - from : null;
  return (
    <time className={cx("num", className)} dateTime={ms === null ? undefined : isoDuration(ms)}>
      {formatClock(ms)}
    </time>
  );
}

export type CountdownProps = {
  /** Target timestamp (e.g. estimatedResolutionAt, startsAt). Null renders `placeholder`. */
  to: Numeric;
  /** Shown once the target passes. Default "0s". */
  expiredLabel?: string;
  /** Shown when `to` is null. Default "—". */
  placeholder?: string;
  className?: string;
};

/** "42s" / "4m 07s" / "1h 04m" until `to`, rounded up. */
export function Countdown({ to, expiredLabel = "0s", placeholder = "—", className }: CountdownProps) {
  const active = typeof to === "number";
  const now = useNow(1000, active, typeof to === "number" ? to : 0);
  if (!active) return <span className={cx("num", className)}>{placeholder}</span>;
  const remaining = to - now;
  return (
    <time className={cx("num", className)} dateTime={isoDuration(Math.max(0, remaining))}>
      {remaining <= 0 ? expiredLabel : formatCountdown(remaining)}
    </time>
  );
}

export type RelativeTimeProps = {
  at: Numeric;
  className?: string;
};

/** "32s ago" / "5m ago" / "Sep 4", refreshed every 10 s. */
export function RelativeTime({ at, className }: RelativeTimeProps) {
  const now = useNow(10_000, typeof at === "number");
  return (
    <time className={cx("num", className)} dateTime={typeof at === "number" ? new Date(at).toISOString() : undefined}>
      {formatRelativeTime(at, now)}
    </time>
  );
}
