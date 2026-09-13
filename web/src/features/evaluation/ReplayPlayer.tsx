/**
 * Steel session replay (HLS), opened at the moment of a hit.
 *
 * GET /api/fights/:raceId/agents/:racerId/replay.m3u8 serves the playlist for
 * released live sessions when a replay was captured and 404s otherwise. Browsers that play HLS
 * natively (`canPlayType("application/vnd.apple.mpegurl")`, e.g. Safari) use
 * the <video> element directly; the rest load hls.js on demand, as its own
 * chunk. Playback starts at `startAt` seconds; a missing recording, a load
 * failure and an unsupported browser each get their own message.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type Hls from "hls.js";
import { Button, IconAlert } from "../../components";
import { cx } from "../../lib/cx";
import { Dialog } from "./Dialog";
import { formatReplayOffset } from "./format";
import { IconPlay } from "./icons";
import styles from "./Replay.module.css";

const HLS_MIME = "application/vnd.apple.mpegurl";

type PlayerStatus = "loading" | "ready" | "not_found" | "error" | "unsupported";

/** After a native playback error, asks the server why: a 404 means there is no recording. */
async function probeReplay(src: string, signal: AbortSignal): Promise<"not_found" | "error"> {
  try {
    const response = await fetch(src, { signal, cache: "no-store" });
    return response.status === 404 ? "not_found" : "error";
  } catch {
    return "error";
  }
}

/** Seeks to `seconds`, kept inside the recording once its duration is known. */
function seekTo(video: HTMLVideoElement, seconds: number): void {
  const duration = video.duration;
  const start = Math.max(0, seconds);
  const target = Number.isFinite(duration) && duration > 0 ? Math.min(start, Math.max(0, duration - 0.25)) : start;
  try {
    video.currentTime = target;
  } catch {
    // Not seekable yet; playback starts from the beginning.
  }
}

export type ReplayPlayerProps = {
  src: string;
  /** Seconds into the recording where the hit happens. */
  startAt: number;
  /** Accessible name for the video. */
  label: string;
};

export function ReplayPlayer({ src, startAt, label }: ReplayPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<PlayerStatus>("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    let cancelled = false;
    let hls: Hls | null = null;
    const controller = new AbortController();
    const native = video.canPlayType(HLS_MIME) !== "";
    setStatus("loading");

    const settle = (next: PlayerStatus) => {
      if (!cancelled) setStatus(next);
    };
    const onLoadedMetadata = () => {
      if (cancelled) return;
      // hls.js seeks through `startPosition`; native playback seeks here.
      if (native) seekTo(video, startAt);
      setStatus("ready");
      // Muted autoplay can still be refused; the controls stay available.
      void video.play().catch(() => undefined);
    };
    const onNativeError = () => {
      void probeReplay(src, controller.signal).then(settle);
    };
    video.addEventListener("loadedmetadata", onLoadedMetadata);

    if (native) {
      video.addEventListener("error", onNativeError);
      video.src = src;
    } else {
      import("hls.js")
        .then(({ default: HlsPlayer }) => {
          if (cancelled) return;
          if (!HlsPlayer.isSupported()) {
            settle("unsupported");
            return;
          }
          const instance = new HlsPlayer({ startPosition: Math.max(0, startAt) });
          hls = instance;
          let recoveries = 0;
          instance.on(HlsPlayer.Events.ERROR, (_event, data) => {
            if (cancelled || !data.fatal) return;
            if (data.type === HlsPlayer.ErrorTypes.MEDIA_ERROR && recoveries < 1) {
              recoveries += 1;
              instance.recoverMediaError();
              return;
            }
            const missing = data.details === HlsPlayer.ErrorDetails.MANIFEST_LOAD_ERROR && data.response?.code === 404;
            instance.destroy();
            if (hls === instance) hls = null;
            settle(missing ? "not_found" : "error");
          });
          instance.loadSource(src);
          instance.attachMedia(video);
        })
        .catch(() => settle("error"));
    }

    return () => {
      cancelled = true;
      controller.abort();
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("error", onNativeError);
      hls?.destroy();
      hls = null;
      if (native) {
        video.removeAttribute("src");
        video.load();
      }
    };
  }, [src, startAt, attempt]);

  const jumpToHit = () => {
    const video = videoRef.current;
    if (!video) return;
    seekTo(video, startAt);
    void video.play().catch(() => undefined);
  };

  const failed = status === "not_found" || status === "error" || status === "unsupported";

  return (
    <div className={styles.player}>
      <div className={styles.stage}>
        <video ref={videoRef} className={cx(styles.video, failed && styles.hidden)} controls muted playsInline preload="metadata" aria-label={label} />
        {status === "loading" && (
          <div className={styles.overlay} role="status">
            <span className={styles.spinner} aria-hidden="true" />
            <span>Loading the replay…</span>
          </div>
        )}
        {status === "not_found" && (
          <PlayerMessage title="No replay for this session">No durable recording was captured for this agent.</PlayerMessage>
        )}
        {status === "unsupported" && (
          <PlayerMessage title="This browser can’t play the replay">HLS video needs native HLS support or Media Source Extensions.</PlayerMessage>
        )}
        {status === "error" && (
          <PlayerMessage
            title="The replay couldn’t be loaded"
            action={
              <Button size="sm" variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </Button>
            }
          >
            The recording may have expired, or the connection dropped.
          </PlayerMessage>
        )}
      </div>
      <div className={styles.controls}>
        <span className={styles.hint}>
          Opens at <span className="num">{formatReplayOffset(startAt)}</span>, the moment of the hit.
        </span>
        <Button size="sm" variant="ghost" icon={<IconPlay size={12} />} onClick={jumpToHit} disabled={status !== "ready"}>
          Back to the hit
        </Button>
      </div>
    </div>
  );
}

function PlayerMessage({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.overlay} role="alert">
      <IconAlert size={18} className={styles.overlayIcon} />
      <p className={styles.overlayTitle}>{title}</p>
      <p>{children}</p>
      {action}
    </div>
  );
}

export type ReplayDialogProps = {
  src: string;
  startAt: number;
  agentName: string;
  stepIndex: number;
  stepLabel: string;
  onClose: () => void;
};

export function ReplayDialog({ src, startAt, agentName, stepIndex, stepLabel, onClose }: ReplayDialogProps) {
  return (
    <Dialog title={`${agentName} · replay of sabotage ${stepIndex}`} subtitle={`${stepLabel} · Steel session recording`} onClose={onClose}>
      <ReplayPlayer src={src} startAt={startAt} label={`${agentName} browser replay`} />
    </Dialog>
  );
}
