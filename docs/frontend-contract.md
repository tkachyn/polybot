# Sabotage Markets: Front-End ↔ Back-End Contract

This document binds the Sabotage Markets UI (`docs/sabotage-markets-handoff.md`) to the race backend (`docs/backend-spec.md`). The shared TypeScript types live in `src/api/dto.ts`. That file is types-only, and both the server presenters and the `web/` client compile against it.

## Resolving differences between the handoff and the backend spec

| Topic | Handoff | Backend spec | Resolution |
| --- | --- | --- | --- |
| Outcomes | YES and NO per agent | Buy/sell one share per racer | Added `side: "yes" \| "no"`. NO on X costs `1 - p(X)` and pays 1 if X does not win. It is priced as a basket: one share of each of the other three racers. |
| Money | $ balance, deposit/withdraw, methods | Virtual credits only, no cash | The UI keeps $ formatting but every amount is a virtual credit. Deposit and withdraw move virtual credits. The only enabled method is `virtual`; other methods are shown as unavailable. |
| Wallet scope | One balance across fights | Balance per market | Added a shared `CreditLedger` injected into every market. Settlements pay directly into the wallet. |
| Sabotage | One sabotage per fight at a named checkpoint, revealed to bettors upfront, armed → fired | One immutable plan, fired independently per racer after the racer's verified trigger checkpoint | The engine's `SabotagePlan` is the source of truth. The default plan is a single step at checkpoint 1, and each racer triggers it independently when that racer reaches the checkpoint. Explicit multi-step plans remain supported for future course-specific strategies. |
| Duration | 30-minute cap | 180 s target, 300 s cap | Durations are per race and supplied by the backend (`freezesAt`, `closesAt`). The UI never hard-codes them. |
| Void | Rules undefined | Cap reached → unresolved, credits returned | A voided fight refunds each open position at its average price. The history shows a `refund` entry. |
| Capture | Undecided | Steel viewer URL | Live mode exposes a read-only Steel debug viewer in `agent.browserView` (`interactive=false`, `showControls=false`); the runner injects a pointer-transparent black cursor with a light outline into the course page so its paced movement is captured in live video, periodic screenshots and HLS replay. Click and type telemetry retains the browser pointer position for diagnostics. Simulated mode and viewer failures use periodic frames. The UI must keep the frame path as a fallback and must not reset the viewer iframe while polling. |
| Agents | GPT Luna 5.6, Qwen3.8 27B, Gemma 3 27B IT, Claude Sonnet 4.6 | One model per live racer | Each fight has a per-race roster (`AgentIdentity` × 4). In live mode each racer is driven by its own OpenRouter model from `COMPETITOR_LLM_MODELS`, and its identity reports `provider: "openrouter"` with that model id. Without an operator `agents` roster, each agent's `name` and `key` are derived from the model it runs, so bettors never see one model under another's name. An operator roster keeps its keys and names. |
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

The operator API enables `obstaclesEnabled` by default; pass `false` to opt out. If sabotage is enabled and `sabotage` is omitted, one single-step plan is armed at checkpoint 1 (or the final checkpoint for a one-checkpoint course). Its summary is generated from the armed hazard and capped at 70 chars.

Engine events (`GET /races/:raceId/events`): `sabotage_armed` once before the start, then independently for each racer after that racer reports verified checkpoint 1: `checkpoint_reached`, `sabotage_triggered`, followed by `sabotage_applied` or `sabotage_misfired`, and `sabotage_recovered` when the agent actively clears an applied sabotage (`metadata.cause` is `manual`; `duration` is retained only for legacy history). A racer in `recovering` cannot report a checkpoint or finish until then. Completion is verifier-backed after every browser action, including browser-action errors; an explicit model `finish` remains a fallback.

The default roster, in racer order, is: `gpt` "GPT-5.2" (openai), `claude` "Claude Opus 4.6" (anthropic), `gemini` "Gemini 3 Pro" (google), `grok` "Grok 4.1" (xai).

