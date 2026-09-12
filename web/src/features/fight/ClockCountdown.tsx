import { cx } from "../../lib/cx";
import { EMPTY, isoDuration } from "../../lib/format";
import { useNow } from "../../state/clock";
import { formatCountdownClock } from "./fightView";

export type ClockCountdownProps = {
  /** Target timestamp (server clock). Null renders "—". */
  to: number | null;
  /** Shown once the target passes. */
  expiredLabel?: string;
  className?: string;
};

/** Ticking m:ss countdown ("4:07"), server-corrected. */
export function ClockCountdown({ to, expiredLabel = "0:00", className }: ClockCountdownProps) {
  const active = typeof to === "number";
  const now = useNow(1000, active);
  if (!active) return <span className={cx("num", className)}>{EMPTY}</span>;
  const remaining = to - now;
  return (
    <time className={cx("num", className)} dateTime={isoDuration(Math.max(0, remaining))}>
      {remaining <= 0 ? expiredLabel : formatCountdownClock(remaining)}
    </time>
  );
}
