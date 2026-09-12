# Browser Agent Arena: Backend and Race Logic Specification

## Purpose

Browser Agent Arena runs four AI browser agents through the same task course. Each agent controls an independent Steel cloud browser session. A master LLM acts as the race director: it selects obstacles, while backend code applies those obstacles through CDP to the relevant browser session.

The race is asynchronous. Racers do not wait for one another. When a racer reaches a checkpoint, that racer receives the checkpoint's obstacle and continues after recovering. Other racers keep working in their own sessions.

This document covers backend and race logic only. Frontend and spectator UI are out of scope.

## MVP decisions

- Racers: 4
- Steel sessions: 4, one per racer
- Course duration: 180-second target with a 300-second absolute safety cap
- Obstacle stages: 3 logical stages for the first implementation, with support for 5
- Trigger model: per-agent checkpoint arrival
- Start model: all racers pass a readiness barrier, then start together
- Progress model: semantic checkpoint verification, not tool-call count or page count
- Master behavior: one obstacle policy per stage, reused for every racer who reaches that stage
- Winner: first racer whose final task state passes deterministic verification
- Post-finish behavior: record the first verified winner, freeze the market, stop the remaining racers, and release all Steel sessions

## Relationship to BrowserBrawl

BrowserBrawl uses an attacker agent, a defender that injects JavaScript through CDP, managed cloud browsers, realtime persistence, and structured interaction logs. Browser Agent Arena reuses that broad pattern but changes the game model:

```text
BrowserBrawl:
  one attacker + one defender + one browser

Browser Agent Arena:
  four competitor agents + one master race director + four browsers
```

Reference: https://github.com/RichardHruby/browser-brawl

Steel replaces BrowserBrawl's browser provider. Each Steel session exposes a CDP WebSocket connection and a live session viewer URL. The backend uses the WebSocket connection; the UI, which is out of scope here, may use the viewer URL.

References:

- https://docs.steel.dev/cookbook/playwright
- https://docs.steel.dev/overview/authentication

## System architecture

```text
                         Race Orchestrator
                  start barrier, timers, winner logic
                                  |
                    +-------------+-------------+
                    |                           |
             Checkpoint Router             Master Agent
          per-racer event handling       selects obstacle policy
                    |                           |
                    +-------------+-------------+
                                  |
                         CDP Injection Service
                                  |
              +-------------------+-------------------+
              |                   |                   |
          Steel 1             Steel 2             Steel 3 ... Steel 4
          Agent 1              Agent 2              Agent 3      Agent 4
```

The master LLM is the decision-maker, not the low-level browser driver. Deterministic services own:

- Steel session creation and release
- CDP connection management
- Per-racer command serialization
- Checkpoint claiming and duplicate prevention
- Obstacle validation and script compilation
- Final task verification
- Timeouts, retries, and failure handling
- Event persistence

## Steel session lifecycle

At race creation, the session manager creates four Steel sessions in parallel.

```ts
const racers = await Promise.all(
  [0, 1, 2, 3].map(async (index) => {
    const session = await steel.sessions.create({
      sessionTimeout: 240,
    });

    return {
      racerId: `racer-${index + 1}`,
      steelSessionId: session.id,
      websocketUrl: session.websocketUrl,
      viewerUrl: session.sessionViewerUrl,
    };
  }),
);
```

Each racer gets an independent browser state. All sessions load the same course URL and the same deterministic seed. They should not share cookies, local storage, or task records unless the course explicitly requires a shared backend resource.

The session manager must release every session in a `finally` path. Steel bills by session time, so abandoned sessions are both a correctness and cost problem.

## Competitor agent connections

Each competitor agent controls exactly one Steel session.

```ts
const browser = await chromium.connectOverCDP(
  `${racer.websocketUrl}&apiKey=${process.env.STEEL_API_KEY}`,
);

const context = browser.contexts()[0];
const page = context.pages()[0];
```

The competitor can be implemented using a Playwright-based tool loop, Playwright MCP, Browser Use, or another framework that can attach through CDP. The agent receives only its own page and its own task state.

Recommended competitor tools for the MVP:

```text
navigate
inspect_page
click
type
evaluate
scroll
go_back
finish_task
```

The agent must treat the DOM as changing and potentially misleading. Recovery from the master obstacle is part of the task.

## Master agent responsibilities

The master agent sees a structured summary of the race, not unrestricted browser credentials or arbitrary execution access.

Example observation:

