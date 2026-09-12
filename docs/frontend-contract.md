# Sabotage Markets: Front-End ↔ Back-End Contract

This document binds the Sabotage Markets UI (`docs/sabotage-markets-handoff.md`) to the race backend (`docs/backend-spec.md`). The shared TypeScript types live in `src/api/dto.ts`. That file is types-only, and both the server presenters and the `web/` client compile against it.

## Resolving differences between the handoff and the backend spec

| Topic | Handoff | Backend spec | Resolution |
| --- | --- | --- | --- |
| Outcomes | YES and NO per agent | Buy/sell one share per racer | Added `side: "yes" \| "no"`. NO on X costs `1 - p(X)` and pays 1 if X does not win. It is priced as a basket: one share of each of the other three racers. |
| Money | $ balance, deposit/withdraw, methods | Virtual credits only, no cash | The UI keeps $ formatting but every amount is a virtual credit. Deposit and withdraw move virtual credits. The only enabled method is `virtual`; other methods are shown as unavailable. |
| Wallet scope | One balance across fights | Balance per market | Added a shared `CreditLedger` injected into every market. Settlements pay directly into the wallet. |
| Sabotage | One sabotage per fight at a named checkpoint, revealed to bettors upfront, armed → fired | One immutable race-wide plan with a tier (basic, intermediate, difficult), fired per racer at the first verified target-opening milestone | The engine's `SabotagePlan` (tier, trigger checkpoint, policy, source) is the source of truth. It is armed once, before the fight goes live: the policy is the fixed `sabotage.policy` (source `operator`), else the master's `armRace` choice (`model`, with a deterministic `fallback`). Its trigger checkpoint is `sabotage.checkpoint`, default 1. It fires independently for each agent whose verified report of that checkpoint also verifies the target opening. The bettor-facing text (`summary`, `detail`) is presentation metadata (`SabotageBrief`) on the fight. |
| Duration | 30-minute cap | 180 s target, 300 s cap | Durations are per race and supplied by the backend (`freezesAt`, `closesAt`). The UI never hard-codes them. |
| Void | Rules undefined | Cap reached → unresolved, credits returned | A voided fight refunds each open position at its average price. The history shows a `refund` entry. |
| Capture | Undecided | Steel viewer URL | Periodic frames. Live mode stores a JPEG screenshot per racer; simulated mode renders SVG frames. The UI polls by `frame.seq`. Viewer URLs are never sent to spectators because Steel viewers can be interactive. |
| Agents | GPT-5.2, Claude Opus 4.6, Gemini 3 Pro, Grok 4.1 | One Anthropic competitor model | Each fight has a per-race roster (`AgentIdentity` × 4). In live mode each racer is driven by its own OpenRouter model from `COMPETITOR_LLM_MODELS`, and its identity reports `provider: "openrouter"` with that model id. Without an operator `agents` roster, each agent's `name` and `key` are derived from the model it runs (e.g. `openai/gpt-5.6-luna` → "GPT-5.6 Luna", key `gpt`), so bettors never see one model under another's name. An operator roster keeps its keys and names. |
| Selling | Not designed | Supported | Sell is available from the Portfolio open-positions table. |

## Modes

- `RACE_MODE=live` (default): uses the existing production factory with Steel, the course verifier and real models. The operator creates fights with `POST /races`.
- `RACE_MODE=simulated`: runs the real `RaceCoordinator`, `RaceEngine`, market, ledger, telemetry and SSE. Only the browser sessions, competitor agents, course verifier and obstacle executor are simulated, using seeded deterministic behaviour. An autopilot keeps the lobby populated with 2 live and 2 upcoming fights, seeds resolved history at boot, and runs bot traders so prices and volume move. `GET /api/meta` reports the mode so the UI can show a SIMULATED badge.

## Operator input: `POST /races` (additive)

The existing fields are unchanged. These optional fields were added and are validated with a 400 on violation:

