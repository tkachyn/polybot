# Browser Agent Arena Backend

Backend for a four-racer browser-agent race using Steel cloud browser sessions and Playwright over CDP.

- Four independent racer state machines
- Readiness barrier and simultaneous start
- Semantic checkpoint progression
- Per-racer checkpoint idempotency
- Three-minute target duration
- Hazard freeze at the target duration
- Five-minute absolute safety cap
- Deterministic winner selection
- A no-op obstacle provider for obstacle-free development
- OpenRouter adapters with one model per racer and a shared per-race budget
- Anthropic adapters retained for direct-provider experiments
- Persistent append-only race events
- Virtual prediction-market prices from 0.00 to 1.00
- HTTP endpoints for the separate frontend

## Development

```bash
npm install
npm test
npm run build
npm run smoke:steel
npm run dev:all
```

Copy `.env.example` to `.env` and populate `OPENROUTER_API_KEY` plus either
`STEEL_API_KEYS` or `STEEL_API_KEY`. The server loads `.env` automatically.
`STEEL_API_KEYS` accepts a comma-separated list; new sessions rotate to the next
key when Steel rejects the current key for authentication, credits, quota, or
rate limits. Live sessions retain the key that created them. The default model
roster is:

```text
racer-1: openai/gpt-5.6-luna
racer-2: anthropic/claude-haiku-4.5
racer-3: google/gemma-3-27b-it
racer-4: deepseek/deepseek-v4.1-flash
```

`RACE_LLM_BUDGET_USD` is a shared software stop for all model calls in one
race. Keep a separate hard credit limit on the OpenRouter API key because a few
concurrent in-flight calls can finish after the software limit is reached.

## API

The production server starts on `127.0.0.1:3001` by default:

```bash
npm run dev
```

For local development, `npm run dev:all` starts the arena API on port 3001 and
the deterministic test course on port 4000. Open a specific course run at:

```text
http://127.0.0.1:4000/?raceId=demo&racerId=racer-1&courseId=course-1&checkpointCount=3
```

Steel sessions run remotely and cannot access your machine's localhost. A live
Steel race must use a public deployment or tunnel URL for `startUrl`; the local
backend can continue using `COURSE_BASE_URL=http://127.0.0.1:4000` for verification.

Core routes:

```text
POST /races
GET  /races/:raceId
GET  /races/:raceId/events
POST /races/:raceId/checkpoints
POST /races/:raceId/finish
POST /races/:raceId/market/fund
POST /races/:raceId/market/buy
POST /races/:raceId/market/sell
```

`POST /races` creates four Steel sessions, prepares all four competitor agents, passes the readiness barrier, and begins the race. Obstacles remain disabled unless `obstaclesEnabled` is explicitly set to `true`.

## Timing

At three minutes the coordinator freezes new obstacles and prediction-market trading, but active racers continue. The first subsequently verified finisher wins. At five minutes, the race is closed as unresolved if nobody has completed the course.