```json
{
  "raceId": "race-123",
  "stage": 2,
  "racers": [
    {
      "racerId": "racer-1",
      "checkpoint": 2,
      "url": "/cart",
      "lastAction": "clicked add to cart",
      "recentErrors": []
    },
    {
      "racerId": "racer-2",
      "checkpoint": 1,
      "url": "/search",
      "lastAction": "typed product name",
      "recentErrors": []
    }
  ],
  "availableHazards": [
    "blocking_modal",
    "move_primary_action",
    "insert_decoy",
    "temporary_disable",
    "rename_control"
  ]
}
```

The master returns a structured obstacle policy:

```json
{
  "checkpoint": 2,
  "hazardType": "move_primary_action",
  "targetRole": "add-to-cart",
  "durationMs": 12000,
  "intensity": 2,
  "announcement": "CONTROL SCRAMBLE"
}
```

The master should select the policy once per logical checkpoint. The backend caches that policy and applies it independently to each racer when that racer reaches the checkpoint. This gives all racers equivalent obstacle conditions while keeping checkpoint timing asynchronous.

If the master chooses a new obstacle for every racer, the product becomes more adaptive and entertaining, but the results become harder to compare. That mode can be added later.

## Obstacle policy and CDP injection

Do not allow the master LLM to emit unrestricted JavaScript. Give it a finite hazard vocabulary and validate every field before execution.

```ts
type DisruptionCommand = {
  hazardType:
    | "blocking_modal"
    | "move_primary_action"
    | "insert_decoy"
    | "temporary_disable"
    | "rename_control";
  targetRole: string;
  durationMs: number;
  intensity: number;
};
```

The course should expose stable semantic hooks:

```html
<button data-arena-role="add-to-cart">Add to cart</button>
```

The CDP layer resolves the semantic target inside each racer's current DOM and applies a bounded mutation.

```ts
const cdp = await context.newCDPSession(page);

const result = await cdp.send("Runtime.evaluate", {
  expression: `
    (() => {
      const target = document.querySelector(
        '[data-arena-role="add-to-cart"]'
      );

      if (!target) {
        return { applied: false, reason: "target_not_found" };
      }

      target.dataset.arenaOriginalPosition = target.style.position;
      target.style.position = "fixed";
      target.style.top = "24px";
      target.style.right = "24px";

      return { applied: true };
    })()
  `,
  returnByValue: true,
});
```

Every mutation should have a disruption ID and an explicit cleanup path. Use a namespace such as `data-arena-disruption-id` so a retry cannot create duplicate overlays or decoys. The cleanup path is activated by a visible recovery control or the competitor's bounded same-page DOM recovery action; `durationMs` is metadata and must not schedule automatic cleanup.

Injected DOM changes normally disappear on navigation, which counts as clearing a page-bound hazard when the runner verifies that no active disruption remains. Same-page hazards remain active until their cleanup path runs.

## Per-agent checkpoint flow

The race uses per-agent checkpoint arrival, not a global checkpoint barrier.

```text
Racer 2 reaches checkpoint 1
  -> checkpoint verifier confirms progress
  -> event is atomically claimed
  -> master policy for checkpoint 1 is loaded or created
  -> policy is injected into Steel session 2
  -> Racer 2 continues recovery

Racers 1, 3, and 4 continue independently.
```

Core handler:

```ts
async function onCheckpointReached(event: CheckpointReachedEvent) {
  const claimed = await db.claimCheckpoint({
    raceId: event.raceId,
    racerId: event.racerId,
    checkpoint: event.checkpoint,
  });

  if (!claimed) return;

  const policy = await getOrCreateStagePolicy({
    raceId: event.raceId,
    checkpoint: event.checkpoint,
  });

  await sessionQueue(event.racerId).run(async () => {
    const result = await injectDisruption(event.racerId, policy);

    await db.recordDisruptionResult({
      raceId: event.raceId,
      racerId: event.racerId,
      checkpoint: event.checkpoint,
      result,
    });
  });
}
```

The uniqueness key for checkpoint claiming is:

```text
raceId + racerId + checkpointIndex
```

This prevents duplicate events from injecting the same obstacle twice.

## Race timing and finish behavior

Three minutes is the target duration, not an automatic race ending. At the three-minute mark, the backend freezes new obstacle creation and injection, but active racers continue solving their current tasks. The race ends when the first active racer passes final verification. A longer absolute cap prevents an indefinitely stuck race.

```ts
const targetDurationAt = startedAt + 180_000;
const absoluteDeadlineAt = startedAt + 300_000;
```

Expected pacing is useful for course design, but should not be the primary obstacle trigger:

