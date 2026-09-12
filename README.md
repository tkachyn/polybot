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
- Anthropic adapters for competitor and master-agent decisions
- Persistent append-only race events
- Virtual prediction-market prices from 0.00 to 1.00
- HTTP endpoints for the separate frontend

## Development

```bash
npm install
npm test
npm run build
npm run smoke:steel
```

The Steel smoke test requires `STEEL_API_KEYS` or `STEEL_API_KEY`. `STEEL_API_KEYS` takes a comma-separated list; new sessions use the current key until Steel rejects it (401/402/403, a credits/quota error, or a 429 rate limit, which benches the key for 60 seconds), then rotate to the next key. Live sessions keep the key that created them. Copy `.env.example` to `.env`, populate the required keys, and load those variables before starting the server.

## API

The production server starts on `127.0.0.1:3001` by default:

```bash
npm run dev
```

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
