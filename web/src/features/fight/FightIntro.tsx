import { useEffect, useRef, useState } from "react";
import { Button } from "../../components";
import { cx } from "../../lib/cx";
import { formatFightNumber } from "../../lib/format";
import { serverNow } from "../../state/clock";
import { introStartOffset } from "./fightIntroState";
import { fightIntroSrc } from "./introVideo";
import styles from "./FightIntro.module.css";

type FightIntroProps = {
  fightNumber: number;
  /** When the intro should end (server time), just before its fight starts: it seeks to end then. Null plays it from the top (a replay). */
  endsAt: number | null;
  onClose: () => void;
  onUnavailable: () => void;
};

/**
 * The intro as a large framed video over the darkened fight screen. The
 * video stays hidden until it is actually playing, so the frame never shows
 * a blank or the jump to where it starts.
 */
export function FightIntro({ fightNumber, endsAt, onClose, onUnavailable }: FightIntroProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Fixed when the intro opens: a new source mid-play would restart it.
  const [src] = useState(fightIntroSrc);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Plays on time whatever the browser allows: with sound when it may, else
  // muted with a Sound on button, never waiting on a tap.
  const start = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (endsAt !== null) video.currentTime = introStartOffset(endsAt, serverNow(), video.duration);
    try {
      video.muted = false;
      await video.play();
    } catch {
      video.muted = true;
      setMuted(true);
      await video.play().catch(onClose);
    }
  };

  const unmute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    setMuted(false);
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label={`Fight ${fightNumber} intro`}>
      <div className={styles.panel}>
        <div className={styles.frame}>
          <video
            ref={videoRef}
            className={cx(styles.video, playing && styles.playing)}
            src={src}
            playsInline
            preload="auto"
            onLoadedMetadata={() => void start()}
            onPlaying={() => setPlaying(true)}
            onEnded={onClose}
            onError={onUnavailable}
          />
        </div>
        <div className={styles.bar}>
          <span className={styles.kicker}>Fight intro</span>
          <span className={cx("num", styles.fightNumber)}>Fight {formatFightNumber(fightNumber)}</span>
          <span className={styles.actions}>
            {muted && (
              <Button variant="ghost" size="sm" onClick={unmute}>
                Sound on
              </Button>
            )}
            <Button variant="subtle" size="sm" onClick={onClose}>
              Skip intro
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}