```text
0:00  all four racers start
0:25  expected first obstacle stage
0:55  expected second obstacle stage
1:25  expected third obstacle stage
1:55  optional fourth stage
2:20  optional fifth stage
3:00  freeze new obstacles; active racers continue
5:00  absolute safety cap
```

The actual obstacle rule remains:

```text
racer reaches checkpoint -> apply that checkpoint's obstacle
```

A slow racer does not miss an obstacle because it arrived after another racer. A fast racer does not wait for the group.

At the target duration:

```text
HAZARDS_FROZEN
  - no new master-agent obstacle decisions
  - no new CDP injections
  - active racers continue
  - first verified finisher wins
```

Example:

```text
Racer 1: finished at 142 seconds
Racer 2: still working at 180 seconds
Racer 3: still working at 180 seconds
Racer 4: failed at 96 seconds

At 180 seconds:
  Racer 2 and Racer 3 continue without new obstacles

Racer 3 finishes at 193 seconds
  Racer 3 wins
  Racer 2 is stopped
```

At the absolute safety cap, the orchestrator closes the race even if no racer has finished. The fallback result should be deterministic, for example the racer with the greatest verified checkpoint progress, then the lowest verified elapsed time at that progress. If no meaningful progress exists, mark the race unresolved rather than asking the master LLM to invent a winner.

## Prediction-market simulation logic

The MVP may include a Polymarket-style prediction market using virtual arena credits. This is a simulation of share pricing, not a real-money market. There are no deposits, withdrawals, cash payouts, blockchain wallets, or cash-equivalent prizes.

The four market outcomes are the four racers winning the race. Each outcome has a price from `0.00` to `1.00`. The price represents the market's current implied probability.

```text
Racer 1: 0.45  = approximately 45% confidence
Racer 2: 0.30  = approximately 30% confidence
Racer 3: 0.15  = approximately 15% confidence
Racer 4: 0.10  = approximately 10% confidence
```

For a winner-takes-all four-outcome market, prices should approximately sum to `1.00`. Small deviations are acceptable if an order book or spread is used. A simple internal market maker should normalize the prices exactly.

### Buying and resolution

Buying 10 Racer 1 shares at `0.45` costs `4.5` virtual arena credits:

```text
cost = quantity * sharePrice
```

If Racer 1 wins, each winning share resolves to `1.00` virtual credit:

```text
payout = quantity * 1.00
```

If Racer 1 loses, the shares resolve to `0.00`. Positions may optionally be sold before resolution at the current market price.

### Price updates

For the MVP, calculate prices from the current virtual demand:

```ts
price[racerId] = demand[racerId] / totalDemand;
```

Recalculate after each accepted buy or sell order and normalize the four prices so their sum is `1.00`. If there is no demand, initialize every racer at `0.25`.

Race events can affect confidence by changing demand or by applying a deterministic demand adjustment:

```text
Racer 2 reaches checkpoint 3
  -> Racer 2 confidence increases
  -> Racer 2 price rises
  -> other racer prices normalize downward
```

The master LLM must not arbitrarily set prices. It may generate race events, but the market engine owns price calculation.

### Market lifecycle

```text
OPEN
  -> accept virtual buy and sell orders

FROZEN
  -> stop new orders at the 180-second target
  -> active racers may continue racing

RESOLVED
  -> first verified finisher is the winner
  -> winning shares resolve to 1.00
  -> losing shares resolve to 0.00
```

If the race reaches the five-minute absolute safety cap without a verified winner, resolve the market as `unresolved` and return all unsettled virtual credits. Do not ask the master LLM to invent a market result.

### Prediction-market records

```ts
type PredictionMarket = {
  raceId: string;
  status: "open" | "frozen" | "resolved" | "unresolved";
  prices: Record<string, number>;
  winnerRacerId?: string;
  resolvedAt?: number;
};

type PredictionOrder = {
  id: string;
  raceId: string;
  userId: string;
  racerId: string;
  side: "buy" | "sell";
  price: number;
  quantity: number;
  status: "open" | "filled" | "cancelled";
};

type PredictionPosition = {
  raceId: string;
  userId: string;
  racerId: string;
  quantity: number;
  averagePrice: number;
};
```

The market engine must reject negative balances, invalid prices outside `0.00` to `1.00`, orders after the market is frozen, and sales exceeding a user's current position.

## Phased implementation without obstacles

The race backend can be built before the obstacle library or master disruption behavior is finalized. Keep obstacles behind an interface and run the first implementation with obstacle injection disabled.

