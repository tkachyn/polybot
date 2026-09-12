# Sabotage Markets — web

Spectator and trading UI for Sabotage Markets. Vite + React 18 + TypeScript
(strict), CSS Modules, react-router v6. Design spec:
`docs/sabotage-markets-handoff.md`. API contract: `docs/frontend-contract.md`
and `src/api/dto.ts` (imported as `@contract`, types only).

```sh
npm --prefix web install
npm --prefix web run dev         # http://localhost:5173, proxies /api -> $VITE_API_TARGET (default http://127.0.0.1:3001)
npm --prefix web run typecheck   # tsc -b
npm --prefix web run test        # vitest run
npm --prefix web run build       # tsc -b && vite build -> web/dist (served by the API server via WEB_DIST)
npm --prefix web run preview
```

Run the backend in simulated mode for a populated lobby: `RACE_MODE=simulated npm run dev` (repo root).

## Structure

```
web/src
  main.tsx              fonts + styles, BrowserRouter, SessionProvider, FightsProvider
  App.tsx               routes (layout route = AppShell)
  app/                  ErrorBoundary, NotFoundPage
  api/client.ts         typed fetch wrappers for every endpoint, ApiFailure, stream URLs
  api/stream.ts         useEventStream (SSE), openEventStream, combineStreamStatus
  state/                session, fights lobby, fight detail, clock, search, resources, media, storage
  lib/                  pure helpers: format, order, agents, labels, cx, id, backoff
  components/           shared primitives (barrel: components/index.ts)
  styles/tokens.css     design tokens (the only place colours are defined)
  styles/global.css     reset, Inter, .num, focus rings, scrollbars, utilities
  features/<screen>/    one folder per screen, owned by one agent each
```

Routes:

| Path | Component |
| --- | --- |
| `/` | `features/home/HomePage` (`HomePage`) |
| `/resolved` | `features/resolved/ResolvedPage` (`ResolvedPage`) |
| `/fights/:raceId` | `features/fight/FightRoute` (`FightRoute`), renders `features/settled/SettledFight` for resolved fights and `features/market/MarketRail` in the rail |
| `/portfolio` | `features/portfolio/PortfolioPage` (`PortfolioPage`) |
| `/wallet` | `features/wallet/WalletPage` (`WalletPage`), `?tab=deposit\|withdraw` |
| `/leaderboard` | `features/leaderboard/LeaderboardPage` (`LeaderboardPage`) |
| `*` | `app/NotFoundPage` |

Feature folders own their files. Keep the exported component names and file
paths above: `App.tsx` imports them. `features/market/types.ts` defines
`Slip` and `MarketRailProps`; the fight screen and the market rail share them.

## Conventions