```ts
{
  title?: string;                // ≤ 90 chars. Default: task, truncated to 90 with "…"
  taskDetail?: string;           // default: task
  successCondition?: string;     // default: "The course verifier confirms the final task state."
  checkpointLabels?: string[];   // length === checkpointCount. Default: "Checkpoint k"
  sabotage?: {                   // requires obstaclesEnabled: true
    checkpoint: number;          // integer in [1, checkpointCount]
    summary: string;             // ≤ 70 chars
    detail?: string;             // ≤ 280 chars
    policy?: DisruptionCommand;  // fixed policy; otherwise the obstacle provider chooses
  };
  agents?: Array<{ key: string; name: string; provider: string; model: string }>; // exactly 4
  startsAt?: number;             // future timestamp → scheduled (upcoming) fight
}
```

If `obstaclesEnabled` is true and `sabotage` is omitted, a default plan is armed at checkpoint 1. Its summary is generated from the armed hazard and capped at 70 chars.

Engine events (`GET /races/:raceId/events`): `sabotage_armed` once before the start, then per racer `sabotage_triggered` followed by `sabotage_applied` or `sabotage_misfired`, and `sabotage_recovered` when an applied sabotage's `durationMs` elapses (`metadata.cause` is `duration` or `manual`). A racer in `recovering` cannot report a checkpoint or finish until then.

The default roster, in racer order, is: `gpt` "GPT-5.2" (openai), `claude` "Claude Opus 4.6" (anthropic), `gemini` "Gemini 3 Pro" (google), `grok` "Grok 4.1" (xai).