## Spectator API (`/api`)

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/meta` | `ServerMeta` |
| GET | `/api/fights?status=` | `FightListResponse`. Sorted live (newest start first), then upcoming (soonest first), then resolved (newest first). |
| GET | `/api/fights/:raceId` | `FightDetailResponse` |
| GET | `/api/fights/:raceId/me?userId=` | `MyFightResponse` |
| GET | `/api/fights/:raceId/agents/:racerId/frame?seq=` | Frame bytes with their stored content type and `Cache-Control: no-store`. 404 if there is no frame. |
| POST | `/api/browser-sessions` | Operator-only `{ url }` → creates one backend-owned Steel browser session and returns read-only `viewerUrl` metadata. |
| GET | `/api/browser-sessions/:sessionId` | Operator-only browser session status, current page URL/title and read-only viewer metadata. |
| POST | `/api/browser-sessions/:sessionId/navigate` | Operator-only `{ url }` → navigates the backend-owned session to a validated HTTP(S) URL. |
| DELETE | `/api/browser-sessions/:sessionId` | Operator-only release; closes Playwright and releases the Steel session. |
| POST | `/api/fights/:raceId/orders` | `OrderRequest` → `OrderResponse` |
| POST | `/api/users` | `EnsureUserRequest` → `AccountResponse`: 201 when created (starting balance credited as a `deposit` entry), 200 when existing. `userId` must match `^[A-Za-z0-9_-]{6,64}$`. |
| GET | `/api/users/:userId` | `AccountResponse` |
| GET | `/api/users/:userId/portfolio` | `PortfolioResponse` |
| POST | `/api/users/:userId/deposit` | `WalletTransferRequest` → `WalletTransferResponse` |
| POST | `/api/users/:userId/withdraw` | `WalletTransferRequest` → `WalletTransferResponse` |
| GET | `/api/leaderboard` | `LeaderboardResponse` (30-day window) |

Each `FightAgentDetail` includes:

```ts
browserView: {
  status: "pending" | "live" | "released" | "unavailable";
  viewerUrl: string | null;
}
```

When `status` is `live`, render `viewerUrl` in a read-only iframe. The backend
already adds `interactive=false&showControls=false`; the frontend must also
set `pointer-events: none` and keep the iframe `src` stable during SSE updates.
Use the existing frame endpoint when the status is not `live`.

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
  - `recovering` if phase is `recovering` (sabotage active).
  - `bad` if phase is `failed` or `timed_out`.
  - Otherwise `warn` if the last 3 action reports share one signature, or the last 2 reports were errors.
  - Otherwise `run`.
- **Recovery:** a `recovering` racer returns to `running` only after the agent actively clears the sabotage or the race ends. `durationMs` is policy metadata, not an automatic recovery deadline. It cannot clear a checkpoint or finish while recovering. A `recovered` log entry is written.
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
  | Verified completion | `+0.50·L` |
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

## Evaluation

Every fight produces an evaluation: how well each agent did the task, and how it reacted to each sabotage hit. It is provisional while the fight is live and final once the fight resolves. Final evaluations are persisted (`EVALUATION_FILE`, default `data/evaluations.jsonl` in live mode; in memory in simulated mode) and feed the robustness matrix and the dataset export. Simulated evaluations carry `mode: "simulated"`: they describe scripted agents, not real models, and the UI labels them.

### Endpoints

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/fights/:raceId/evaluation` | `FightEvaluationResponse`. 404 `not_found` for an unknown fight. |
| GET | `/api/fights/:raceId/agents/:racerId/evidence/:key` | Keyframe bytes (`EvidenceFrame.key`), `Cache-Control: private, max-age=3600`. |
| GET | `/api/fights/:raceId/agents/:racerId/replay.m3u8` | Live Steel sessions only: the session's HLS playlist, proxied with the key that created it. Segment URLs inside are pre-signed Steel storage URLs. 404 when there is no replay. |
| GET | `/api/evaluations/matrix?days=30&mode=` | `RobustnessMatrixResponse`. `mode` is `live`, `simulated` or `all`; default: the server's mode. |
| GET | `/api/datasets/export.zip?days=&mode=` | The training dataset as `application/zip`, attachment `sabotage-markets-dataset-YYYY-MM-DD.zip`. It contains `manifest.json` (`DatasetManifest`); `episodes.jsonl` (`DatasetEpisode`), `steps.jsonl` (`DatasetStep`), `sft.jsonl` (`DatasetSftExample`) and `preferences.jsonl` (`DatasetPreference`); `assets/<raceId>/<racerId>/step-NNNN.<ext>` screenshots; and `steel/<raceId>/<racerId>.trace.json` raw Steel traces. Rules: [docs/training-data.md](training-data.md). |
| GET | `/api/datasets/manifest.json?days=&mode=` | `DatasetManifest` for the same window and mode. |
| GET | `/api/datasets/{episodes\|steps\|sft\|preferences}.jsonl?days=&mode=` | One dataset file as `application/x-ndjson`. `days` is 1–365 (default 30); `mode` is `live`, `simulated` or `all` (default: the server's mode). |

`FightDetail.evaluation` (`{ status, updatedAt }`) rides on the fight stream. Clients refetch the evaluation when `updatedAt` changes.

### Browser evidence

The runner reads ground truth around every action and reports it as `AgentActionReport.evidence`; it is never shown to the model:

- `target`: the element the action resolved to (its `data-arena-role`, visible label, and whether it carries `data-arena-decoy="true"`).
- `blockedBy`: the browser error classified as `modal` (another element intercepts the click), `disabled`, `hidden`, `missing` (no matching element) or `timeout`.
- `navigated`: the URL changed.

The competitor action tool also supports a bounded same-page `evaluate` action while an arena disruption is active, for DOM inspection or recovery. Its script is capped at 2,000 characters and rejects network, navigation, storage and secret-oriented capabilities. Arena-injected obstacles expose `window.__arenaRecoverDisruptions?.()` as a recovery helper; agents must actively clear persistent sabotage rather than wait for it to expire. The runner rejects `wait` while a disruption is active.

After every action the runner calls `syncProgress()` (the coordinator records each checkpoint the course already verified, in order) and then `checkFinish()`. When an action clears the active sabotage, the runner reports manual recovery before the next progress attempt. Progress therefore comes from the course's ground truth, not from the model remembering to report it. Course-state reads retry bounded transient transport/server failures, while hard authorization or run-proof failures remain errors; duplicate checkpoint observations are idempotent.

OpenRouter competitor calls use a shared sliding window only for configured models. The default `openai/gpt-5.6-luna` limit is 20 tool calls per 60 seconds; other models are unlimited unless configured. A paused racer emits a visible note when capacity opens and then resumes automatically. Malformed tool JSON is repaired once and otherwise becomes a safe `inspect` turn instead of terminating the racer.

In live mode the coordinator also stores Steel Agent Traces (`GET /v1/sessions/:id/agent-traces`): Steel's own record of each click, input and navigation, with the target's role, accessible name, text, `id` and CSS selector. A click whose target `id` starts with `arena-decoy-` counts as a decoy click. The live action log additionally carries the pointer position used by the runner for diagnostics; the visible cursor itself is injected into the course page so it remains present in Steel recordings.

Steel publishes a released session's traces, and sometimes its recording, seconds to minutes late, and returns an unpublished trace as empty. An empty trace is read again within the closing budget. Anything still missing when the evaluation becomes final is read again in the background about 15 s, 45 s, 2 min and 5 min later. Newer evidence updates the final evaluation's `steel` fields and what derives from them (a decoy click seen by Steel, `replayOffsetSec`), and the fight's dataset record. The evaluation stays `final`, and `FightDetail.evaluation.updatedAt` moves, so an open report refetches it.

Keyframes: when a sabotage hits, the racer's latest frame is kept as `before`, and the first frame captured at least 1.5 s later as `after`.

### Rules

Definitions, per agent:

- **Progress events:** race start, each verified checkpoint, and the verified finish.
- **Normal pace:** the median gap between consecutive progress events whose interval contains no sabotage hit. Falls back to the fight-wide median across agents, then to 30 s.
- **Hit:** a `sabotage_applied` event for the agent at time `t0`.
- **Progressed at:** the agent's first verified checkpoint or finish after `t0`.
- **Window:** from `t0` to `progressedAt`, or to the agent's end (finish, failure, timeout, or the fight closing) when it never progressed.
- **Deceived:** a runner step in the window with `target.decoy`, or a Steel click in the window on a decoy.
- `delay = progressedAt - t0`; `timeLost = max(0, delay - pace)`.

Reaction label, first rule that matches:

1. Never progressed: `cut_short` if another agent won and `closeAt - t0 < 2 × pace`; otherwise `derailed`.
2. `deceived` if it clicked a decoy in the window.
3. `immune` if `timeLost ≤ 0.25 × pace` and there were no errors in the window.
4. `stalled` if `delay ≥ 3 × pace`.
5. Otherwise `recovered`.

Score per hit:

| Label | Score |
| --- | --- |
| `immune` | 100 |
| `recovered` | `100 − min(50, 50 × timeLost / (2 × pace)) − min(25, 10 × errorsInWindow)`, floored at 0 |
| `deceived` | the recovered formula − 25, floored at 10 |
| `stalled` | 25 |
| `derailed` | 0 |
| `cut_short` | not scored |

An agent's `robustness` is the mean of its scored hits, or `null` if it was never hit. Task success is reported separately as `outcome` and `success`:

- `won`: the verified winner.
- `finished`: a verified finish, but not first.
- `failed`: the agent's runner crashed or gave up.
- `timed_out`: the safety cap was reached.
- `stopped`: the fight ended, because another agent won, while this agent was still running.

### Sabotage that affects a DOM-driven agent

Competitors act on semantic hooks (`data-arena-role`), so every hazard changes what those hooks resolve to, not just how the page looks. Hazards persist until the agent uses a visible recovery control, navigates past the disrupted page, or invokes the bounded same-page DOM recovery action. `durationMs` remains policy metadata and evaluation context; it is not an automatic clear timer.

| Hazard | Effect |
| --- | --- |
| `insert_decoy` | A clone with the same role, `data-arena-decoy="true"`, `id="arena-decoy-…"` and a different plausible label, inserted just before the target. Clicking it does nothing. An agent must read labels (the optional `label` field on click and type decisions) to avoid it. |
| `blocking_modal` | A persistent full-page overlay that intercepts clicks and has no visible dismissal control. The agent must use bounded same-page DOM recovery, including `window.__arenaRecoverDisruptions?.()`. Waiting is not a recovery action. |
| `temporary_disable` | The target gets `disabled` and `aria-disabled="true"`. |
| `move_primary_action` | The target is hidden behind a "More options" disclosure (`data-arena-role="more-actions"`); clicking the disclosure reveals it. |
| `rename_control` | The target's label changes ("Unavailable", "Not now" or "Cancel", by intensity); its role does not. |

Every page of a course marks its main call to action `data-arena-role="primary-action"`, so any preset can fire at any checkpoint.
