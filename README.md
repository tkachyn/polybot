# Sabotage Markets

Prediction markets on four autonomous browser agents racing to finish a real web task while a master agent sabotages them. This repository holds the race backend, the spectator API and (in `web/`) the front end.

Backend features:

- Four independent racer state machines with a readiness barrier and a simultaneous start
- Semantic checkpoint progression with per-racer idempotency
- Races remain active until a verified winner or an explicit runner/startup failure
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

### Phone demo over Cloudflare Tunnel

The audience demo uses virtual credits only. Start the application in one
terminal and the tunnel in another:

```bash
npm run demo
npm run demo:tunnel
```

Open the `https://...trycloudflare.com` URL printed by `cloudflared`, navigate
to the live fight, and select **Invite judges**. The QR code is generated from
that public origin. Do not display a QR generated from `localhost`, because a
phone resolves `localhost` to itself.

Before showing the QR, run `npm run demo:check`. It verifies that `cloudflared`
is installed, the production web build exists, and the local server health
endpoint responds. Keep both terminal processes running for the whole demo.

Quick tunnels use a temporary public hostname. For a rehearsed event, create a
named Cloudflare Tunnel and bind it to a hostname you control so the URL can be
printed in advance. Venue Wi-Fi must allow outbound HTTPS and Server-Sent
Events. Test the final URL from one iPhone and one Android device on the actual
network before judges arrive.

Demo-day checklist:

1. Run `npm run build:all` and the full test suite before leaving the development network.
2. Start `npm run demo`, then confirm `npm run demo:check` returns `"ok":true`.
3. Start `npm run demo:tunnel` and open its HTTPS URL on the presentation laptop.
4. Open a fight and use **Invite judges** from that public page. The dialog must show the HTTPS QR, not the localhost warning.
5. Scan once from iOS and once from Android over the same network the judges will use.
6. Place one test bet from each phone and confirm both names appear in **Judge standings**.
7. Restart both phones' browsers, confirm their balances remain, then leave the server and tunnel running.

## Modes

- **`RACE_MODE=live`** (default) uses Steel sessions, Playwright over CDP, the course verifier and OpenRouter models. The operator creates fights with `POST /races`. Copy `.env.example` to `.env` and populate `OPENROUTER_API_KEY` plus either `STEEL_API_KEYS` or `STEEL_API_KEY`; the server loads `.env` automatically.
- **`RACE_MODE=simulated`** runs the real coordinator, engine, market, ledger, telemetry and SSE. Only browser sessions, competitor agents, the course verifier and the obstacle executor are simulated, deterministically from `SIM_SEED`. An autopilot keeps the lobby populated, seeds resolved history at boot and runs bot traders. `GET /api/meta` reports the mode. No keys are needed.

### Live mode models

`COMPETITOR_LLM_MODELS` holds exactly four comma-separated OpenRouter model ids, one per racer in order. Each fight agent keeps its `key` and `name`; its identity reports `provider: "openrouter"` and that model id. The default roster in `.env.example` is:

```text
racer-1: openai/gpt-5.6-luna
racer-2: qwen/qwen3.8-27b
racer-3: google/gemma-3-27b-it
racer-4: anthropic/claude-haiku-4.5
```

`RACE_LLM_BUDGET_USD` (default `100`) is a software stop for one race's model calls, split so that one agent's spending can stop only itself: the master gets 10% and each racer an equal part of the rest ($22.50 at the default). A racer whose share runs out stops; the others race on. `GET /races/:raceId` reports the race's total spend as `llmUsage` and the per-racer models as `competitors`. Keep a separate hard credit limit on the OpenRouter API key because a few concurrent in-flight calls can finish after a software limit is reached.

