import { useEffect, useRef, useState } from "react";
import { Button } from "../../components";
import styles from "./FightIntro.module.css";

export const FIGHT_INTRO_SRC = "/fight-intro.mp4";

type FightIntroProps = {
  fightNumber: number;
  onClose: () => void;
  onUnavailable: () => void;
};

export function FightIntro({ fightNumber, onClose, onUnavailable }: FightIntroProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [needsGesture, setNeedsGesture] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const attemptPlayback = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      video.muted = false;
      await video.play();
      setNeedsGesture(false);
    } catch {
      setNeedsGesture(true);
    }
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label={`Fight ${fightNumber} intro`}>
      <video
        ref={videoRef}
        className={styles.video}
        src={FIGHT_INTRO_SRC}
        autoPlay
        playsInline
        preload="auto"
        onCanPlay={() => void attemptPlayback()}
        onEnded={onClose}
        onError={onUnavailable}
      />
      <div className={styles.topline}>
        <span className={styles.kicker}>Fight intro</span>
        <span className={styles.fightNumber}>Fight #{String(fightNumber).padStart(4, "0")}</span>
      </div>
      {needsGesture && (
        <div className={styles.playGate}>
          <p className={styles.ready}>Fighters ready?</p>
          <Button variant="action" size="lg" onClick={() => void attemptPlayback()}>
            Play fight intro
          </Button>
          <p className={styles.soundNote}>Tap to play with sound</p>
        </div>
      )}
      <button type="button" className={styles.skip} onClick={onClose}>
        Skip intro
      </button>
    </div>
  );
}
