# Fight intro video

Place the final video beside this file with the exact name:

`fight-intro.mp4`

The resulting path must be `web/public/fight-intro.mp4`. Run `npm run demo` or
`npm run web:build` after adding or replacing it so Vite copies it into the
production bundle.

Recommended export: MP4, H.264 video, AAC audio, 1080p, 30 fps, 8 to 12 seconds.

The app downloads the video in the background as soon as it loads and plays it
from memory. The fight screen times it to end `FIGHT_INTRO_MARGIN_MS` (0.5 s)
before a fight starts, from `FIGHT_INTRO_MS` (9.4 s for the current video; both
in `web/src/features/fight/introVideo.ts`). The API holds a new live fight's
start for `FIGHT_INTRO_HOLD_MS` (10 s) after its browsers are ready, so no agent
runs while it plays. A video of another length needs both lengths updated.