- **Contract types**: `import type { FightDetail } from "@contract";` Never a value import.
- **Data**: only from the API/SSE through `api/client.ts` and the `state/` hooks. No mock data in shipped code.
- **Colours**: only `var(--color-*)` / `var(--tint-*)` tokens, or agent colours from `lib/agents` (`var(--agent-color)` via `agentStyle`). No hex literals in components.
- **Action colour** (`--color-action`) is used only for actions: `<Button variant="action">`/`<ButtonLink variant="action">`. Links, selection and focus use `--color-edge`.
- **Positive** (`--color-positive`): live, YES, gains, cleared checkpoints. **Sabotage/negative** (`--color-sabotage` / `--color-negative`, same value): sabotage, NO, losses, blocked.
- **Three depths**: ground `--color-ground` → surface `--color-surface` (cards, panes) → inset `--color-inset` (inputs, chips, order form). No fourth.
- **Figures**: every price, amount, counter and clock goes through `lib/format` and renders with tabular numerals (`body` default; add `className="num"` on figures anyway, and all figure components already do).
- **Type**: labels `.label` (10px uppercase 0.1em; `.label-sm` 9px, `.label-lg` 10.5px); body `--fs-body-sm/--fs-body/--fs-body-lg` (11/12/13px); prices `--fs-price`/`--fs-price-lg` (16/17px).
- **Layout**: the shell is fixed; each screen renders exactly one `<Page>`. The fight screen uses `<Page scroll={false}>` and must never scroll: children use `flex: 1; min-height: 0`.
- **Breakpoints** (media queries, CSS vars can't be used there): `max-width: 999px` reflow, `max-width: 759px` compact (icon sidebar). JS: `useMediaQuery(BREAKPOINT_REFLOW | BREAKPOINT_COMPACT)`.
- **Money** is virtual credits shown as dollars.
- **Errors**: catch `ApiFailure`; show `describeError(err)` (or `<ErrorBanner error={err} />`).
- **Time**: use `useNow()` / `serverNow()` (server-corrected), never raw `Date.now()` for countdowns or elapsed clocks.
- **CSS Modules**: `Component.module.css` next to the component; compose class names with `cx()`.

## Tokens (`styles/tokens.css`)

| Token | Value |
| --- | --- |
| `--color-ground` / `--color-surface` / `--color-inset` | `#0d151d` / `#15202b` / `#22303d` |
| `--color-hairline` / `--color-divider` / `--color-edge` (= `--color-focus`) | `#22303d` / `#34485a` / `#3d8fb5` |
| `--color-action` / `--color-action-hover` / `--color-on-action` | `#2c7da0` / `#3d8fb5` / `#ffffff` |
| `--color-positive` / `--color-negative` = `--color-sabotage` | `#34c98a` / `#e8736b` |
| `--color-text` / `--color-text-secondary` / `--color-text-muted` | `#ffffff` / `#9fb1bf` / `#7e94a6` |
| `--color-agent-gpt` / `-claude` / `-gemini` / `-grok` | `#7fd1c1` / `#e8c07a` / `#79a8e8` / `#b39ae0` |
| `--tint-{positive,negative,sabotage,edge}` + `-border` | semantic colour at 12% / 33% |
| `--tint-hover` | hover wash |
| `--fs-label-sm/label/label-lg` | 9 / 10 / 10.5px |
| `--fs-body-sm/body/body-lg` | 11 / 12 / 13px |
| `--fs-price/price-lg/title/display` | 16 / 17 / 17 / 22px |
| `--fw-regular/medium/semibold` | 400 / 500 / 600 |
| `--tracking-label` / `--tracking-tight` | 0.1em / -0.01em |
| `--lh-tight/snug/body` | 1.2 / 1.35 / 1.5 |
| `--space-0-5 … --space-12` | 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32, 40, 48px |
| `--radius-xs/sm/md/lg/xl/pill` | 3 / 4 / 6 / 8 / 12 / 999px |
| `--sidebar-width` / `-collapsed` / `--topbar-height` | 208 / 60 / 52px |
| `--rail-width` / `--card-left-width` / `--card-right-width` / `--chip-basis` | 344 / 150 / 104 / 78px (handoff) |
| `--page-gutter` / `--content-max-width` / `--content-wide-width` | 24px (16px compact) / 1180 / 1440px |
| `--duration-fast/base/slow`, `--ease-standard` | 120 / 180 / 320ms |
| `--shadow-pop`, `--z-sticky/topbar/overlay/toast` | popovers, layering |

Global utilities (`styles/global.css`): `.num`, `.label`, `.label-sm`, `.label-lg`,
`.text-primary`, `.text-secondary`, `.text-muted`, `.text-positive`, `.text-negative`,
`.text-sabotage`, `.depth-ground`, `.depth-surface`, `.depth-inset`, `.truncate`,
`.clamp-1`, `.clamp-2` (titles clamp to 2 lines, sabotage summaries to 1), `.sr-only`, `.skip-link`.

## Data layer

### `api/client.ts`

Every wrapper takes an optional trailing `signal?: AbortSignal`, updates the
server clock from `serverTime`, and throws `ApiFailure` on failure (aborts
rethrow the AbortError; test with `isAbortError`).

| Export | Signature |
| --- | --- |
| `getMeta` | `(signal?) => Promise<ServerMeta>` |
| `listFights` | `(params?: { status?: FightStatus }, signal?) => Promise<FightListResponse>` |
| `getFight` | `(raceId, signal?) => Promise<FightDetailResponse>` |
| `getMyFight` | `(raceId, userId, signal?) => Promise<MyFightResponse>` |
| `fightFrameUrl` | `(raceId, racerId, seq: number) => string` — `<img src>` fallback for `agent.frame.seq` |
| `agent.browserView` | Live fights may provide a read-only Steel `viewerUrl`; render it in a non-interactive iframe and keep the frame fallback for simulated/unavailable sessions. |
| `placeOrder` | `(raceId, order: OrderRequest, signal?) => Promise<OrderResponse>` |
| `ensureUser` | `(body: EnsureUserRequest, signal?) => Promise<AccountResponse>` |
| `getUser` | `(userId, signal?) => Promise<AccountResponse>` |
| `getPortfolio` | `(userId, signal?) => Promise<PortfolioResponse>` |
| `deposit` / `withdraw` | `(userId, body: WalletTransferRequest, signal?) => Promise<WalletTransferResponse>` |
| `getLeaderboard` | `(signal?) => Promise<LeaderboardResponse>` |
| `fightsStreamUrl` / `fightStreamUrl(raceId)` / `userStreamUrl(userId)` | SSE URLs |
| `api` | all of the above as one object |
| `request<T>` | `(path, { method?, body?, query?, signal? }) => Promise<T>` low level |
| `ApiFailure` | `class extends Error { code: ApiFailureCode; status: number; isNetwork }` |
| `ApiFailureCode` | `ApiErrorCode \| "network" \| "server"` |
| `isApiFailure(err, code?)`, `toApiFailure(err)`, `isAbortError(err)`, `failureFromResponse(status, body)` | helpers |
| `describeError(err) => string` | user-facing sentence for any error |
| `API_BASE` | `""` (same origin) |

### `api/stream.ts`

- `useEventStream<E>(url: string | null, handlers: { [K in keyof E]?: (data: E[K]) => void }, options?: { createSource?, reconnectKey?: string | number }): StreamStatus`
  — `E` is one of `FightListStreamEvents`, `FightStreamEvents`, `UserStreamEvents`. Inline handlers are fine (read through a ref). `null` URL = closed. Reconnects with capped backoff if the browser gives up; changing `reconnectKey` reopens immediately.
- `StreamStatus = "connecting" | "open" | "reconnecting" | "closed"`
- `openEventStream({ url, events, onEvent, onStatus?, createSource?, retryBaseMs?, retryMaxMs? }) => close()` (framework-free)
- `combineStreamStatus(statuses: StreamStatus[]): StreamStatus`

### `state/`

| Export | Signature / shape |
| --- | --- |
| `SessionProvider` | `{ children, userId?: string }` (mounted in main.tsx) |
| `useSession()` | `{ userId, meta: ServerMeta \| null, account: Account \| null, portfolio: Portfolio \| null, status: "loading" \| "ready" \| "error", error: ApiFailure \| null, streamStatus, refresh(): Promise<void>, applyAccount(account, serverTime?) }` — call `applyAccount(res.account, res.serverTime)` after orders/transfers. |
| `FightsProvider` | `{ children }` (mounted in main.tsx) |
| `useFights()` | `{ fights: FightSummary[], status: "loading" \| "live" \| "polling" \| "error", error, loaded, streamStatus, serverTime, refresh() }` — server order: live, upcoming, resolved. |
| `useFightSummary(raceId)` | `FightSummary \| null` from the lobby |
| `useFightDetail(raceId)` (`state/fight.ts`) | `{ fight: FightDetail \| null, priceHistory: PricePoint[], status: "loading" \| "live" \| "polling" \| "error" \| "not_found", error, streamStatus, serverTime, refresh() }` — snapshot/fight/price handled, REST fallback, 2000-point cap. |
| `appendPricePoint(history, point, cap?)`, `MAX_PRICE_POINTS` | pure helper |
| `useApiResource(load \| null, deps, { pollMs? })` (`state/resource.ts`) | `{ data, error, loading, reload(), setData() }` for one-off REST (leaderboard, my-fight). |
| `useNow(intervalMs = 1000, enabled = true)` (`state/clock.ts`) | server-corrected ms, shared aligned ticks |
| `serverNow()`, `noteServerTime()`, `getClockOffset()`, `isClockSynced()` | clock |
| `useSearchQuery()` (`state/search.ts`, re-exported by components) | current `?q=` (untrimmed) |
| `useSetSearchQuery()`, `SEARCH_PARAM` ("q"), `HOME_STATUS_PARAM` ("status") | the top bar writes `?q=` on "/"; the home screen owns `?status=` |
| `useMediaQuery(query)`, `BREAKPOINT_REFLOW`, `BREAKPOINT_COMPACT` (`state/media.ts`) | JS media queries |
| `getOrCreateUserId()`, `USER_ID_STORAGE_KEY` ("sm.userId"), `isValidUserId`, `createUserId` (`state/userId.ts`) | user id |
| `readStorage`, `writeStorage`, `removeStorage` (`state/storage.ts`) | safe localStorage |

## `lib/`

**format.ts** — all accept `null`/`undefined`/NaN and return `EMPTY` ("—"). Negatives use `MINUS` (U+2212).

| Export | Example |
| --- | --- |
| `formatCents(p)` / `centsValue(p)` | `0.45 → "45¢"`, `0.004 → "0.4¢"`, `0.996 → "99.6¢"` (one decimal below 1¢ / above 99¢) |
| `formatChangeCents(d)` / `changeTone(d)` | `0.021 → "+2.1¢"`, `-0.03 → "−3¢"`; tone `positive \| negative \| neutral` |
| `formatMoney(a, { decimals?: 0 \| 2 })` | `"$1,234.56"`, `"−$5.00"` |
| `formatSignedMoney(a)` / `moneyTone(a)` | `"+$12.34"`, `"−$5.00"`, `"$0.00"` |
| `formatCompactMoney(a)` | `"$950"`, `"$12.4K"`, `"$1.2M"` (volumes) |
| `formatShares(q, { unit? })` | `"185"`, `"185 shares"` |
| `formatNumber(n)` | `"1,204"` |
| `formatPercent(r, { decimals = 1, signed? })` | `0.123 → "12.3%"`, `"+12.3%"` |
| `formatFightNumber(n)` / `fightNumberDigits(n)` | `"#0412"` / `"0412"` |
| `formatClock(ms)` | `"04:07"`, `"1:02:03"` |
| `formatCountdown(ms)` | `"42s"`, `"4m 07s"`, `"1h 04m"` (rounds up) |
| `formatDuration(ms)` | `"2m 14s"` (rounds down) |
| `formatRelativeTime(at, now)` | `"just now"`, `"32s ago"`, `"in 5m"`, `"Sep 4"` |
| `formatLogTime(at)` | `"14:03:22"` |
| `formatTimeOfDay`, `formatDate`, `formatDateTime`, `isoDuration`, `formatInitials`, `roundTo`, `isFiniteNumber` | misc |

**order.ts** — bet-slip math (`shares = floor(A/p + 1e-9)`, `cost = round6(shares*p)`, `payout = shares`, `profit = payout - cost`).

| Export | Signature |
| --- | --- |
| `quoteOrder({ price, amount, balance })` | `OrderQuote { price, amount, shares, cost, payoutIfCorrect, profit, error: OrderError \| null }` |
| `validateOrder(quote, balance)` | `OrderError { code: "amount" \| "price" \| "shares" \| "balance", message } \| null` |
| `maxAmount(balance)` | the Max chip (= balance) |
| `QUICK_AMOUNTS` | `[25, 50, 100]` |
| `parseAmount(input)` | `"$1,234.50" → 1234.5`, invalid → NaN |
| `buildConfirmLabel({ action?, side, agentName, price, shares, cost })` | `"Buy 185 YES · GPT-5.2 at 27¢ — $49.95"` |
| `sidePrice({ yes, no }, side)`, `round6`, `isTradablePrice`, `minAmountForOneShare` | helpers |

**agents.ts** — identity keyed on `AgentIdentity.key`.

| Export | Signature |
| --- | --- |
| `agentVisual(agent \| key)` | `AgentVisual { key, color, fill (12%), border (33%), monogram, known }` |
| `rosterVisuals(agents)` | visuals for a fight's roster; unknown keys never collide |
| `agentStyle(agent \| visual \| key)` | inline style with `--agent-color`, `--agent-fill`, `--agent-border` |
| `agentColor(key)`, `agentMonogram(key, name?)`, `agentTileFill(color)`, `agentTileBorder(color)`, `withAlpha(hex, a)` | helpers |
| `AGENT_PALETTE`, `KNOWN_AGENT_KEYS`, `FALLBACK_AGENT_COLORS`, `AGENT_FILL_ALPHA`, `AGENT_BORDER_ALPHA` | constants (gpt GP teal, claude CL sand, gemini GE blue, grok GR violet) |

**labels.ts** — `RUN_STATUS_LABEL` (On task / Looping / Blocked), `FIGHT_STATUS_LABEL`,
`SIDE_LABEL`, `SABOTAGE_STATE_LABEL`, `HAZARD_LABEL`, `LEDGER_TYPE_LABEL`,
`SETTLEMENT_RESULT_LABEL`, `ACTION_LOG_KIND_LABEL`, `SABOTAGE_HIDDEN_COPY`
("Revealed when the fight opens"; use when `sabotage.revealed === false`).

**Misc** — `cx(...classes)`, `randomId()`, `newClientOrderId()` (for `OrderRequest.clientOrderId`), `backoffMs(attempt, base?, max?)`.

## Components (`components/index.ts`)

Import from `../../components` in feature folders.

| Component | Props |
| --- | --- |
| `AppShell` | layout route element (renders `<Outlet/>`); sidebar, top bar (search, SIMULATED badge, connection, balance, Deposit, avatar) |
| `Page` | `{ children, scroll?: boolean = true, width?: "default" \| "wide" \| "full", padded?: boolean = true, title?: string, className? }` — `scroll={false}` = full height, no scroll |
| `PageHeader` | `{ title, subtitle?, actions?, className? }` |
| `AgentMonogram` | `{ agent: AgentIdentity \| AgentVisual \| key, size?: "xs" 18 \| "sm" 22 \| "md" 28 \| "lg" 36, className? }` |
| `StatusPill` | `{ status: "live" \| "upcoming" \| "resolved" \| "voided", label?, size?: "sm" \| "md", className? }`; `fightPillStatus(fight)` maps a fight (voided → "voided") |
| `Button` | `ButtonHTMLAttributes & { variant?: "action" \| "ghost" (default) \| "subtle", size?: "sm" \| "md" \| "lg", block?, icon?, iconEnd?, loading? }` |
| `ButtonLink` | router `LinkProps & { variant?, size?, block?, icon?, iconEnd? }` |
| `Tag` | `{ tone?: "sabotage" \| "positive" \| "edge" \| "neutral", solid?, children, title?, className? }`; `SabotageTag` = terracotta "SABOTAGE" |
| `PriceCents` | `{ value: number \| null, size?: "sm" 12 \| "md" 13 \| "lg" 16 (default) \| "xl" 17, tone?: "default" \| "positive" \| "negative" \| "muted" \| "secondary" \| "inherit", flash?: boolean, className? }` |
| `ChangeCents` | `{ value: delta \| null, size? = "sm", className? }` — green/terracotta/muted |
| `Money` | `{ value, size? = "md", tone?, decimals?: 0 \| 2, className? }` |
| `SignedMoney` | `{ value, size?, decimals?, className? }` — toned |
| `SignedPercent` | `{ value: ratio, size?, decimals? = 1, className? }` — toned |
| `ProgressBar` | `{ value: 0..1, color?: string, tone?: "positive" \| "sabotage" \| "edge" \| "muted", markers?: { at: 0..1, tone?: "sabotage" \| "positive" \| "muted", label? }[], size?: "xs" \| "sm" \| "md", label?, className? }` |
| `SegmentedControl<T>` | `{ options: { value: T, label, count?, disabled?, title? }[], value: T, onChange(v: T), "aria-label": string, size?: "sm" \| "md", block?, className? }` |
| `ElapsedClock` | `{ from: ts \| null, until?: ts \| null, className? }` — "04:07", stops at `until` |
| `Countdown` | `{ to: ts \| null, expiredLabel? = "0s", placeholder? = "—", className? }` |
| `RelativeTime` | `{ at: ts \| null, className? }` |
| `EmptyState` | `{ title, description?, action?, icon?, size?: "sm" \| "md", className? }` |
| `ErrorBanner` | `{ error: unknown (null renders nothing), title?, onRetry?, retrying?, onDismiss?, className? }` |
| `Skeleton` | `{ width? = "100%", height? = 12, radius?: "sm" \| "md" \| "lg" \| "pill", className? }`; `SkeletonText { lines? = 3 }` |
| `StatTile` | `{ label, value: ReactNode, sub?, tone?: "default" \| "positive" \| "negative", loading?, className? }` |
| `TableWrap` + `tableStyles` | `TableWrap { children, card? = true, className? }`; classes `table`, `compact`, `num`, `row`, `rowLink`, `rowPositive`, `rowSelected`, `muted`, `strong`, `cellMain` |
| `ConnectionIndicator` | `{ status: StreamStatus, showLabel? = true, className? }` |
| Icons | `IconFights`, `IconPortfolio`, `IconLeaderboard`, `IconResolved`, `IconWallet`, `IconSearch`, `IconClose`, `IconAlert`, `IconChevronRight`, `IconArrowLeft`, `IconExpand`, `IconGrid`, `IconLanes`, `IconRefresh` (`{ size? = 16, title?, ...svg }`), `LogoMark { size? }` |
| `NAV_ITEMS`, `APP_TITLE`, `useSearchQuery` | shell constants / hook |

`app/ErrorBoundary` (`{ children, resetKey?, fallback?(error, reset) }`) wraps every route.

## Example: a fight card price chip

```tsx
import type { FightAgentSummary } from "@contract";
import { AgentMonogram, ChangeCents, PriceCents } from "../../components";

function Chip({ a }: { a: FightAgentSummary }) {
  return (
    <div>
      <span className="label">{a.agent.name}</span>
      <AgentMonogram agent={a.agent} size="sm" />
      <PriceCents value={a.yes} flash />
      <ChangeCents value={a.change} />
    </div>
  );
}
```
