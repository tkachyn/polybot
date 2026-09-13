/**
 * The fight intro, over the whole featured card as its fight is about to
 * start; the API holds the agents until it has played (../fight/introVideo).
 * The video loads, hidden, up to FIGHT_INTRO_PRIME_MS ahead, plays so it
 * ends FIGHT_INTRO_MARGIN_MS before the start (joining part-way in when the
 * card opens late), then fades away to the card's market, now live.
 */
import { useEffect, useRef, useState } from "react";
import type { FightStatus } from "@contract";
import { Button } from "../../components";
import { cx } from "../../lib/cx";
import { serverNow } from "../../state/clock";
import { introOpensIn, introStartOffset } from "../fight/fightIntroState";
import { FIGHT_INTRO_MARGIN_MS, FIGHT_INTRO_PRIME_MS, fightIntroSrc } from "../fight/introVideo";
import styles from "./FeaturedIntro.module.css";

/** Forward only: idle → primed (loading, hidden) → playing → fading → done. */
type Stage = "idle" | "primed" | "playing" | "fading" | "done";
const ORDER: Readonly<Record<Stage, number>> = { idle: 0, primed: 1, playing: 2, fading: 3, done: 4 };

/** The layer's fade, as in FeaturedIntro.module.css. */
const FADE_MS = 500;

/** Where a card that mounts now starts: inside the lead-in it plays at once, so the market never shows first. */
function stageAt(opensIn: number | null): Stage {
  if (opensIn === null) return "idle";
  if (opensIn === 0) return "playing";
  return opensIn <= FIGHT_INTRO_PRIME_MS ? "primed" : "idle";
}

export type FeaturedIntroProps = {
  status: FightStatus;
  /** The fight's start (server time); null until it is known. */
  startsAt: number | null;
};

/** Key it by fight: each fight gets its own intro. */
export function FeaturedIntro({ status, startsAt }: FeaturedIntroProps) {
  const [stage, setStage] = useState<Stage>(() => stageAt(introOpensIn({ status, startsAt }, serverNow())));
  const advance = (to: Stage) => setStage((current) => (ORDER[current] < ORDER[to] ? to : current));

  useEffect(() => {
    const opensIn = introOpensIn({ status, startsAt }, serverNow());
    if (opensIn === null) return undefined;
    const timers = [
      setTimeout(() => advance("primed"), Math.max(0, opensIn - FIGHT_INTRO_PRIME_MS)),
      setTimeout(() => advance("playing"), opensIn),
    ];
    return () => timers.forEach(clearTimeout);
  }, [status, startsAt]);

  useEffect(() => {
    if (stage !== "fading") return undefined;
    const timer = setTimeout(() => advance("done"), FADE_MS);
    return () => clearTimeout(timer);
  }, [stage]);

  if (startsAt === null || stage === "idle" || stage === "done") return null;
  return (
    <IntroLayer
      stage={stage}
      endsAt={startsAt - FIGHT_INTRO_MARGIN_MS}
      onEnd={() => advance("fading")}
      onUnavailable={() => advance("done")}
    />
  );
}

type IntroLayerProps = {
  stage: "primed" | "playing" | "fading";
  /** When the video should end (server time). */
  endsAt: number;
  onEnd: () => void;
  onUnavailable: () => void;
};

function IntroLayer({ stage, endsAt, onEnd, onUnavailable }: IntroLayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Read as the layer mounts, so it picks up the preloaded copy once that has arrived.
  const [src] = useState(fightIntroSrc);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);

  // When it is time and the video knows its length: seek so it ends at `endsAt`, and play,
  // with sound when the browser allows it, else muted with a Sound on button.
  useEffect(() => {
    const video = videoRef.current;
    if (stage !== "playing" || !loaded || !video) return;
    video.currentTime = introStartOffset(endsAt, serverNow(), video.duration);
    video.muted = false;
    video
      .play()
      .catch(() => {
        video.muted = true;
        setMuted(true);
        return video.play();
      })
      .catch(onUnavailable);
  }, [stage, loaded, endsAt]);

  const unmute = () => {
    const video = videoRef.current;
    if (video) video.muted = false;
    setMuted(false);
  };

  const skip = () => {
    videoRef.current?.pause();
    onEnd();
  };

  // Shown only once it is actually playing, so the card never shows a blank or the seek.
  const shown = stage === "playing" && playing;
  return (
    <div className={cx(styles.layer, shown && styles.shown)} aria-hidden={shown ? undefined : true}>
      <video
        ref={videoRef}
        className={styles.video}
        src={src}
        playsInline
        preload="auto"
        aria-label="Fight intro"
        onLoadedMetadata={() => setLoaded(true)}
        onPlaying={() => setPlaying(true)}
        onEnded={onEnd}
        onError={onUnavailable}
      />
      {shown && (
        <div className={styles.controls}>
          {muted && (
            <Button variant="ghost" size="sm" onClick={unmute}>
              Sound on
            </Button>
          )}
          <Button variant="subtle" size="sm" onClick={skip}>
            Skip intro
          </Button>
        </div>
      )}
    </div>
  );
}
