# Sabotage Markets

Prediction markets on four autonomous browser agents racing to finish a real web task while a master agent sabotages them. This repository holds the race backend, the spectator API and (in `web/`) the front end.

Backend features:

- Four independent racer state machines with a readiness barrier and a simultaneous start
- Semantic checkpoint progression with per-racer idempotency
- A target duration (hazards and trading freeze) and an absolute safety cap (void and refund)
- One sabotage per fight, armed before the fight opens and fired at a named checkpoint
- Virtual YES/NO prediction markets over a shared virtual-credit wallet
- Per-agent telemetry: action log, run status, ETA and browser frames
- A spectator JSON API with server-sent events

The binding front-end contract is [`docs/frontend-contract.md`](docs/frontend-contract.md). The shared types are in [`src/api/dto.ts`](src/api/dto.ts).

## Running it

```bash
npm install
npm --prefix web install

# Simulated backend on :3001 plus the Vite dev server on :5173 (proxies /api)
npm run dev:sim
npm run web:dev

# Or build the SPA once and serve everything from the simulated backend
npm run demo            # http://127.0.0.1:3001
```

Other scripts:

| Script | What it does |
| --- | --- |
| `npm test` | Backend tests (`node:test`) |
| `npm run build` | Backend type-check and build to `dist/` |
| `npm run build:all` | Backend build, then `web` build |
| `npm run web:test` | Front-end tests |
| `npm run dev` | Backend in `RACE_MODE` (default `live`) |
| `npm run smoke:steel` | Steel smoke test (needs `STEEL_API_KEY`) |

## Modes

- **`RACE_MODE=live`** (default) uses Steel sessions, Playwright over CDP, the course verifier and real models. The operator creates fights with `POST /races`. Copy `.env.example` to `.env`, fill in the keys and load them before starting.
- **`RACE_MODE=simulated`** runs the real coordinator, engine, market, ledger, telemetry and SSE. Only browser sessions, competitor agents, the course verifier and the obstacle executor are simulated, deterministically from `SIM_SEED`. An autopilot keeps the lobby populated, seeds resolved history at boot and runs bot traders. `GET /api/meta` reports the mode.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `RACE_MODE` | `live` | `live` or `simulated` |
| `PORT` / `HOST` | `3001` / `127.0.0.1` | Listen address |
| `STARTING_BALANCE` | `1000` | Credits granted to new users |
| `SHOW_SABOTAGE_UPFRONT` | `true` | Reveal sabotage text before fights open |
| `FIGHT_NUMBER_START` | `1` (simulated: `401`) | First fight number |
| `WEB_DIST` | `web/dist` | Built SPA, served with an SPA fallback when the directory exists |
| `SIM_SEED` | `sabotage-markets` | Simulated mode RNG seed |
| `SIM_TIME_SCALE` | `1` | Simulated mode speed multiplier |
| `RACER_1_MODEL` … `RACER_4_MODEL` | none | Live mode: model per racer (`RACER_n_PROVIDER`, `RACER_n_NAME`, `RACER_n_KEY` override the roster) |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` / `XAI_API_KEY` | none | Keys for OpenAI-compatible providers |

`SIGINT` and `SIGTERM` close the server gracefully: open event streams are ended and every race is shut down.

## Spectator API

Every JSON response carries `serverTime` (epoch ms). Errors are `{ error, code }`: 404 `not_found`, 409 `conflict`, 400 for `invalid`, `market_closed`, `price_moved`, `insufficient_balance` and `insufficient_position`.

```text
GET  /api/meta
GET  /api/fights?status=live|upcoming|resolved
GET  /api/fights/:raceId
GET  /api/fights/:raceId/me?userId=
GET  /api/fights/:raceId/agents/:racerId/frame?seq=   raw image, Cache-Control: no-store
POST /api/fights/:raceId/orders                      OrderRequest → OrderResponse
POST /api/users                                      201 created, 200 existing
GET  /api/users/:userId
GET  /api/users/:userId/portfolio
POST /api/users/:userId/deposit                      { amount, method: "virtual" }
POST /api/users/:userId/withdraw
GET  /api/leaderboard                                30-day window
```

### Server-sent events

Streams start with `retry: 2000` and send a `: ping` comment every 15 s.

| Stream | Events |
| --- | --- |
| `GET /api/fights/stream` | `fights` on connect, then on any fight change (throttled 500 ms) |
| `GET /api/fights/:raceId/stream` | `snapshot` on connect (with `priceHistory`), `fight` on change (trailing, 250 ms), `price` for every new chart point (unthrottled) |
| `GET /api/users/:userId/stream` | `portfolio` on connect, then when that user's balance, positions or marks change (throttled 500 ms) |

Clients treat `snapshot` as a full replace and append `price` points newer than their last one.

## Operator API

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

`POST /races` accepts the original fields plus the optional `title`, `taskDetail`, `successCondition`, `checkpointLabels`, `sabotage`, `agents` and `startsAt` (see the contract). A future `startsAt` creates an upcoming fight: it is armed and tradable immediately, and the ticker starts it once it is due. Otherwise the fight creates four sessions, prepares all four agents, passes the readiness barrier and starts. Obstacles stay disabled unless `obstaclesEnabled` is `true`.

## Timing

At the target duration the coordinator freezes new obstacles and trading, but active racers continue; the first subsequently verified finisher wins. At the absolute cap an unfinished fight is voided and every open position is refunded at its average price.
