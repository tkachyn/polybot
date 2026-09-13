/**
 * The global "live data is stale" banner. AppShell renders it once. It
 * floats under the navbar, over the content, so no screen's layout moves
 * when it comes and goes (the fight screen must never scroll). When it
 * shows is decided in state/connection.ts.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { reconnectStreams } from "../api/stream";
import { cx } from "../lib/cx";
import { useConnectionBanner, type ConnectionBannerState } from "../state/connection";
import { Button } from "./Button";
import { IconAlert } from "./icons";
import styles from "./ConnectionBanner.module.css";

/** How long "Retry now" shows its spinner after a click. */
const RETRY_FEEDBACK_MS = 1_500;

type StaleBanner = Extract<ConnectionBannerState, { kind: "stale" }>;

function staleCopy(banner: StaleBanner): { title: string; detail: string } {
  if (banner.offline) return { title: "You’re offline.", detail: "Live updates are paused; prices may be out of date." };
  if (banner.everLive) return { title: "Live updates paused.", detail: "Reconnecting… prices may be out of date." };
  return { title: "Can’t reach live updates.", detail: "Retrying…" };
}

export function ConnectionBanner() {
  const banner = useConnectionBanner();
  const [retrying, setRetrying] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(retryTimer.current), []);

  const retry = () => {
    reconnectStreams();
    setRetrying(true);
    clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => setRetrying(false), RETRY_FEEDBACK_MS);
  };

  let content: ReactNode = null;
  if (banner.kind === "stale") {
    const { title, detail } = staleCopy(banner);
    content = (
      <div className={styles.banner}>
        <IconAlert size={16} className={styles.icon} />
        <p className={styles.text}>
          <strong className={styles.title}>{title}</strong> <span className={styles.detail}>{detail}</span>
        </p>
        {!banner.offline && (
          <Button size="sm" onClick={retry} loading={retrying} className={styles.action}>
            Retry now
          </Button>
        )}
      </div>
    );
  } else if (banner.kind === "resumed") {
    content = (
      <div className={cx(styles.banner, styles.resumed)}>
        <span className={styles.dot} aria-hidden="true" />
        <p className={styles.text}>{banner.firstConnection ? "Connected. Live updates are on." : "Live updates resumed."}</p>
      </div>
    );
  }

  // The region stays mounted so screen readers announce every change.
  return (
    <div className={styles.region} role="status" aria-live="polite">
      {content}
    </div>
  );
}
