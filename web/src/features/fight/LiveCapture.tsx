/**
 * Live browser capture for one agent.
 *
 * Frames are periodic captures: a bumped `frame.seq` means a new image at
 * GET /api/fights/:raceId/agents/:racerId/frame?seq=N (Cache-Control: no-store).
 * To avoid flicker the next frame is fetched and decoded off-screen (double
 * buffer) and only then swapped in. Loads never overlap: when frames arrive
 * faster than they download, the newest wanted seq is fetched next and the
 * ones in between are skipped.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BrowserView, FightStatus, FrameInfo } from "@contract";
import { fightFrameUrl } from "../../api/client";
import { cx } from "../../lib/cx";
import { formatLogTime } from "../../lib/format";
import { useNow } from "../../state/clock";
import { STALE_FRAME_MS, frameAgeLabel } from "./fightView";
import { ClockCountdown } from "./ClockCountdown";
import styles from "./LiveCapture.module.css";

export type LiveCaptureProps = {
  raceId: string;
  racerId: string;
  frame: FrameInfo | null;
  /** Absent from backends that predate the Steel live view; the frame path is used instead. */
  browserView?: BrowserView | null;
  fightStatus: FightStatus;
  /** Scheduled start, for the upcoming placeholder. */
  startsAt: number | null;
  /** Agent name, for the image alt text. */
  agentName: string;
  /**
   * The agent has stopped (finished, failed, timed out, or the race is over):
   * its last capture is badged "Final frame" instead of LIVE.
   */
  final?: boolean;
  /** Pinned across the top of the capture (e.g. the live URL). */
  overlay?: ReactNode;
  /** Show the spectator-owned warning while this agent handles sabotage. */
  sabotageActive?: boolean;
  className?: string;
};

export function LiveCapture(props: LiveCaptureProps) {
  // A new agent or fight starts with an empty buffer.
  return <CaptureSurface key={`${props.raceId}:${props.racerId}`} {...props} />;
}

type Shown = { src: string; seq: number; capturedAt: number };

type PersistentViewer = {
  iframe: HTMLIFrameElement;
  hosts: Set<HTMLElement>;
};

/** One Steel iframe per racer, moved between compact and focused views. */
const persistentViewers = new Map<string, PersistentViewer>();

function CaptureSurface({
  raceId,
  racerId,
  frame,
  browserView,
  fightStatus,
  startsAt,
  agentName,
  final = false,
  overlay,
  sabotageActive = false,
  className,
}: LiveCaptureProps) {
  const shown = useBufferedFrame(raceId, racerId, frame);
  const viewerUrl = browserView?.status === "live" ? browserView.viewerUrl ?? null : null;
  const [viewerFailed, setViewerFailed] = useState(false);
  useEffect(() => setViewerFailed(false), [viewerUrl]);
  const showViewer = viewerUrl !== null && !viewerFailed;
  return (
    <div className={cx(styles.capture, sabotageActive && styles.sabotageActive, className)}>
      {showViewer ? (
        <PersistentViewer
          viewerKey={`${raceId}:${racerId}`}
          viewerUrl={viewerUrl}
          title={`${agentName} live browser view`}
          onError={() => setViewerFailed(true)}
        />
      ) : shown ? (
        <img className={styles.image} src={shown.src} alt={`${agentName} browser capture`} draggable={false} />
      ) : (
        <Placeholder fightStatus={fightStatus} startsAt={startsAt} />
      )}
      {overlay && <div className={styles.overlay}>{overlay}</div>}
      {sabotageActive && (
        <span className={styles.sabotageAlert} role="status" aria-live="polite">
          <span aria-hidden="true">⚠</span> Sabotage in progress
        </span>
      )}
      {!showViewer && shown && fightStatus === "live" && (final ? <FinalFrame capturedAt={shown.capturedAt} /> : <FrameAge capturedAt={shown.capturedAt} />)}
    </div>
  );
}

function PersistentViewer({
  viewerKey,
  viewerUrl,
  title,
  onError,
}: {
  viewerKey: string;
  viewerUrl: string;
  title: string;
  onError: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let viewer = persistentViewers.get(viewerKey);
    if (!viewer) {
      const iframe = document.createElement("iframe");
      iframe.className = styles.viewer ?? "viewer";
      iframe.title = title;
      iframe.setAttribute("aria-label", title);
      iframe.allow = "autoplay; fullscreen";
      iframe.tabIndex = -1;
      viewer = { iframe, hosts: new Set() };
      persistentViewers.set(viewerKey, viewer);
    }

    const iframe = viewer.iframe;
    iframe.title = title;
    iframe.setAttribute("aria-label", title);
    if (iframe.src !== viewerUrl) iframe.src = viewerUrl;
    const handleError = () => onErrorRef.current();
    iframe.addEventListener("error", handleError);
    viewer.hosts.add(host);
    host.appendChild(iframe);

    return () => {
      iframe.removeEventListener("error", handleError);
      viewer?.hosts.delete(host);
      if (iframe.parentElement === host) {
        const fallback = [...(viewer?.hosts ?? [])].at(-1);
        fallback?.appendChild(iframe);
      }
      if (viewer && viewer.hosts.size === 0) {
        iframe.remove();
        persistentViewers.delete(viewerKey);
      }
    };
  }, [title, viewerKey, viewerUrl]);

  return (
    <div
      ref={hostRef}
      className={styles.viewerHost}
      data-viewer-url={viewerUrl}
      aria-hidden="true"
    />
  );
}

