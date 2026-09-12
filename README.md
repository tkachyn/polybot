# Sabotage Markets

Prediction markets on four autonomous browser agents racing to finish a real web task while a master agent sabotages them. This repository holds the race backend, the spectator API and (in `web/`) the front end.

Backend features:

- Four independent racer state machines with a readiness barrier and a simultaneous start
- Semantic checkpoint progression with per-racer idempotency
- A target duration (hazards and trading freeze) and an absolute safety cap (void and refund)
- One immutable race-wide sabotage plan (basic, intermediate or difficult tier), armed before the fight opens and fired independently at each racer's verified trigger checkpoint (default checkpoint 1)
- Deterministic fallback sabotage and local course/verifier tests without live keys
- Virtual YES/NO prediction markets over a shared virtual-credit wallet
- Per-agent telemetry: action log, run status, ETA and browser frames
- Read-only Steel live browser viewers with frame fallbacks
- A spectator JSON API with server-sent events
- OpenRouter adapters with one model per racer and a shared per-race LLM budget
- Anthropic adapters retained for direct-provider experiments
- Steel API key rotation across several keys
- Persistent append-only race events

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

# Live backend on :3001 plus the deterministic test course on :4000
npm run dev:all
```

Other scripts:

| Script | What it does |
| --- | --- |
| `npm test` | Backend tests (`node:test`) |
| `npm run build` | Backend type-check and build to `dist/` |
| `npm run build:all` | Backend build, then `web` build |
| `npm run web:test` | Front-end tests |
| `npm run dev` | Backend in `RACE_MODE` (default `live`) |
| `npm run dev:course` | Only the deterministic test course (`COURSE_PORT`, default 4000) |
| `npm run dev:all` | Live backend and the test course together |
| `npm run smoke:steel` | Steel smoke test (needs `STEEL_API_KEYS` or `STEEL_API_KEY`) |

`npm test` and `npm run build` use fakes and the deterministic local course; they do not require Steel or OpenRouter credentials. The live Steel path is exercised only by `npm run smoke:steel`.

## Modes

- **`RACE_MODE=live`** (default) uses Steel sessions, Playwright over CDP, the course verifier and OpenRouter models. The operator creates fights with `POST /races`. Copy `.env.example` to `.env` and populate `OPENROUTER_API_KEY` plus either `STEEL_API_KEYS` or `STEEL_API_KEY`; the server loads `.env` automatically.
- **`RACE_MODE=simulated`** runs the real coordinator, engine, market, ledger, telemetry and SSE. Only browser sessions, competitor agents, the course verifier and the obstacle executor are simulated, deterministically from `SIM_SEED`. An autopilot keeps the lobby populated, seeds resolved history at boot and runs bot traders. `GET /api/meta` reports the mode. No keys are needed.

### Live mode models

`COMPETITOR_LLM_MODELS` holds exactly four comma-separated OpenRouter model ids, one per racer in order. Each fight agent keeps its `key` and `name`; its identity reports `provider: "openrouter"` and that model id. The default roster in `.env.example` is:

```text
racer-1: openai/gpt-5.6-luna
racer-2: anthropic/claude-haiku-4.5
racer-3: google/gemma-3-27b-it
racer-4: deepseek/deepseek-v4.1-flash
```

`RACE_LLM_BUDGET_USD` is a shared software stop for all model calls in one race; `GET /races/:raceId` reports it as `llmUsage` and the per-racer models as `competitors`. Keep a separate hard credit limit on the OpenRouter API key because a few concurrent in-flight calls can finish after the software limit is reached.

`STEEL_API_KEYS` accepts a comma-separated list. New sessions rotate to the next key when Steel rejects the current key for authentication, credits, quota or rate limits. Live sessions retain the key that created them.

### Local course

`npm run dev:all` starts the arena API on port 3001 and the deterministic test course on port 4000. Open a specific course run at:

```text
http://127.0.0.1:4000/?raceId=demo&racerId=racer-1&courseId=course-1&checkpointCount=3
```

Steel sessions run remotely and cannot access your machine's localhost. A live Steel race must use a public deployment or tunnel URL for `startUrl`; the local backend can continue using `COURSE_BASE_URL=http://127.0.0.1:4000` for verification. When `COURSE_VERIFIER_TOKEN` is set, the course server requires the matching Bearer token on server-to-server arena-state verification requests; the browser course UI remains usable without exposing that secret.

## Shop course

`courseId=arena-shop` is a realistic storefront served by the same course app (`npm run dev:course` or `npm run dev:all`): Voltmart, a small electronics store with a header, department nav, promo banner, footer, product cards and a working cart. From the run seed it generates eight portable SSD listings. Exactly one satisfies the task, for example "Buy the cheapest new 1 TB portable SSD under $90 with standard shipping". The rest are near misses: a cheaper refurbished drive, a cheaper drive of the wrong capacity, a drive a few dollars over budget, a pricier drive that qualifies, a premium drive, and two larger drives, one of them on sale under budget. Results use a seeded "Featured" order, never price order.