## Spectator API (`/api`)

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/meta` | `ServerMeta` |
| GET | `/api/fights?status=` | `FightListResponse`. Sorted live (newest start first), then upcoming (soonest first), then resolved (newest first). |
| GET | `/api/fights/:raceId` | `FightDetailResponse` |
| GET | `/api/fights/:raceId/me?userId=` | `MyFightResponse` |
| GET | `/api/fights/:raceId/agents/:racerId/frame?seq=` | Frame bytes with their stored content type and `Cache-Control: no-store`. 404 if there is no frame. |
| POST | `/api/fights/:raceId/orders` | `OrderRequest` → `OrderResponse` |
| POST | `/api/users` | `EnsureUserRequest` → `AccountResponse`: 201 when created (starting balance credited as a `deposit` entry), 200 when existing. `userId` must match `^[A-Za-z0-9_-]{6,64}$`. |
| GET | `/api/users/:userId` | `AccountResponse` |
| GET | `/api/users/:userId/portfolio` | `PortfolioResponse` |
| POST | `/api/users/:userId/deposit` | `WalletTransferRequest` → `WalletTransferResponse` |
| POST | `/api/users/:userId/withdraw` | `WalletTransferRequest` → `WalletTransferResponse` |
| GET | `/api/leaderboard` | `LeaderboardResponse` (30-day window) |

Errors return `ApiError` (`{ error, code }`):

- 404 `not_found`
- 409 `conflict`
- 400 for `invalid`, `market_closed`, `price_moved`, `insufficient_balance` and `insufficient_position`

Transfer amounts must be finite, greater than 0 and at most 100,000 per request. Withdrawals cannot exceed the available balance.

## Server-sent events

All streams send `retry: 2000` first and a `: ping` comment every 15 s. Each `data:` line is the JSON payload named in the `*StreamEvents` types.

| Stream | Events |
| --- | --- |
| `GET /api/fights/stream` | `fights` on connect, then on any fight change (throttled 500 ms). |
| `GET /api/fights/:raceId/stream` | `snapshot` on connect (includes `priceHistory`); `fight` on any change (throttled 250 ms, trailing); `price` for every appended `PricePoint` (not throttled). A new frame bumps `agents[i].frame.seq` inside `fight`. |
| `GET /api/users/:userId/stream` | `portfolio` on connect, then when the user's balance, positions or position marks change (throttled 500 ms). |

Clients treat `snapshot` as a full replace. They append `price` points whose `t` is newer than the last point.

## Derivations (server-side, deterministic)

- **Fight status:**
  - `raceStatus` `starting` → `upcoming`
  - `running`, `hazards_frozen` or `finishing` → `live`
  - `finished` or `timed_out` → `resolved`
- **Opening price:** YES price at race start, or at creation before start. `change = yes - openingYes`.
- **runStatus:**
  - `bad` if phase is `recovering` (sabotage active), `failed` or `timed_out`.
  - Otherwise `warn` if the last 3 action reports share one signature, or the last 2 reports were errors.
  - Otherwise `run`.
- **Recovery:** a `recovering` racer returns to `running` when the sabotage's `durationMs` elapses (`recoverAt`, applied on the engine tick or before its next report). It cannot clear a checkpoint or finish while recovering. A `recovered` log entry is written.
- **ETA:**
  - Active racer with `c ≥ 1` checkpoints: `(now - startedAt) / c × (N - c)`.
  - `c = N` (awaiting finish): `0`.
  - `c = 0`, or not active: `null`.
- **estimatedResolutionAt:** `now + min(ETA)` over active racers, clamped to `closesAt`. `null` if no ETA exists or the fight is not live.
- **Sabotage state:**
  - `fired` once an application returns `applied: true`.
  - `expired` if not fired and the race froze hazards or ended.
  - `armed` otherwise.
  - A misfire (`applied: false`) logs a `sabotage` entry but leaves the agent unhit.
- **Tier:** `SabotageSummary.tier` is the armed plan's tier (`basic`, `intermediate` or `difficult`); `null` until the plan is armed or while not revealed.
- **Reveal:** when `SHOW_SABOTAGE_UPFRONT=false`, `summary`, `detail`, `hazardType` and `tier` are `null` and `revealed=false` until the fight is `live`.
- **Confidence signals:** deterministic demand adjustments, applied only while the market is `open`. `L` is base liquidity.

  | Event | Effect on the racer's weight |
  | --- | --- |
  | Checkpoint | `+0.35·L` |
  | Sabotage hit | `−0.25·L` |
  | Recovery | `+0.10·L` |
  | Failure | Collapses to the floor |

  Weights are floored at `0.02·L`. Prices are normalised to sum to exactly 1.
- **Price history:**
  - A point is appended on every price change.
  - While live, a heartbeat point is also appended on tick when the last point is ≥ 5 s old.
  - History is capped at 2,000 points; the oldest are dropped.
- **Leaderboard:** resolved, non-void fights with `finishedAt` in the last 30 days, grouped by `agent.key` and ranked by win rate, then fights.
  - Sabotage survival: of the agents hit, the share that later cleared another checkpoint or finished.
  - Backer ROI: `(YES payouts + YES sell proceeds − YES buy cost) / YES buy cost`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `RACE_MODE` | `live` | `live` or `simulated` |
| `PORT` / `HOST` | `3001` / `127.0.0.1` | API listen address |
| `STARTING_BALANCE` | `1000` | Credits granted to new users |
| `SHOW_SABOTAGE_UPFRONT` | `true` | Reveal sabotage before fights open |
| `FIGHT_NUMBER_START` | `1` (simulated: `401`) | First fight number |
| `WEB_DIST` | `web/dist` | Served with SPA fallback when present |
| `COMPETITOR_LLM_MODELS` | — | Live mode: exactly four comma-separated OpenRouter model ids, in racer order |
| `OPENROUTER_API_KEY` | — | Live mode: key for every competitor and master model call |
| `RACE_LLM_BUDGET_USD` | `0.25` | Live mode: shared per-race software spend cap |
| `SIM_SEED` | `sabotage-markets` | Simulated mode RNG seed |
