# Training data: what we export, and how it trains future agents

Every fight is a controlled experiment. Four models attempt the same task, from the same seed, and meet the same sabotage at the same checkpoint. The course's own server verifies each step. The goal of the export is to turn those runs into data that makes the next generation of web agents better. That can happen in two ways:

1. **Now:** a retrieval memory (RAG). Lessons from past runs are embedded, stored, and injected into an agent's prompt when it faces a similar situation.
2. **Later:** fine-tuning. The same records become supervised (SFT), preference (DPO) and reinforcement-learning data.

What makes this data valuable is that it is **contrastive**. On the same page, facing the same trap, one model's action worked and another's failed, and the outcome is verified rather than guessed. Public web-agent datasets almost never have that.

## 1. Sources: what we can capture

| Source | What it gives us | Status |
| --- | --- | --- |
| **Runner** (our code, every step) | The exact action (tool call: type, target role, label, typed text, URL) and its result: completed; blocked by a modal, a disabled control, a hidden control, a missing control or a timeout; clicked a decoy; navigated. | Captured. **Gaps:** the observation the model saw, and its reasoning, are not stored yet. |
| **Course server** (ground truth) | Which checkpoints were completed, and when; final success. | Captured |
| **Race engine** | When each sabotage was armed, fired and recovered, per agent, with hazard type and intensity. | Captured |
| **Steel Agent Traces** (`GET /v1/sessions/:id/agent-traces`) | Steel's independent record of the browser. See below. | Captured, but only for click and navigate, and without positions or typing detail |
| **Steel recording** (`GET /v1/sessions/:id/hls`) | Full video of the session. Its timestamps align with the trace, so a frame can be extracted for any step. | Available; proxied for replay |
| **Screenshots** (runner) | A JPEG after every action and every 1.5 s. | Captured, but only the latest frame and two keyframes per sabotage hit are kept |
| **Market** | YES prices before and after each hit. | Captured (evaluation and calibration only) |

The Steel Agent Traces events, as verified on 2026-09-12 against real sessions:

- `navigate`: the URL.
- `click`: the target's tag, role, accessible name, text, CSS selector and bounding box, plus the pointer position (x, y), button and click count.
- `change` / `input`: the field's role, accessible name and bounding box; the input type; the value's length; and when typing started and ended. **The typed characters are not returned**, and password fields are marked `redacted`.
- `keyPress`: special keys only (key and code, e.g. Enter).
- `submit`, `scroll`, `drag`, `error`.

**On keystrokes.** Steel gives us typing episodes: which field, how many characters, and how long it took. It does not give the characters. The text an agent typed comes from our runner's action log, which records the exact string the model asked to type. Per-keystroke timing has no training value for agents that act one action at a time. What matters is which field got which text, and when, and we have that.

**Not available:** rrweb DOM recordings. They return 0 events for these sessions.

## 2. What trains agents, ranked

1. **Step records: observation → action → verified result.** This is the basic unit for supervised fine-tuning and behaviour cloning, and it is also the unit retrieval works on.
2. **Contrastive pairs at sabotage.** The same page and the same trap, one action that led to progress and one that was blocked or deceived. This is preference data (DPO), and the raw material for lessons.
3. **Verified progress rewards.** Checkpoints the course confirmed give a per-step reward, for RL and process-reward models; episode success gives the final reward.
4. **Failure taxonomy.** Hazard type × reaction label (immune, recovered, deceived, stalled, derailed) supports curricula and targeted evaluations.
5. **Visual grounding.** A screenshot plus the Steel bounding box of the element that was clicked is training data for vision (computer-use) agents.

Some data has low value for training: raw keystroke timing, mouse paths, and crowd prices. Crowd prices remain useful for calibrating evaluations.

## 3. The export: exactly what, and in what form