Expected spend, estimated from recorded prompts (about 1,700–2,200 input and 100 output tokens a step) at OpenRouter's prices: about $0.0026 a step for Claude Haiku 4.5, $0.008 for Claude Sonnet 4.6, $0.0005–0.001 for GPT-5.6 Luna, $0.0007–0.0017 for Qwen3.8 27B and $0.0002–0.0004 for Gemma 3 27B or DeepSeek V4.1 Flash. The master makes one call before the start; course races never reach its judge. A typical fight with the recent roster (Luna, Haiku, Gemma, DeepSeek) costs $0.05–0.15, mostly Haiku. The 40-step cap remains the primary practical bound on racer spending; the $100 software budget is intentionally high enough not to interrupt demo recovery.

Competitor calls retry transient provider failures: a rate limit (429), a 408 or
5xx response, or a dropped or timed-out connection. Each retry waits at least the
provider's `Retry-After` or rate-limit reset time, and otherwise backs off from
1 s, with at most 30 s of back-off before the provider answers again. Auth and
credit errors and a spent budget get no paced retry: they count as ordinary
decision failures, and three in a row end the racer. A reply without the required
tool call is asked for once more with `tool_choice: "required"`; if it still has
none, the racer inspects the page that turn instead of stopping.
`OPENROUTER_MODEL_MAX_CALLS_PER_MINUTE` (default `20`) and
`OPENROUTER_MODEL_RATE_WINDOW_MS` (default `60000`) are applied independently to
every configured model, `MASTER_LLM_MODEL` included, so the master shares its
model's window with any racer on the same model. The master never queues for a
slot: it takes one only when it is free, holds at most a quarter of a window it
shares with a racer, and sends each request once. Without a slot its call fails
at once and the caller falls back (a seed-derived sabotage plan). `COMPETITOR_LLM_MAX_OUTPUT_TOKENS` (default `512`) gives
reasoning models enough room to produce the required browser-action tool call. A
provider retry or rate-limit pause does not consume a browser action; the live log
reports it as a model-provider pause. `COMPETITOR_MAX_ACTIONS` (default `40`)
caps each racer's browser actions: winning shop runs took 13–30 steps, while a
racer stuck in sabotage recovery once took 77. Spectators see the cap from the
start, and a racer that reaches it stops.

