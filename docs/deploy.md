# Deploying: Vercel + Fly.io

Three pieces, three homes:

| Piece | Host | Why there |
| --- | --- | --- |
| `web/` SPA | **Vercel** | Static build. No state, no secrets. |
| API, engine, market, crowd | **Fly app `polybot-api`** | Holds the market in memory, runs the 1s ticker, keeps a CDP socket open per racer for the length of a fight. |
| Course server | **Fly app `polybot-course`** | Steel's cloud browsers load the storefront from it, so it needs its own public hostname. |

The API and the course cannot run on serverless: both keep authoritative state
in memory between requests, and the API does work (ticking, trading) when
nobody is asking it to.

---

## 1. Deploy the course

```bash
fly launch --config fly.course.toml --no-deploy   # answer no to Postgres/Redis
fly deploy --config fly.course.toml
```

Note the hostname it prints, e.g. `https://polybot-course.fly.dev`. Check it:

```bash
curl -s "https://polybot-course.fly.dev/?courseId=arena-shop"
# {"error":"raceId is required"}  ← correct: the page needs a full run identity
```

## 2. Deploy the API

```bash
fly launch --config fly.toml --no-deploy
fly volumes create polybot_data --size 1 --app polybot-api   # keeps events, evaluations, datasets and replays
```

Secrets never go in `fly.toml` — it is committed:

```bash
fly secrets set --app polybot-api \
  STEEL_API_KEY=ste-... \
  STEEL_USE_PROXY=true \
  OPENROUTER_API_KEY=sk-or-... \
  MASTER_LLM_MODEL=openai/gpt-5.6-luna \
  COMPETITOR_LLM_MODELS=openai/gpt-5.6-luna,qwen/qwen3.8-27b,google/gemma-3-27b-it,anthropic/claude-haiku-4.5 \
  COURSE_BASE_URL=https://polybot-course.fly.dev
```

`COURSE_BASE_URL` is the public course app: the API verifies against it and the
racers load from it, so there is one URL for both and no tunnel anywhere.

The checked-in `fly.toml` points `EVALUATION_FILE`, `DATASET_DIR` and
`REPLAY_DIR` at `/data`. Finished Steel HLS playlists and media segments are
copied into `/data/replays` before the fight is published as final, so releasing
the Steel session no longer removes the replay. Finished fights and all four
replays remain available for ten minutes after the round ends, then the live
fight and replay files are cleared. Increase the volume size if you expect many
long fights.

```bash
fly deploy --config fly.toml
curl -s https://polybot-api.fly.dev/api/meta
```

## 3. Deploy the SPA

In Vercel: **Root Directory** `web`, framework Vite (build `npm run build`,
output `dist`). One environment variable:

```
VITE_API_BASE = https://polybot-api.fly.dev
```

It is read at build time and compiled into the bundle, so changing it needs a
redeploy, not just a restart.

## 4. Let the SPA talk to the API

The API answers only the origins you name:

```bash
fly secrets set --app polybot-api \
  CORS_ORIGINS=https://polybot.vercel.app,https://polybot-git-main-you.vercel.app
```

Exact origins, comma-separated, no trailing slash and no wildcard — this API
carries balances and accepts orders, so it must not answer any page that asks.
Add preview domains you actually use.

## 5. Run a fight

```bash
COURSE_BASE_URL=https://polybot-course.fly.dev \
API_URL=https://polybot-api.fly.dev \
npm run race:shop
```

For a judge-only external-site attempt on Amazon, use the same live API
without the course server:

```bash
API_URL=https://polybot-api.fly.dev \
npm run race:amazon
```

The Amazon run uses a random product category unless `AMAZON_QUERY` is set,
stops before order submission, and may stop earlier if Amazon requires
interactive sign-in or presents a CAPTCHA.

---

## Things that will bite

**`HOST` must be `0.0.0.0`.** Both entrypoints default to `127.0.0.1`, which on
Fly means the health check fails and the app never serves. Already set in
`fly.toml` (`HOST`) and `fly.course.toml` (`COURSE_HOST`); don't remove them.

**Never scale past one machine.** `RaceRegistry`, `InMemoryCreditLedger` and
`VirtualPredictionMarket` are in-process maps, and `placeOrder()` mutates them
synchronously. A second machine is a second ledger: the same credits spend
twice and the two machines quote different prices. `auto_stop_machines = false`
and `min_machines_running = 1` are correctness settings, not cost settings.

**Don't proxy `/api` through Vercel.** Point the SPA straight at the API origin
with `VITE_API_BASE`. A rewrite puts Vercel's proxy in front of the SSE
streams, where buffering leaves the lobby frozen on stale prices.

**A restart empties the lobby.** The volume keeps `race-events.jsonl`, but the
registry is rebuilt in memory at boot and nothing replays the log into it. Past
fights disappear from the UI until that replay exists. Decide whether you care
before demo day.

**The image carries no browser.** Steel runs the browsers; we attach over CDP.
If you ever add a local-browser code path it will fail here until the Dockerfile
switches to a Playwright base image.

## Costs

Two `shared-cpu-1x` machines (1GB + 512MB) and a 1GB volume land around
$10–12/month. Vercel's hobby tier covers the SPA. Steel sessions and OpenRouter
calls are billed per fight and dwarf the hosting.