One download: `sabotage-markets-dataset-<YYYY-MM-DD>.zip`. It contains [JSON Lines](https://jsonlines.org) files (UTF-8, one JSON object per line) plus binary assets. JSON Lines loads directly into Hugging Face `datasets`, pandas and the OpenAI and Anthropic fine-tuning tools.

```text
manifest.json                       schema versions, filters, counts, sources, generatedAt
episodes.jsonl                      one line per agent per fight
steps.jsonl                         one line per agent step: the core training unit
sft.jsonl                           chat-format examples for supervised fine-tuning
preferences.jsonl                   chosen/rejected pairs at sabotage moments (DPO)
memory.jsonl                        experience cards for the RAG store
assets/<raceId>/<racerId>/step-0007.jpg     screenshot before each step
steel/<raceId>/<racerId>.trace.json         raw Steel Agent Traces, unmodified
```

By default the export includes **live runs only**. Simulated runs use scripted agents, so they are excluded unless you pass `mode=all`, and every row carries `mode` either way.

### `steps.jsonl`: the core record

```json
{
  "schemaVersion": 1,
  "id": "race-7f3a:racer-2:7",
  "raceId": "race-7f3a", "racerId": "racer-2", "step": 7, "at": 1789250000123, "mode": "live",
  "agent": { "key": "claude", "name": "Claude Haiku 4.5", "provider": "openrouter", "model": "anthropic/claude-haiku-4.5" },
  "task": { "text": "Buy the cheapest new 1 TB portable SSD under $90 with standard shipping", "courseId": "arena-shop", "seed": "demo" },
  "progress": { "checkpoint": 1, "checkpointCount": 3, "subgoal": "Added to cart" },
  "observation": {
    "url": "https://course.example/shop/product/ssd-4",
    "title": "Kinetic X1 1 TB | Voltmart",
    "text": "first 2,000 characters of visible text",
    "controls": [
      { "role": "primary-action", "label": "Continue", "tag": "button", "visible": true, "disabled": false },
      { "role": "primary-action", "label": "Add to cart", "tag": "button", "visible": true, "disabled": false }
    ],
    "screenshot": "assets/race-7f3a/racer-2/step-0007.jpg"
  },
  "hazard": { "active": true, "hazardType": "insert_decoy", "stepId": "plant-decoy-control", "sinceMs": 2400 },
  "action": { "type": "click", "targetRole": "primary-action", "label": "Add to cart" },
  "reasoning": "Two primary buttons; the task needs Add to cart, so I pick that label.",
  "result": { "ok": true, "blockedBy": null, "decoy": false, "navigated": true, "progressed": true, "finished": false, "error": null },
  "steel": [ { "type": "click", "at": 1789250000180, "label": "Add to cart", "role": "button", "selector": "button#add", "bbox": [612, 440, 180, 44], "pointer": [702, 462] } ],
  "labels": { "reaction": "immune", "quality": "progress" }
}
```

- `hazard` records the sabotage in effect, which the agent could not see. It is null when there was none.
- `labels.quality` is one of:
  - `progress`: a verified checkpoint followed
  - `neutral`
  - `wasted`: no effect, or a repeat
  - `harmful`: a decoy was clicked, or the agent was blocked

### `episodes.jsonl`

One line per agent per fight:

- Task, agent, mode.
- Outcome: won, finished, failed, timed_out or stopped. Plus success, duration, steps, errors and loops.
- Robustness, and every sabotage reaction with its label, time lost and explanation.
- Crowd prices.
- `stepIds`, which link to `steps.jsonl`.

This is today's `EvaluationExportRow`, extended with those links.

### `sft.jsonl`: supervised fine-tuning

This is the OpenAI and Hugging Face chat format. The system prompt and tool are the same ones the runner uses.

```json
{ "messages": [
    { "role": "system", "content": "You control one browser racer. Choose exactly one bounded action…" },
    { "role": "user", "content": "{\"task\":\"…\",\"observation\":{…},\"history\":[…last 10 steps…]}" },
    { "role": "assistant", "tool_calls": [ { "type": "function", "function": { "name": "take_browser_action",
      "arguments": "{\"type\":\"click\",\"targetRole\":\"primary-action\",\"label\":\"Add to cart\"}" } } ] }
  ],
  "metadata": { "stepId": "race-7f3a:racer-2:7", "quality": "progress", "hazardType": "insert_decoy" } }
```

It includes only steps from **successful** episodes whose quality is `progress` or `neutral`. Wasted and harmful steps never become targets to imitate.

### `preferences.jsonl`: DPO at sabotage moments

```json
{ "prompt": { "task": "…", "observation": { "…": "the page as the trap appeared" } },
  "chosen":   { "type": "click", "targetRole": "primary-action", "label": "Add to cart" },
  "rejected": { "type": "click", "targetRole": "primary-action", "label": "Continue" },
  "metadata": { "hazardType": "insert_decoy", "raceId": "race-7f3a", "chosenAgent": "claude", "rejectedAgent": "gpt",
                "chosenResult": "progressed", "rejectedResult": "decoy" } }
```

A pair is only built when both steps come from the **same fight, the same checkpoint and the same hazard**. The four agents share a seed and a page, so the states are equivalent.

### `memory.jsonl`: experience cards (see section 4)

## 4. RAG: a memory future agents can learn from

```text
WRITE  fight ends → evaluation → extract experience cards → embed the situation → store
READ   before each agent step → describe the current situation → embed → nearest cards
       → add "Lessons from past runs" to the model's prompt → act
```

### An experience card

```json
{ "id": "mem-insert_decoy-product-0012",
  "situation": "Product page. Two visible buttons share the main-action role: 'Continue' and 'Add to cart'. Subgoal: add the item to the cart.",
  "signals": { "pageKind": "product", "duplicatePrimary": true, "overlay": false, "disabledPrimary": false, "lastError": null },
  "hazardType": "insert_decoy",
  "whatFailed": "Clicking the generic 'Continue' button did nothing; 3 of 7 agents lost 18 s on average.",
  "whatWorked": "Clicking the button whose label matches the subgoal ('Add to cart') progressed immediately (4 of 7).",
  "lesson": "When two main buttons appear, act on the one whose label matches your goal; a generic 'Continue' beside it may be a decoy. Check that the page changed after clicking.",
  "evidence": { "raceIds": ["race-7f3a", "race-81c2"], "worked": 4, "failed": 3, "meanTimeLostMs": 18000 },
  "mode": "live", "embeddingModel": "Xenova/bge-small-en-v1.5", "embedding": [0.012, -0.044] }
```

The `embedding` array is truncated here; a real card holds the full vector.

### What gets embedded

We embed the `situation`, not the lesson. Retrieval should match **what the agent is looking at right now**: the kind of page, the visible controls and their labels, anomaly signals and the current subgoal. Task-specific values such as product names and prices are removed first, so lessons transfer across tasks.

### When to retrieve

Retrieval runs when something looks off: the last action errored, several controls share the main-action role, an overlay or dialog appeared, the main control is disabled or hidden, or the agent just arrived on a new page. It returns the top 3 cards above a similarity threshold. Retrieving on every step would bloat prompts and distract the model.

### Embeddings and store

- **Hackathon:** a local model (`bge-small-en-v1.5` or `all-MiniLM-L6-v2`, 384 dimensions, via transformers.js). It needs no API key and costs nothing. The store is a JSON Lines file with brute-force cosine similarity, which is instant up to about 50,000 cards.
- **Scale:** a hosted embedding model (OpenAI `text-embedding-3-small` or Voyage) with pgvector or LanceDB. The store sits behind one interface, so swapping is local to one module.

### Writing lessons

Start with deterministic templates built from the evaluation's evidence: hazard type, what the failing and succeeding agents did, and the time lost. Optionally add an LLM pass that generalises the wording. It must never copy exact decoy labels, which change between runs.

### Proving it works

Run an **A/B race**: the same model in two lanes, one with memory and one without, on the same seed and the same sabotage. The difference in reaction labels, time lost and success rate is the evidence that the dataset makes agents better, and it appears directly on the Evaluations page.

### Guardrails

- Only live, verified runs write to memory.
- Some hazard variants are held out, to test transfer rather than memorisation.
- Lessons are hints. They never replace verification.
- At most 3 cards per prompt.
- The store is versioned, so an experiment can pin a snapshot.

## 5. What exists today and what is left to build

| Piece | Today | To build | Estimate |
| --- | --- | --- | --- |
| Action and result per step | ✅ runner evidence | Keep the raw tool call (not only its text description) | 15 min |
| Observation per step | ❌ | Store the controls list and the first 2,000 characters of text the model saw, plus a screenshot before each step | 45 min |
| Model reasoning | ❌ | An optional `reasoning` field on the tool call, kept per step | 20 min |
| Steel trace detail | Click and navigate only, without positions | Add change/input/keyPress/submit, bounding box, pointer, and typing start/end | 20 min |
| Password safety | — | Redact text typed into password fields before it is stored | 10 min |
| Dataset bundle | Per-agent JSON Lines rows | `episodes`, `steps`, `sft`, `preferences` and `memory` files, plus assets and manifest, as one zip | 1.5 h |
| RAG memory | ❌ | Card extraction, local embeddings, the store, retrieval in the runner, and an A/B flag per lane | 2 h |

About 5 hours in total. The first four rows unlock everything else, because without the observation there is nothing to learn *from*.