`STEEL_API_KEYS` accepts a comma-separated list. New sessions rotate to the next key when Steel rejects the current key for authentication, credits, quota or rate limits. Live sessions retain the key that created them. Steel still closes a session when its provider timeout passes; this is independent of the race lifecycle.

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
| `DEMO_MODE` | `false` | Lock equal bankrolls, block wallet transfers and enable QR judge onboarding |
| `SHOW_SABOTAGE_UPFRONT` | `true` | Reveal sabotage text before fights open |
| `FIGHT_NUMBER_START` | `1` (simulated: `401`) | First fight number |
| `WEB_DIST` | `web/dist` | Built SPA, served with an SPA fallback when the directory exists |
| `SIM_SEED` | `sabotage-markets` | Simulated mode RNG seed |
| `SIM_TIME_SCALE` | `1` | Simulated mode speed multiplier |
| `STEEL_API_KEYS` / `STEEL_API_KEY` | none | Live mode: Steel keys (comma-separated list, or a single fallback key) |
| `OPENROUTER_API_KEY` | none | Live mode: key for all competitor and master model calls |
| `OPENROUTER_APP_URL` / `OPENROUTER_APP_NAME` | `http://localhost:3001` / `Browser Agent Arena` | OpenRouter attribution headers |
| `COMPETITOR_LLM_MODELS` | none | Live mode: four comma-separated OpenRouter model ids |
| `OPENROUTER_MODEL_MAX_CALLS_PER_MINUTE` | `20` | Per-model request window, shared by the racers and the master |
| `OPENROUTER_MODEL_RATE_WINDOW_MS` | `60000` | Duration of the per-model request window |
| `COMPETITOR_LLM_MAX_OUTPUT_TOKENS` | `512` | Competitor tool-call output budget |
| `COMPETITOR_MAX_ACTIONS` | `40` | Live mode: browser actions per racer before it is stopped |
| `MASTER_LLM_MODEL` | none | Live mode: OpenRouter model for the sabotage director (needed when `obstaclesEnabled`) |
| `RACE_LLM_BUDGET_USD` | `100` | Live mode: per-race LLM spend cap, shared out 10% to the master and equally to the racers |
| `COURSE_BASE_URL` / `COURSE_VERIFIER_TOKEN` | none | Live mode: course verifier endpoint and token |
| `RACE_EVENT_FILE` | `data/race-events.jsonl` | Live mode: append-only event log |
| `EVALUATION_FILE` | `data/evaluations.jsonl` (live) | Final fight evaluations, appended as JSON lines (in memory in simulated mode unless set) |
| `DATASET_DIR` | `data/dataset` (live) | Per-fight training records, step screenshots and raw Steel traces for the dataset export (in memory in simulated mode unless set) |
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
GET /api/datasets/export.zip?days=30&mode=…             the training dataset (see Dataset export)
```

To produce a real evaluation, run a race on the [shop course](#shop-course) with obstacles enabled.

## Dataset export

Every finished fight is recorded as training data for future web agents. The record covers all four agents, failures included:

- What each agent saw at every step: page text, controls, screenshot.
- Its exact tool call and its one-sentence reasoning.
- The verified result: blocked, decoy, cleared sabotage, progress.
- The sabotage in effect.
- Steel's own record of clicks, typing (field, length and timing, never the characters), keys and page loads.

```text
GET /api/datasets/export.zip?days=30&mode=live                  manifest, JSON Lines files, screenshots, raw Steel traces
GET /api/datasets/manifest.json?days=30&mode=live
GET /api/datasets/{episodes|steps|sft|preferences}.jsonl?days=30&mode=live
```

| File | One row is | Use |
| --- | --- | --- |
| `steps.jsonl` | One step of one agent: what it saw, what it did, why, and what happened | The core training record |
| `episodes.jsonl` | One agent in one fight: outcome, robustness, reactions | Filtering and evaluation |
| `sft.jsonl` | A chat-format example from a good step of a successful run | Supervised fine-tuning |
| `preferences.jsonl` | A chosen/rejected pair of actions at a sabotage | Preference training (DPO) |

Text typed into password fields is redacted everywhere. Simulated rows are scripted agents, not real models, so use `mode=live` for training. The full schema and derivation rules are in [docs/training-data.md](docs/training-data.md).

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

`POST /races` accepts the original fields plus the optional `title`, `taskDetail`, `successCondition`, `checkpointLabels`, `sabotage`, `agents` and `startsAt` (see the contract). A future `startsAt` creates an upcoming fight: it is armed and tradable immediately, and the ticker starts it once it is due. Otherwise the fight creates four sessions, prepares all four agents, passes the readiness barrier and starts. Obstacles are enabled by default; pass `obstaclesEnabled: false` to opt out.

Live fight responses include `agents[].browserView.viewerUrl` when a Steel
session is available. It is read-only (`interactive=false`) and intended for
an iframe; simulated fights and viewer failures use the existing frame
endpoint. Browser-session routes own creation, navigation and release on the
backend. They are unauthenticated in this development server and must be
protected by application authentication before public deployment.

When `obstaclesEnabled` is `true`, one immutable race-wide single-step sabotage plan (tier, trigger checkpoint and policy) is armed before the race starts: the fixed `sabotage.policy` when given, otherwise the master's `armRace` choice, with a deterministic fallback. The trigger is `sabotage.checkpoint`, default 1. Each racer independently triggers that same plan when its own verified report of the trigger checkpoint also verifies the target opening; racers are not synchronized. A racer cannot report further progress until its recovery (`recoverAt`) elapses. Repeated reports are idempotent.

## Timing

There is no elapsed-time hazard, market, or race freeze. The first verified finisher
wins; a fight closes only when a racer wins or the coordinator explicitly aborts it
after startup or runner failure.