/** The agent stopped; this is the last capture it produced. */
function FinalFrame({ capturedAt }: { capturedAt: number }) {
  return (
    <span className={styles.badge} title={`Last capture before the agent stopped, ${formatLogTime(capturedAt)}`}>
      <span className={styles.badgeFinal}>Final frame</span>
    </span>
  );
}

function Placeholder({ fightStatus, startsAt }: { fightStatus: FightStatus; startsAt: number | null }) {
  if (fightStatus === "upcoming") {
    return (
      <div className={styles.placeholder}>
        <span className="label label-sm">Starts in</span>
        {startsAt === null ? (
          <span className={styles.placeholderText}>Starting soon</span>
        ) : (
          <ClockCountdown to={startsAt} expiredLabel="Starting…" className={styles.placeholderFigure} />
        )}
      </div>
    );
  }
  return (
    <div className={styles.placeholder}>
      <span className={styles.spinner} aria-hidden="true" />
      <span className={styles.placeholderText}>{fightStatus === "live" ? "Waiting for first frame" : "No capture"}</span>
    </div>
  );
}

/** "LIVE · 2s ago" from the displayed frame's capturedAt. */
function FrameAge({ capturedAt }: { capturedAt: number }) {
  const now = useNow(1000, true, capturedAt);
  const age = Math.max(0, now - capturedAt);
  const stale = age > STALE_FRAME_MS;
  return (
    <span className={cx(styles.badge, stale && styles.badgeStale)} title={stale ? "The capture is behind" : "Latest capture"}>
      <span className={styles.badgeDot} aria-hidden="true" />
      <span className={styles.badgeLive}>Live</span>
      <span className="num">· {frameAgeLabel(age)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Double-buffered loader
// ---------------------------------------------------------------------------

type Loader = { alive: boolean; busy: boolean; lastSeq: number; abort: AbortController | null };

function useBufferedFrame(raceId: string, racerId: string, frame: FrameInfo | null): Shown | null {
  const [shown, setShown] = useState<Shown | null>(null);
  const wanted = useRef<FrameInfo | null>(null);
  const loader = useRef<Loader>({ alive: true, busy: false, lastSeq: Number.NEGATIVE_INFINITY, abort: null });

  useEffect(() => {
    const state = loader.current;
    state.alive = true;
    return () => {
      state.alive = false;
      state.abort?.abort();
      state.abort = null;
      state.busy = false;
    };
  }, []);

  const seq = frame?.seq ?? null;
  const capturedAt = frame?.capturedAt ?? null;

  useEffect(() => {
    wanted.current = seq === null || capturedAt === null ? null : { seq, capturedAt, contentType: "" };
    const state = loader.current;

    const pump = () => {
      const target = wanted.current;
      if (!state.alive || state.busy || !target || target.seq <= state.lastSeq) return;
      state.busy = true;
      const abort = new AbortController();
      state.abort = abort;
      loadFrame(fightFrameUrl(raceId, racerId, target.seq), abort.signal)
        .then((src) => {
          if (!state.alive || abort.signal.aborted) {
            URL.revokeObjectURL(src);
            return;
          }
          state.lastSeq = target.seq;
          setShown({ src, seq: target.seq, capturedAt: target.capturedAt });
        })
        .catch(() => {
          // Missing or broken frame: skip it; the next seq bump retries.
          if (!abort.signal.aborted) state.lastSeq = Math.max(state.lastSeq, target.seq);
        })
        .finally(() => {
          if (state.abort !== abort) return; // superseded by a remount
          state.busy = false;
          state.abort = null;
          pump();
        });
    };

    pump();
  }, [raceId, racerId, seq, capturedAt]);

  // Release the previous object URL once the next one is on screen, and the last on unmount.
  const src = shown?.src;
  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [src]);

  return shown;
}

/** Fetches a frame and decodes it off-screen. Resolves with an object URL. */
async function loadFrame(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Frame request failed (${response.status})`);
  const blob = await response.blob();
  const src = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
  } catch {
    // Some formats (e.g. certain SVGs) refuse decode() but still render.
  }
  if (signal.aborted) {
    URL.revokeObjectURL(src);
    throw new DOMException("Aborted", "AbortError");
  }
  return src;
}
