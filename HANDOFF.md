# Handoff

Written for the next agent picking this repo up. `CLAUDE.md` describes the
architecture and conventions; this file is the state of play — what changed
recently, what is verified, what is known-broken, and what to do next.

Everything below was checked against the tree at `d39b3f9` unless it says
otherwise.

---

## Where things stand

Nothing is deployed yet. The app runs locally and has driven real fights
against Steel. The deploy configuration exists but has never been applied.

The work of the last session fell into three groups.

**The UI was reworked and the product renamed to PolyBot.** A navbar replaced
the sidebar, the type system moved to Fraunces over Sora on a near-black
palette, agents render with their real vendor logos in vendor colours, and the
lobby became a featured fight plus a right rail (Leaderboard, Upcoming, Past
fights) with an upcoming grid beneath. The separate Leaderboard page is gone;
the rail card is now the whole of the standings.

**Live markets got a crowd.** Before this, a live fight had no traders at all,
so prices only moved when a checkpoint landed and the chart was a flat line
with a step in it. `src/prediction/market-crowd.ts` runs automated traders
against every open market. They are deliberately imperfect — they read the race
late, mix signal with noise, hold per-vendor priors, and some trade against
their own read — because a crowd of perfect forecasters converges once and then
sits still. Orders go through the real market, so prices, volume and the ledger
move as they would for a human. Off with `MARKET_CROWD=false`.

**Deploy config was added** for Vercel (SPA) plus two Fly apps (API, course).
See `docs/deploy.md`. It is unapplied and partly unverified — see below.

---

## Known issues, in rough priority order

**A restart empties the lobby.** The registry is in-memory and nothing replays
the event log into it at boot. `data/race-events.jsonl` keeps the record and the
evaluation store keeps its own, but past fights vanish from the UI on restart.
This bit us mid-session: nine real fights disappeared. Fixing it means replay
on boot, and it is independent of where the log is stored.

**Gemini 3.7 Flash failed in the latest live configuration.** The current
roster uses `anthropic/claude-sonnet-4.6` for racer 4 instead. Validate the
model with a cheap smoke fight before relying on it for a demo.

**The OpenRouter account is rate limited to 20 requests/minute per model.**
This kills racers mid-fight with `429 new-account-rpm`, and it is the real
ceiling on running fights back to back, not anything in this code. It has
killed both GPT and Claude Haiku in different fights.

**The Docker image has never been built.** Docker was unavailable on the
machine where `Dockerfile` was written. It is written against verified facts —
both entrypoints exist at `dist/src/server.js` and `dist/src/course-server.js`,
and `tsconfig.json` compiles `src` *and* `test`, so both are copied in the build
stage — but the first `fly deploy` is its first real test.

**Agent colours have drifted.** `web/src/lib/agents.ts:23` still holds the
pre-redesign palette (`#7fd1c1` teal, `#79a8e8` blue) while
`web/src/styles/tokens.css:45` holds the muted ones (`#8fc7bb`, `#8aa6d4`).
Nothing looks wrong, because chart lines, money flashes and progress rules all
read from `lib/agents.ts` and so agree with each other. But there are two
sources of truth for one palette.

**`CLAUDE.md` is stale in at least one place.** Line 25 says "There is no
frontend in this repo." There is: `web/` is a full Vite + React SPA. Treat the
architecture sections as accurate for `src/` and verify anything it says about
the frontend.

---

## Decisions already taken

Worth knowing before revisiting them.

**The API must run as exactly one always-on process.** `RaceRegistry`,
`InMemoryCreditLedger` and `VirtualPredictionMarket` are in-process maps, and
`RaceCoordinator.placeOrder()` mutates them synchronously. A second instance is
a second ledger: the same credits spend twice and the two instances quote
different prices. This rules out serverless for the API — not for cost reasons,
for correctness. `fly.toml` pins `min_machines_running = 1` with
`auto_stop_machines = false`; those are correctness settings.

**The SPA talks to the API directly, not through a proxy.** `VITE_API_BASE` is
compiled into the bundle and `CORS_ORIGINS` names the exact origins the API
will answer. A Vercel rewrite for `/api/*` would put a buffering proxy in front
of the SSE streams and freeze the lobby on stale prices.

**The course server gets its own public hostname.** Steel's cloud browsers load
the storefront from it. Hosting it publicly removes the cloudflared tunnel and
the hostname-of-the-day ritual entirely.

**QR codes and the phone layout are being dropped.** The owner decided this
after the mobile work landed. `DEMO_MODE`, `DemoJoinDialog`, `FightInvite`,
`JudgeStandingsPage`, the `qrcode` dependency, the phone bottom-nav in
`AppShell.module.css` and the wallet lock all exist to serve it. **This removal
has not been done.** Do it last; it touches working code.

---

## Running it

```bash
npm run check          # backend tests + build
npm --prefix web test  # frontend tests
npm run dev:all        # live API on :3001 + course on :4000
npm run demo           # simulated mode, no keys, no Steel
```

A live fight needs a public course URL, because Steel's browsers cannot reach
your machine:

```bash
cloudflared tunnel --url http://127.0.0.1:4000
COURSE_BASE_URL=https://<tunnel-host> API_URL=http://127.0.0.1:3001 npm run race:shop
```

`COURSE_BASE_URL` is doing two jobs on purpose: the script hands it to Steel as
`startUrl`, while the server's own copy (from `.env`, normally
`http://127.0.0.1:4000`) is used for server-to-server verification. Once the
course is deployed publicly, both become the same URL.

Cheap validation before spending on a fight: `npm run smoke:steel` opens and
releases four real sessions.

A fight that wins takes ~40–100s and costs roughly $0.01–0.08 of OpenRouter
against the `RACE_LLM_BUDGET_USD` soft cap. Four Steel sessions per fight are
the bigger cost. Never `kill -9` the server mid-race — release happens in the
shutdown path, and a hard kill strands paid sessions until Steel reaps them.

---

## What I would do next

1. **Deploy.** `docs/deploy.md` is step by step. The first `fly deploy` also
   validates the Dockerfile.
2. **Replay the event log into the lobby on boot**, or decide deliberately that
   a fresh lobby per restart is fine. Either is defensible; discovering it at a
   demo is not.
3. **Validate Claude Sonnet 4.6** in `COMPETITOR_LLM_MODELS` with a cheap
   smoke fight before demo day.
4. **Keep the runner retry behavior covered.** Malformed provider decisions
   are retried without consuming a browser action.
5. **Remove the QR and demo-mode paths**, per the decision above.

---

## Conventions worth repeating

`CLAUDE.md` has the full set. The two that catch people:

- ESM with NodeNext: every relative import carries a `.js` extension even
  though the source is `.ts`.
- Tests use hand-written fakes against the contracts in
  `src/application/contracts.ts`, not mocks. Keep new I/O behind a contract
  interface so that stays possible.

Secrets never enter the repo. `fly.toml` is committed, so keys go in
`fly secrets set`, not in `[env]`.
