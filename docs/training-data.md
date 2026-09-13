# Training data export

Every fight is a controlled experiment. Four models attempt the same task, from the same seed, and meet the same sabotage at the same checkpoint. The course server verifies each step. The dataset export turns those runs into training data for future web agents: supervised examples, preference pairs, verified rewards and visual grounding.

The export covers **all four agents, failures included**. Only `sft.jsonl` is limited to good steps from successful runs, because it is what a model is taught to imitate.

## Download

```text
GET /api/datasets/export.zip?days=30&mode=live          the full bundle
GET /api/datasets/manifest.json?days=30&mode=live
GET /api/datasets/{episodes|steps|sft|preferences}.jsonl?days=30&mode=live
```

- `days` is 1–365, default 30.
- `mode` is `live`, `simulated` or `all`, default the server's mode.
- Simulated rows come from scripted agents, not real models. Use `mode=live` for training.

The **Evaluations** page has the same downloads.

```text
sabotage-markets-dataset-YYYY-MM-DD.zip
  manifest.json                                  schema, filters, counts, the action tool and system prompt
  episodes.jsonl                                 one line per agent per fight
  steps.jsonl                                    one line per agent step (the core record)
  sft.jsonl                                      chat-format examples for supervised fine-tuning
  preferences.jsonl                              chosen / rejected pairs at sabotage moments (DPO)
  assets/<raceId>/<racerId>/step-0007.jpg        the screenshot each step's observation was taken with
  steel/<raceId>/<racerId>.trace.json            raw Steel Agent Traces, as returned by Steel
```

All files are [JSON Lines](https://jsonlines.org) (UTF-8, one object per line). They load directly into Hugging Face `datasets`, pandas and the usual fine-tuning tools. The row types are defined in `src/api/dto.ts`, in the "Dataset export" section.

## What each file holds

| File | One line is | Key contents | Use |
| --- | --- | --- | --- |
| `steps.jsonl` (`DatasetStep`) | One step by one agent | See below | The core record: supervised fine-tuning, reward modelling, analysis |
| `episodes.jsonl` (`DatasetEpisode`) | One agent in one fight | Outcome (won, finished, failed, timed_out, stopped), duration, steps, errors, loops, robustness, every sabotage reaction with time lost and explanation, crowd prices, links to its steps and Steel trace | Filtering, evaluation, curricula |
| `sft.jsonl` (`DatasetSftExample`) | One good step of a successful run | `messages`: the runner's system prompt, the exact input the model received (task, observation, last 10 actions), and the tool call it made (with its reasoning) | Supervised fine-tuning, in the OpenAI / Hugging Face chat format |
| `preferences.jsonl` (`DatasetPreference`) | One pair at a sabotage | The page as the trap appeared; the action that worked (`chosen`) and one that failed (`rejected`) | Preference training (DPO) |
| `assets/…` | A screenshot | The page each step's observation was taken on | Vision and grounding, with the cursor and Steel bounding boxes |
| `steel/…` | One agent's session | Steel's own record, unmodified | Independent verification; re-deriving anything |

Each `steps.jsonl` line contains:
- **What the model saw:** `observation` holds the URL, title, page text (up to 8,000 characters) and every control with its label, visibility and disabled state. `screenshot` is the bundle path of the image.
- **What it did:** `action`, the exact tool call. It is one of inspect, click, type, evaluate (its own DOM repair script), navigate, wait, checkpoint or finish, with the target role, the label and the typed text.
- **Why:** `reasoning`, the model's one-sentence reason.
- **How the call went:** `decisionIssue` is null when the model gave one valid tool call on the first try. Otherwise `malformedAttempts` counts its malformed payloads (the provider is asked once more after the first), and `fallback: true` marks a step where it never gave a usable call and the runner inspected the page instead. That action is the runner's, not the model's.
- **What happened:** `result` records whether the action succeeded; whether it was blocked by a modal, a disabled, hidden or missing control, or a timeout; whether it clicked a decoy; whether it navigated; whether it cleared a sabotage; whether verified progress or the finish followed; the element it hit; and the cursor position.
- **Context:**
  - `hazard`: the sabotage in effect, which the agent could not see
  - `progress`: checkpoints cleared so far, and the next checkpoint's label
  - `timing`: when the step was observed, prompted (after any rate-limit pause), decided and acted; the rate-limit pause; and the model's latency, from prompt to answer
- **Steel:** the browser events between this step's decision and the next.
- **Labels:** `quality` is one of progress, neutral, wasted or harmful. `reaction` is the sabotage reaction, when the step fell inside a sabotage window.

## Where the data comes from

| Source | Contributes |
| --- | --- |
| Runner (every step) | The observation, screenshot, tool call, reasoning, timing (with rate-limit pauses), malformed and substituted tool calls, and browser-side evidence: the target element, decoy, blocked-by, navigation, cleared sabotage, cursor |
| Course server | Verified checkpoints and the finish. Progress is never taken on the model's word. |
| Race engine | When each sabotage fired and when the agent cleared it (sabotage persists until cleared), with hazard type and tier |
| Steel Agent Traces | Clicks (element role, label, selector, box, pointer); typing (field, input type, length, start and end, never the characters, passwords flagged redacted); keys such as Enter; submits; page loads; scrolls; errors |
| Evaluation | Outcomes, reaction labels, time lost, robustness |
| Market | Crowd YES prices around each hit (evaluation and calibration only) |

**Keystrokes:** Steel records typing sessions, not characters. The exact text an agent typed comes from its tool call in `action.text`.

**Passwords:** text typed into password fields is replaced with `[redacted]` everywhere: in the action, the description and the error. Its length is kept in `textLength`.

## How rows are derived

Every rule is deterministic, and all times are epoch ms.

- **Sabotage window:** it opens at a racer's `sabotage_applied` event and closes at that racer's next `sabotage_recovered`, the moment it cleared the trap. A step is inside the window when its observation time falls in it.
- **Progressed / finished:** a verified checkpoint, or the finish, recorded for the racer between this step's action and the next step's.
- **Quality**, first rule that matches:

  | Quality | When |
  | --- | --- |
  | harmful | Clicked a decoy, was blocked, errored, or the model gave no usable tool call (a runner fallback) |
  | progress | Progressed, finished, or cleared a sabotage |
  | wasted | Repeated the previous step without progress |
  | neutral | Anything else |

- **Steel slice:** Steel events between this step's decision and the next step's decision.
- **SFT:** steps from won or finished episodes, with quality progress or neutral, that have both an observation and an action and whose tool call was the model's own first try (no `decisionIssue`). Steps that typed into a password field are left out. The user message is exactly what the model received at runtime.
- **Preferences:**
  - *Self-correction:* inside one racer's sabotage window, its first harmful step against its first later step that progressed or cleared the trap.
  - *Cross-agent:* on the same trap, each racer's first decisive step. Racers that got it right are paired with racers that got it wrong, and the prompt is the failing racer's view.
  - Both sides are always the models' own first-try tool calls (no `decisionIssue`).

## Scope and honesty

- The structure is the valuable part: identical tasks and traps across models, verified outcomes, and real recovery actions and repair scripts.
- Volume and variety are what turn it into a training asset. That means hundreds of live fights, several realistic courses, and more trap types.
- Screenshots and Steel traces are stored under `DATASET_DIR` (default `data/dataset` in live mode; in memory in simulated mode unless the variable is set).
- RAG and experience memory are out of scope. This export is the training data itself.