| Page | Path | Hooks (`data-arena-role`) |
| --- | --- | --- |
| Home | `/?courseId=arena-shop&…` | `search-input`, `primary-action` (Search), `product-link` (trending) |
| Search results | `/shop/search?q=` | `search-input`, `primary-action` (Search), `product-link` |
| Product | `/shop/product?sku=` | `primary-action` (Add to cart) |
| Cart | `/shop/cart` | `remove-item`, `primary-action` (Checkout) |
| Checkout | `/shop/checkout` | `shipping-name`, `shipping-address`, `shipping-method`, `primary-action` (Place order) |
| Confirmation | `/shop/order?order=` | `primary-action` (Continue shopping) |

Every link and form carries the run identity (`raceId`, `racerId`, `courseId`, `seed`, `steelSessionId`, `checkpointCount`), so an agent only clicks and types. Changes are POST forms that redirect with a 303. Pages are plain server-rendered HTML with inline CSS: no scripts and no external assets.

Checkpoints complete strictly in order and are stored in the same course state as the test course, so `/arena/state` and the deterministic verifier are unchanged:

1. **Product found**: opening the correct product's page. This also sets `targetOpened`, the milestone that arms sabotage. Other products do nothing.
2. **Added to cart**: the cart holds exactly one unit of the correct product. It is evaluated on every add and remove.
3. **Shipping details**: a checkout with a non-empty name and address, Standard shipping and that cart. It then sets `finished` and shows an order number. Express shipping or a missing field re-renders checkout with an error. The store accepts any other valid order, but it completes nothing.

Standard shipping is preselected because the runner's `type` action cannot drive a native `<select>`. For `arena-shop`, `POST /arena/checkpoint` and `POST /arena/finish` are rejected: progress comes only from the store's own pages. The run must use `checkpointCount=3`. The seeded catalogue and task are exported from `src/course/shop-course.ts` (`shopTaskForSeed`, `shopCatalogueForSeed`, `shopCorrectProductId`). Try it locally at `http://127.0.0.1:4000/?courseId=arena-shop&raceId=demo&racerId=racer-1&seed=demo&checkpointCount=3`.

**Running a live race.** Steel browsers run in the cloud, so the course server must be publicly reachable, for example through a tunnel:

```bash
npm run dev:all                                  # live API on :3001, course on :4000
cloudflared tunnel --url http://127.0.0.1:4000   # or: ngrok http 4000
```

Set `COURSE_BASE_URL` in `.env` to the tunnel's public URL before you start the API. The verifier also reads `/arena/state` through it, and both URLs must reach the same course process. Then create the fight:

```bash
SEED=demo npm run race:shop    # SEED is optional; API_URL defaults to http://127.0.0.1:3001
```

The script sends `POST /races` with `courseId: "arena-shop"`, three checkpoints, `obstaclesEnabled: true`, the title, task, detail, success condition and checkpoint labels from `shopTaskForSeed`, and `startUrl: ${COURSE_BASE_URL}/?courseId=arena-shop`. The runner appends the run parameters. The script then prints the answer key and the fight URL, `http://localhost:5173/fights/<raceId>` (start the UI with `npm run web:dev`). It warns when `COURSE_BASE_URL` is a local address, and it prints the status and error when the API rejects the request. The live API needs `STEEL_API_KEYS`, `OPENROUTER_API_KEY`, `COMPETITOR_LLM_MODELS` and `MASTER_LLM_MODEL`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `RACE_MODE` | `live` | `live` or `simulated` |
| `PORT` / `HOST` | `3001` / `127.0.0.1` | API listen address |
| `COURSE_PORT` / `COURSE_HOST` | `4000` / `127.0.0.1` | Test course listen address (`dev:course`, `dev:all`) |
| `STARTING_BALANCE` | `1000` | Credits granted to new users |
| `SHOW_SABOTAGE_UPFRONT` | `true` | Reveal sabotage text before fights open |
| `FIGHT_NUMBER_START` | `1` (simulated: `401`) | First fight number |
| `WEB_DIST` | `web/dist` | Built SPA, served with an SPA fallback when the directory exists |
| `SIM_SEED` | `sabotage-markets` | Simulated mode RNG seed |
| `SIM_TIME_SCALE` | `1` | Simulated mode speed multiplier |
| `STEEL_API_KEYS` / `STEEL_API_KEY` | none | Live mode: Steel keys (comma-separated list, or a single fallback key) |
| `OPENROUTER_API_KEY` | none | Live mode: key for all competitor and master model calls |
| `OPENROUTER_APP_URL` / `OPENROUTER_APP_NAME` | `http://localhost:3001` / `Browser Agent Arena` | OpenRouter attribution headers |
| `COMPETITOR_LLM_MODELS` | none | Live mode: four comma-separated OpenRouter model ids |
| `MASTER_LLM_MODEL` | none | Live mode: OpenRouter model for the sabotage director (needed when `obstaclesEnabled`) |
| `COMPETITOR_MAX_ACTIONS` | `20` | Live mode: action cap per racer |
| `RACE_LLM_BUDGET_USD` | `0.25` | Live mode: shared per-race LLM spend cap |
| `COURSE_BASE_URL` / `COURSE_VERIFIER_TOKEN` | none | Live mode: course verifier endpoint and token |
| `RACE_EVENT_FILE` | `data/race-events.jsonl` | Live mode: append-only event log |
| `EVALUATION_FILE` | `data/evaluations.jsonl` (live) | Final fight evaluations, appended as JSON lines (in memory in simulated mode unless set) |
| `VITE_API_TARGET` | `http://127.0.0.1:3001` | Web dev server: where `/api` is proxied |
| `VITE_DEFAULT_LAYOUT` | `grid` | Web: default arena layout (`grid` or `lanes`) |

