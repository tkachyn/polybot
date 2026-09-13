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

export type ClockPhraseProps = {
  to: number;
  /** Words before the clock, e.g. "Trading freezes in". */
  lead: string;
  /** The target is an estimate: the clock reads "~0:42", and `due` replaces the phrase once it passes. */
  approximate?: boolean;
  due?: string;
  leadClassName?: string;
  clockClassName?: string;
};

/**
 * "<lead> 1:59", ticking and server-corrected. An estimate reads "~0:42" and,
 * rather than sitting at "~0:00" once it passes, turns into `due`.
 */
export function ClockPhrase({ to, lead, approximate = false, due, leadClassName, clockClassName }: ClockPhraseProps) {
  const now = useNow(1000, true, to);
  const remaining = to - now;
  if (approximate && remaining <= 0) return <span className={leadClassName}>{due ?? lead}</span>;
  return (
    <>
      <span className={leadClassName}>{lead}</span>{" "}
      <time
        className={cx("num", clockClassName)}
        dateTime={isoDuration(Math.max(0, remaining))}
        title={approximate ? "Estimated from the fastest agent’s pace" : undefined}
      >
        {approximate && "~"}
        {formatCountdownClock(remaining)}
      </time>
    </>
  );
}

/** Ticking m:ss countdown ("4:07"), server-corrected. */
export function ClockCountdown({ to, expiredLabel = "0:00", className }: ClockCountdownProps) {
  const active = typeof to === "number";
  // Tick on the target's own second boundaries, so "0:42" turns over with the server's clock.
  const now = useNow(1000, active, to ?? 0);
  if (!active) return <span className={cx("num", className)}>{EMPTY}</span>;
  const remaining = to - now;
  return (
    <time className={cx("num", className)} dateTime={isoDuration(Math.max(0, remaining))}>
      {remaining <= 0 ? expiredLabel : formatCountdownClock(remaining)}
    </time>
  );
}