```ts
interface ObstacleProvider {
  getPolicy(raceId: string, checkpoint: number): Promise<DisruptionCommand | null>;
  apply(racerId: string, policy: DisruptionCommand): Promise<DisruptionResult>;
}
```

The initial provider is a no-op implementation:

```ts
class NoopObstacleProvider implements ObstacleProvider {
  async getPolicy() {
    return null;
  }

  async apply() {
    return { applied: false, reason: "obstacles_disabled" };
  }
}
```

The checkpoint handler can therefore run the complete race loop now:

```text
racer reaches checkpoint
  -> verify progress
  -> record checkpoint
  -> obstacle provider returns no-op
  -> racer continues immediately
```

Later, replace the no-op provider with:

```text
MasterObstacleProvider
  -> asks the master LLM for a stage policy
  -> validates and caches the policy
  -> compiles a bounded DOM mutation
  -> applies it through CDP to the arriving racer's Steel session
```

### Phase 1: race foundation

- Create and release four Steel sessions
- Start one competitor agent per session
- Implement the readiness barrier and independent racer state machines
- Implement semantic checkpoint and final-task verification
- Implement the 180-second target, hazard freeze, and 300-second safety cap
- Implement winner selection and structured event logging
- Implement the virtual prediction-market engine
- Run against a deterministic mock course or a minimal course with no obstacles

### Phase 2: obstacle execution

- Add stable semantic DOM hooks to the course
- Implement three bounded CDP obstacle types
- Add per-racer session queues and injection acknowledgements
- Add obstacle cleanup and navigation reapplication where needed
- Replace `NoopObstacleProvider` with a deterministic seeded provider

### Phase 3: master adaptation

- Add the master LLM as a policy selector
- Pass structured racer observations to the master
- Cache one policy per checkpoint for comparability
- Add master timeouts and deterministic fallback policies
- Measure recovery latency and post-obstacle action quality

The key dependency is the course contract, not the obstacle logic. Even before real challenges are selected, define the checkpoint and final-verification interfaces so agent progress, timing, market resolution, and future CDP disruptions all use the same race state.

## Per-racer command queues

Each Steel session needs a serialized command queue. An agent action and a CDP injection must not mutate the same page concurrently.

```text
Racer 1 queue:
  agent action
  checkpoint verification
  CDP injection
  recovery observation
  agent action

Racer 2 queue:
  agent action
  agent action
  checkpoint verification
  CDP injection
```

The four queues are independent. A slow operation in Racer 1 must not block Racer 2, Racer 3, or Racer 4.

If the competitor agent runs in a separate process, use one of these patterns:

1. Preferably, let one per-racer worker own the Steel connection and serialize agent and disruption commands internally.
2. If multiple CDP clients attach to one Steel session, protect all page mutations with a per-session lock and handle navigation-related CDP context errors.

## Checkpoint verification

Checkpoint completion must be deterministic. The master LLM should not decide whether a checkpoint was completed.

For a controlled demo course, expose server-verifiable state:

```json
{
  "runId": "race-123-racer-2",
  "checkpoint": 1,
  "event": "product_found",
  "verifiedAt": 1712345678901
}
```

Possible verification mechanisms:

- A course backend event emitted when the task state changes
- A signed run-state endpoint queried by the verifier
- A browser-side arena state object combined with server validation
- A final database assertion for task completion

Do not award progress merely because the agent reached a URL or because an LLM described the page as complete.

## Data model

```ts
type Race = {
  id: string;
  courseId: string;
  seed: string;
  racerCount: 4;
  checkpointCount: number;
  status: "starting" | "running" | "finished" | "timed_out";
  startedAt?: number;
  deadlineAt?: number;
  winnerRacerId?: string;
};

type Racer = {
  raceId: string;
  racerId: string;
  steelSessionId: string;
  checkpoint: number;
  status:
    | "starting"
    | "ready"
    | "running"
    | "recovering"
    | "finished"
    | "failed"
    | "timed_out";
  startedAt?: number;
  finishedAt?: number;
};

type StagePolicy = {
  raceId: string;
  checkpoint: number;
  hazardType: string;
  targetRole: string;
  durationMs: number;
  intensity: number;
  createdAt: number;
};

type DisruptionEvent = {
  id: string;
  raceId: string;
  racerId: string;
  checkpoint: number;
  policyId: string;
  dispatchedAt: number;
  appliedAt?: number;
  /** Set when the agent explicitly clears the persistent disruption. */
  removedAt?: number;
  applied: boolean;
  error?: string;
};

type AgentAction = {
  raceId: string;
  racerId: string;
  sequence: number;
  actionType: string;
  input: unknown;
  startedAt: number;
  completedAt?: number;
  success?: boolean;
  error?: string;
};
```