All of these are listed with their defaults in `.env.example`.

`SIGINT` and `SIGTERM` close the server gracefully: open event streams are ended and every race is shut down.

## Spectator API

Every JSON response carries `serverTime` (epoch ms). Errors are `{ error, code }`: 404 `not_found`, 409 `conflict`, 400 for `invalid`, `market_closed`, `price_moved`, `insufficient_balance` and `insufficient_position`.

```text
GET  /api/meta
GET  /api/fights?status=live|upcoming|resolved
GET  /api/fights/:raceId
GET  /api/fights/:raceId/me?userId=
GET  /api/fights/:raceId/agents/:racerId/frame?seq=   raw image, Cache-Control: no-store
POST /api/browser-sessions                            operator browser create
GET  /api/browser-sessions/:sessionId                 operator browser status/view
POST /api/browser-sessions/:sessionId/navigate        operator browser navigation
DELETE /api/browser-sessions/:sessionId               operator browser release
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

## Evaluation

Every fight produces an evaluation: how each agent did the task, and how it reacted to each sabotage hit. It is provisional while the fight is live and final once the fight resolves.

- **Where to see it:**
  - A resolved fight shows the full report: findings, each agent's outcome and robustness, a sabotage timeline with reaction labels, before/after keyframes, the Steel trace and replay for live runs, and the full action trace.
  - The **Evaluations** page shows the robustness matrix (models × sabotage types) and the dataset export.
- **Reaction labels:**

  | Label | Meaning |
  | --- | --- |
  | `immune` | Kept its normal pace, with no errors |
  | `recovered` | Lost time, but made verified progress |
  | `deceived` | Clicked a planted decoy, then progressed |
  | `stalled` | Took at least 3× its normal pace |
  | `derailed` | Never made verified progress again |
  | `cut_short` | The fight ended before it could react; not scored |

  Scores run from 0 to 100, and an agent's robustness is the mean of its scored hits. The exact rules are in [docs/frontend-contract.md](docs/frontend-contract.md#evaluation).
- **Evidence:**
  - The runner records what the browser actually did around every action: the element it hit, whether that was a decoy, and what blocked it.
  - Progress comes from the course's own verification, not from the model's claims.
  - For live runs, the coordinator also stores Steel's Agent Traces and links the session recording at each sabotage moment.
- **Simulated data:** with `RACE_MODE=simulated` the agents are scripted. Their evaluations are labelled simulated and should not be read as real model behaviour.

```text
GET /api/fights/:raceId/evaluation
GET /api/fights/:raceId/agents/:racerId/evidence/:key
GET /api/fights/:raceId/agents/:racerId/replay.m3u8      live Steel sessions only
GET /api/evaluations/matrix?days=30&mode=live|simulated|all
GET /api/evaluations/export.jsonl?days=30&mode=…         one row per agent per fight
```

To produce a real evaluation, run a race on the [shop course](#shop-course) with obstacles enabled.

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

Live fight responses include `agents[].browserView.viewerUrl` when a Steel
session is available. It is read-only (`interactive=false`) and intended for
an iframe; simulated fights and viewer failures use the existing frame
endpoint. Browser-session routes own creation, navigation and release on the
backend. They are unauthenticated in this development server and must be
protected by application authentication before public deployment.

When `obstaclesEnabled` is `true`, one immutable race-wide sabotage plan (tier, trigger checkpoint and policy) is armed before the race starts: the fixed `sabotage.policy` when given, otherwise the master's `armRace` choice, with a deterministic fallback. The trigger is `sabotage.checkpoint`, default 1. Each racer independently triggers that same plan when its verified report of the trigger checkpoint also verifies the target opening, and cannot report further progress until its recovery (`recoverAt`) elapses. Repeated reports are idempotent.

## Timing

At the target duration the coordinator freezes new obstacles and trading, but active racers continue; the first subsequently verified finisher wins. At the absolute cap an unfinished fight is voided and every open position is refunded at its average price.
