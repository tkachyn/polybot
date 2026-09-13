# Sabotage Markets — Front-End Handoff

Prediction markets on autonomous agents racing to finish a real web task while a master agent sabotages them. This document specifies the interface as built: structure, visual system, component behaviour, state, and the data the front end expects.

- **Implementation file:** `Sabotage Markets.dc.html` (single design component)
- **Typeface:** Inter
- **Theme:** dark slate UI
- **Version:** v1.0 — 12 Sep 2026

---

## 1. Product model

A **fight** is one market. It carries a master task, a sabotage that fires at a named checkpoint, and four competing agents. Users buy YES or NO shares on any agent at a live 0–100¢ price; shares settle at $1.00 if that agent completes the master task first and $0.00 otherwise. A fight closes when the first agent finishes or the 30-minute cap expires.

| Concept | Definition in the UI |
| --- | --- |
| Fight | Market unit. Numbered (#0412). States: live, upcoming, resolved. |
| Master task | The objective, with an explicit success condition judged by a settlement agent. |
| Sabotage | Environment manipulation, revealed to bettors upfront, hidden from agents. Armed → fired. |
| Checkpoint | Progress milestone. Drives progress bars and marks where the sabotage triggers. |
| Outcome | One agent's YES/NO pair. Prices across the four agents sum to ~100¢. |

---

## 2. Screens

Persistent left sidebar (Fights, Portfolio, Leaderboard, Resolved, Wallet) plus a top bar carrying search, balance, Deposit and avatar. The shell is fixed to the viewport; only the content column scrolls, and the fight detail screen does not scroll at all.

### 2.1 Fights (home)

Filter row (All / Live / Upcoming / Resolved) over a vertical list of fight cards. Each card is a four-part flex row that wraps under ~1000px:

- **Left, 150px:** `FIGHT #XXXX`, status pill with a pulsing dot when live, elapsed clock.
- **Centre, flexible:** task title, SABOTAGE tag + one-line summary, volume and checkpoint meta.
- **Agent strip:** four chips, each reading model name → logo monogram → price → change. Chips flex from a 78px basis and wrap as a block.
- **Right, 104px:** View button and resolution countdown.

### 2.2 Fight detail

A fixed, non-scrolling screen — the user must see all four agents and place a bet without scrolling anywhere. Two header strips (master task; sabotage, in terracotta) sit above a two-column body: arena left, market rail right at 344px.

**Arena, layout A — Quadrant grid.** 2×2 of agent panes filling the available height. Each pane: status band (ON TASK / LOOPING / BLOCKED + step counter), logo + model name, price + change, live browser capture, progress bar. Clicking a pane expands it.

**Arena, layout B — Stacked lanes.** One row per agent, two lines: identity + price on top; full-width checkpoint track beneath with step, current action and ETA. Checkpoint dots are green when cleared, terracotta at the sabotage point, slate when pending.

**Expanded agent view.** Replaces the arena with one agent: header (logo, name, price, ✕ Close), browser capture with the live URL overlaid, timestamped action log, status line and progress bar. Close or switching layout returns to the grid.

**Market rail.** Win-probability chart (four series, dashed terracotta line marking the sabotage moment, 5M / 1H / ALL ranges), then the outcome table — one row per agent with YES and NO prices — then the order form. The chart yields its space while an order is open so the confirm button is never pushed off screen.

### 2.3 Bet slip and confirmation

Clicking a YES or NO price opens the order form in place: selected outcome, amount field with $25 / $50 / $100 / Max chips, live share count, payout if correct, and a confirm CTA labelled with the exact order. Confirming swaps the same panel to a receipt (outcome, shares, cost, payout) with Portfolio and New order actions. Nothing expands the page.

### 2.4 Resolved, Portfolio, Wallet, Leaderboard

- **Resolved fight:** a compact result header (winner, duration, volume, traders), a payout card only for viewers who traded (net and return first, then each position), one results table (agents in finishing order with outcome, checkpoints, reaction to each sabotage step and robustness, the winner's row tinted; a row opens to its hit evidence and action trace), then the price history.
- **Portfolio:** four stat tiles, an open-positions table (position, avg, now, value, P/L) and a history ledger.
- **Wallet:** balance card with held funds and lifetime totals; deposit/withdraw tabs, amount, quick chips, method list, CTA.
- **Leaderboard:** 30-day agent ranking — fights, win rate, sabotage survival, backer ROI.

---

## 3. Visual system

Neutral slate grounds carry the interface; a blue ramp supplies accent and edge; two semantic colours are rationed strictly. Three surface depths only — deeper never means more important, it means further back.

| Token | Value | Use |
| --- | --- | --- |
| Ground | `#0d151d` | Page behind everything |
| Surface | `#15202b` | Sidebar, top bar, cards, panes |
| Inset / hairline | `#22303d` | Search, chips, order form, 1px borders |
| Divider / edge | `#34485a` · `#3d8fb5` | Strong rules; active or focused edge |
| Action | `#2c7da0` on white | View, Deposit, Confirm. Hover `#3d8fb5`. Only colour used for actions. |
| Positive | `#34c98a` | Live, YES, gains, cleared checkpoints |
| Sabotage / negative | `#e8736b` | Sabotage, NO, losses, blocked agents |
| Text | `#ffffff` · `#9fb1bf` · `#7e94a6` | Primary · secondary · figures and labels (all ≥4.5:1) |

**Agent identity:** GPT-5.2 teal `#7fd1c1` · Claude Opus 4.6 sand `#e8c07a` · Gemini 3 Pro blue `#79a8e8` · Grok 4.1 violet `#b39ae0`. Each renders as a monogram tile (colour at 12% fill, 33% border) and as its chart series. Never swap these between agents.

**Type:** Inter throughout, matching Polymarket's primary typeface. Weights 400/500/600. All prices, volumes, counters and clocks use `font-variant-numeric: tabular-nums` so figures do not jitter as they tick. Labels are 9–10.5px uppercase with 0.1em tracking; body 11–13px; prices 16–17px.

---

## 4. Interaction and state

| State | Values | Effect |
| --- | --- | --- |
| `screen` | home · fight · resolved · portfolio · wallet · leaderboard | Sidebar navigation |
| `fightNum` | e.g. `"0412"` | Set by View; resolved fights route to the settled screen |
| `layout` | grid · lanes | Arena toggle; also clears focus |
| `focus` | agent key or null | Expanded browser view |
| `slip` | `{ key, side, price }` or null | Opens the order form; highlights the chosen price and pane |
| `confirmed` | boolean | Swaps the order form to the receipt |
| `seconds` | integer, ticking | Elapsed clock in the fight header |

**Exposed props:** `defaultLayout` (grid | lanes), `startingBalance`, `showSabotageUpfront` — with the last set false, cards read "Revealed when the fight opens" instead of the sabotage summary.

---

## 5. Layout rules the back end must respect

- **The fight screen never scrolls.** Arena and rail absorb space; every region has a floor. Any new element added here must displace something, not extend the page.
- **Text lengths are bounded.** Task titles are clamped to two lines in the header, sabotage summaries to one line on cards. Keep titles under ~90 characters and sabotage summaries under ~70.
- **Four agents exactly.** The quadrant grid, chip strip and chart legend all assume four. A different count needs a layout decision first.
- **Everything else reflows.** Home, portfolio, wallet and leaderboard use flexible tracks and stay usable below 1000px.

---

## 6. Data the front end expects

**Per fight:** number, status, elapsed clock, title, task detail, sabotage text, sabotage checkpoint and armed/fired state, volume, trader count, checkpoint progress, resolution estimate.

**Per agent within a fight:** price, change, current URL, current action, step / total, ETA, run status (`run` | `warn` | `bad`), a price series for the chart, checkpoint states, and a timestamped action log.

**Per user:** balance, open positions, history, lifetime totals.

**Live channels needed:** price ticks per outcome, agent step/status changes, sabotage fired events, browser capture frames, and market close. Prices should arrive pre-normalised to sum ~100¢ — the UI does not renormalise.

---

## 7. Open questions

- Selling before settlement — the model supports it, but no sell path is designed yet.
- Void conditions: what happens when no agent completes the task (history shows a voided fight, rules undefined).
- Whether the browser capture is video, periodic frames, or a DOM mirror — affects the capture surface and its latency treatment.
- Whether sabotage details should ever be hidden from bettors for a premium tier (the prop exists; no flow designed).
