/**
 * The fight intro video. main.tsx starts fetching it in the background as
 * soon as the page has loaded, and the intro plays from that in-memory copy,
 * so it starts the moment a fight needs it. Until the download finishes, or
 * if it fails, the intro streams from its URL.
 *
 * It plays over the lobby's featured card as that fight is about to start
 * (features/home/FeaturedIntro). The API holds a new live fight's start for
 * FIGHT_INTRO_HOLD_MS (10 s) after its browsers are ready, room for the
 * whole intro, so no agent runs while it plays.
 */
export const FIGHT_INTRO_URL = "/fight-intro.mp4";

/** The intro's length: web/public/fight-intro.mp4 runs 9.4 s. */
export const FIGHT_INTRO_MS = 9_400;

/**
 * The intro ends this long before its fight starts: the API's once-a-second
 * ticker starts the agents at or just after the start, never while it plays.
 */
export const FIGHT_INTRO_MARGIN_MS = 500;

/** How long before its fight starts the intro begins: its length plus the margin. */
export const FIGHT_INTRO_LEAD_MS = FIGHT_INTRO_MS + FIGHT_INTRO_MARGIN_MS;

/** The video loads, hidden, up to this long before it plays, so it starts on its first frame. */
export const FIGHT_INTRO_PRIME_MS = 5_000;

let objectUrl: string | null = null;
let loading: Promise<void> | null = null;

/** Fetches the intro once; a failed download is tried again on the next call. */
export function preloadFightIntro(): Promise<void> {
  loading ??= fetch(FIGHT_INTRO_URL)
    .then((response) => {
      if (!response.ok) throw new Error(`fight intro: HTTP ${response.status}`);
      return response.blob();
    })
    .then((blob) => {
      objectUrl = URL.createObjectURL(blob);
    })
    .catch(() => {
      loading = null;
    });
  return loading;
}

/** The intro's source: the preloaded copy when it is ready, else the URL. */
export function fightIntroSrc(): string {
  return objectUrl ?? FIGHT_INTRO_URL;
}
