import { useEffect, useRef, useState } from "react";
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

export function FightIntro({ fightNumber, endsAt, onClose, onUnavailable }: FightIntroProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
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
      <video
        ref={videoRef}
        className={styles.video}
        src={src}
        playsInline
        preload="auto"
        onLoadedMetadata={() => void start()}
        onEnded={onClose}
        onError={onUnavailable}
      />
      <div className={styles.topline}>
        <span className={styles.kicker}>Fight intro</span>
        <span className={styles.fightNumber}>Fight #{String(fightNumber).padStart(4, "0")}</span>
      </div>
      {muted && (
        <button type="button" className={styles.sound} onClick={unmute}>
          Sound on
        </button>
      )}
      <button type="button" className={styles.skip} onClick={onClose}>
        Skip intro
      </button>
    </div>
  );
}