## Finish and timeout behavior

When a racer finishes:

1. The verifier confirms the final task state.
2. The orchestrator records the finish timestamp.
3. If no winner exists, the racer becomes the winner.
4. The market resolves using that verified winner.
5. The remaining racers are stopped.
6. All sessions are released after final event persistence.

Example result:

```text
Racer 3: winner, finished at 121.4 seconds
Racer 1: stopped at checkpoint 3
Racer 4: stopped at checkpoint 2
Racer 2: stopped at checkpoint 2
```

If nobody has finished at 180 seconds, active racers continue without new obstacles or market trades until one finishes or the 300-second safety cap is reached.

## Failure handling

The orchestrator should handle these cases explicitly:

- Steel session creation failure: replace the session before the start barrier
- Agent startup failure: mark the racer failed and continue only if the MVP permits fewer than four racers
- Missing disruption target: record `target_not_found`, do not repeatedly retry indefinitely
- CDP timeout: retry once, then mark the injection failed and continue the racer
- Navigation during injection: retry after the new document is ready
- Duplicate checkpoint event: ignore after the atomic claim
- Master LLM timeout: use a deterministic fallback policy for that checkpoint
- Target duration: stop new obstacles and market trades while active racers continue
- Absolute deadline: stop unfinished racers and mark the race unresolved
- Process crash: persist the last known event and release the Steel session during recovery

The race should never depend on the master LLM responding within the critical path forever. Every master call needs a short timeout and a fallback.

## Recommended first implementation

Build in this order:

1. A deterministic course with three verified checkpoints.
2. One Steel session and one competitor agent.
3. One CDP obstacle applied when that agent reaches checkpoint 1.
4. A per-session command queue.
5. Four concurrent Steel sessions and four competitor workers.
6. Per-agent checkpoint events with idempotent claiming.
7. One cached master policy per checkpoint.
8. Three-minute timeout, winner selection, and session cleanup.
9. Structured event logging and replayable race records.

The core success criterion is:

> Four agents start from the same course seed, progress independently, receive equivalent obstacles at their own checkpoint arrival times when obstacles are enabled, and produce a deterministic winner plus a complete event log. At 180 seconds hazards freeze; at 300 seconds the unresolved safety cap applies.

## Implemented backend contract

The repository currently implements:

- Four-racer race state and readiness barrier
- Independent, idempotent checkpoint progression
- Deterministic course-state verification through an HTTP gateway
- Playwright competitor runner with bounded semantic actions
- Steel session creation and CDP connections
- Per-racer CDP command serialization
- No-op and master-selected obstacle providers
- Bounded DOM obstacle compilation and application
- Anthropic tool-based adapters for competitor and master decisions
- Master timeouts with deterministic fallback policies
- Virtual prediction-market funding, buying, selling, freezing, and resolution
- Automatic three-minute hazard and market freeze
- Five-minute unresolved safety cap
- Append-only JSONL race event persistence
- HTTP routes for the separate frontend
- Four-session Steel smoke-test command

Core HTTP routes:

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

The actual course content and final obstacle definitions remain deliberately configurable. A live infrastructure check runs with `npm run smoke:steel` when `STEEL_API_KEY` is available.

## Version-control workflow

The implementation should be committed and pushed in small, coherent increments. Each commit should leave the backend in a runnable state and should correspond to one logical change.

Recommended sequence:

1. Create or select the project Git repository and confirm its GitHub remote.
2. Commit the initial course and Steel session lifecycle.
3. Commit the single-racer agent runner and CDP injection path.
4. Commit the four-racer fan-out and per-racer command queues.
5. Commit checkpoint verification and idempotent obstacle triggering.
6. Commit master policy selection and policy caching.
7. Commit timeout, winner selection, cleanup, and structured event logging.
8. Run the relevant tests and smoke race.
9. Push each verified commit to the configured remote.

Use descriptive commit messages, for example:

```text
feat: create Steel sessions for four racers
feat: add per-racer CDP disruption queue
feat: trigger obstacles on verified checkpoints
feat: add master hazard policy cache
fix: make checkpoint events idempotent
test: add three-minute four-racer smoke race
```

Before every push, check:

```text
git status
git diff --check
git log -1 --oneline
```

Do not commit Steel API keys, model API keys, CDP URLs containing credentials, session cookies, screenshots containing private data, or raw secrets in event logs. Use environment variables and a checked-in `.env.example` instead.
>
> 
