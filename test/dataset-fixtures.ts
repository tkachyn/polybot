/**
 * A golden fight for the dataset tests: four racers meet one decoy sabotage
 * ("plant-decoy") at checkpoint 1, and every derivation rule is exercised at
 * least once. Times are offsets from T; each step says what it tests.
 */
import type {
  AgentEvaluation,
  AgentIdentity,
  CursorPosition,
  DatasetAction,
  DatasetSteelEvent,
  FightEvaluation,
  ReactionLabel,
  SabotageReaction,
  ServerMode,
  StepObservation,
} from "../src/api/dto.js";
import type { DatasetFileInput, FightDatasetRecord, StepRecord } from "../src/dataset/types.js";
import type { RaceEvent } from "../src/domain/types.js";

export const T = Date.UTC(2026, 8, 10, 12);
export const NOW = Date.UTC(2026, 8, 12, 12);
export const DAY = 86_400_000;
export const RACE_ID = "race-g";
export const TRAP = "plant-decoy";
export const TASK = "Buy the blue mug";

export const AGENTS: readonly AgentIdentity[] = [
  { key: "gpt", name: "GPT-5.2", provider: "openrouter", model: "openai/gpt-5.2" },
  { key: "claude", name: "Claude Haiku 4.5", provider: "openrouter", model: "anthropic/claude-haiku-4.5" },
  { key: "gemini", name: "Gemini 3 Flash", provider: "openrouter", model: "google/gemini-3-flash" },
  { key: "grok", name: "Grok 4", provider: "openrouter", model: "x-ai/grok-4" },
];

function page(title: string, controls: Array<[arenaRole: string, label: string]>): StepObservation {
  return {
    url: `https://shop.test/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    title,
    text: `${title}\nBlue mug $12`,
    controls: controls.map(([arenaRole, label]) => ({
      tag: "button",
      role: null,
      arenaRole,
      label,
      visible: true,
      disabled: false,
    })),
  };
}

export const PRODUCT = page("Blue mug", [["primary-action", "Add to cart"]]);
/** The trap: a decoy "Continue" beside the real "Checkout". */
export const TRAP_PAGE = page("Cart", [["primary-action", "Continue"], ["primary-action", "Checkout"]]);
/** The same trap as racer-3 saw it, behind a dialog. */
export const TRAP_COVERED = page("Cart", [
  ["dialog", "Close"],
  ["primary-action", "Continue"],
  ["primary-action", "Checkout"],
]);
export const SHIPPING = page("Shipping", [["primary-action", "Checkout"]]);
export const PAYMENT = page("Payment", [["password", "Password"], ["primary-action", "Pay now"]]);
export const REVIEW = page("Review", [["primary-action", "Place order"]]);

export function click(label: string, targetRole = "primary-action"): DatasetAction {
  return { type: "click", targetRole, label };
}
export const REPAIR_R1: DatasetAction = {
  type: "evaluate",
  script: "document.getElementById('arena-decoy-1')?.remove()",
};
export const REPAIR_R2: DatasetAction = { type: "evaluate", script: "window.__arenaRecoverDisruptions?.()" };
export const TYPE_PASSWORD: DatasetAction = {
  type: "type",
  targetRole: "password",
  label: "Password",
  text: "[redacted]",
  textLength: 8,
};
export const INSPECT: DatasetAction = { type: "inspect" };
export const CURSOR: CursorPosition = { x: 640, y: 420, viewportWidth: 1280, viewportHeight: 800, action: "click" };

type StepOverrides = Omit<Partial<StepRecord>, "evidence"> & {
  evidence?: Partial<StepRecord["evidence"]>;
};

/** A step record; its signature defaults to the action's JSON, as the runner's does. */
export function stepRecord(step: number, actedAt: number, overrides: StepOverrides = {}): StepRecord {
  const { evidence, ...rest } = overrides;
  const action = rest.action ?? null;
  return {
    step,
    kind: "action",
    actedAt,
    observedAt: null,
    promptedAt: null,
    decidedAt: null,
    rateLimitWaitMs: 0,
    url: "https://shop.test/",
    text: `step ${step}`,
    observation: null,
    action,
    reasoning: null,
    decisionIssue: null,
    error: null,
    modelError: null,
    signature: action ? JSON.stringify(action) : null,
    ...rest,
    evidence: {
      target: null,
      blockedBy: null,
      navigated: false,
      clearedSabotage: false,
      cursor: null,
      ...evidence,
    },
  };
}

const at = (offset: number): number => T + offset;

/** GPT: hit at +10 s, clicks the decoy, repairs the page, then wins. */
function racer1Steps(): StepRecord[] {
  return [
    // Acts at checkpoint 1's own time: that checkpoint is this step's result.
    stepRecord(1, at(10_000), {
      observedAt: at(8_000), decidedAt: at(8_600), observation: PRODUCT, action: click("Add to cart"),
      reasoning: "Add the mug to the cart.",
      evidence: { target: { role: "primary-action", text: "Add to cart", decoy: false }, navigated: true },
    }),
    // Observed inside the trap window: clicks the decoy (self-correction rejected).
    stepRecord(2, at(11_000), {
      observedAt: at(10_500), decidedAt: at(10_800), observation: TRAP_PAGE, action: click("Continue"),
      reasoning: "Continue looks like the next step.",
      evidence: { target: { role: "primary-action", text: "Continue", decoy: true }, cursor: CURSOR },
    }),
    // Repairs the page and clears the sabotage (self-correction chosen).
    stepRecord(3, at(13_000), {
      observedAt: at(12_000), decidedAt: at(12_400), observation: TRAP_PAGE, action: REPAIR_R1,
      reasoning: "The Continue button was a decoy; remove it.",
      evidence: { clearedSabotage: true },
    }),
    // No observation or decision time: windows and Steel slices fall back to actedAt.
    stepRecord(4, at(19_000), {
      action: click("Checkout"),
      evidence: { target: { role: "primary-action", text: "Checkout", decoy: false }, navigated: true },
    }),
    // Blocked by a timeout outside any window: harmful.
    stepRecord(5, at(22_000), {
      kind: "error", observedAt: at(21_000), decidedAt: at(21_400), observation: SHIPPING,
      action: click("Pay"), error: "locator.click: Timeout 2000ms exceeded", evidence: { blockedBy: "timeout" },
    }),
    // Typed into a password field: neutral, but never an SFT target.
    stepRecord(6, at(25_000), {
      observedAt: at(24_000), decidedAt: at(24_300), observation: PAYMENT, action: TYPE_PASSWORD,
      reasoning: "Enter the password from the task.",
    }),
    stepRecord(7, at(29_000), {
      observedAt: at(28_000), decidedAt: at(28_500), observation: PAYMENT, action: click("Pay now"),
    }),
    // The last step's window is open-ended, so the later finish is its result.
    stepRecord(8, at(35_000), {
      observedAt: at(34_000), decidedAt: at(34_500), observation: REVIEW, action: click("Place order"),
      reasoning: "Place the order.",
    }),
    // A note is not a decision, and it repeats step 8's number: no row.
    stepRecord(8, at(36_000), { kind: "note", text: "Step budget exhausted", signature: null }),
  ];
}

/** Claude: hit at +11 s, repairs the page first (cross-agent chosen), then loops. */
function racer2Steps(): StepRecord[] {
  return [
    stepRecord(1, at(10_500), {
      observedAt: at(10_000), decidedAt: at(10_200), observation: PRODUCT, action: click("Add to cart"),
    }),
    stepRecord(2, at(12_000), {
      observedAt: at(11_500), decidedAt: at(11_800), observation: TRAP_PAGE, action: REPAIR_R2,
      reasoning: "A second primary button appeared; repair the page first.",
      evidence: { clearedSabotage: true },
    }),
    stepRecord(3, at(14_000), {
      observedAt: at(13_500), decidedAt: at(13_700), observation: SHIPPING, action: click("Checkout"),
    }),
    // The same call again without progress: wasted.
    stepRecord(4, at(15_500), {
      observedAt: at(15_000), decidedAt: at(15_200), observation: SHIPPING, action: click("Checkout"),
    }),
  ];
}

/** Gemini: hit at +12 s, blocked first (cross-agent rejected), never clears the trap. */
function racer3Steps(): StepRecord[] {
  return [
    stepRecord(1, at(11_500), {
      observedAt: at(11_000), decidedAt: at(11_300), observation: PRODUCT, action: click("Add to cart"),
    }),
    stepRecord(2, at(13_500), {
      kind: "error", observedAt: at(12_500), decidedAt: at(12_900), observation: TRAP_COVERED,
      action: click("Continue"), error: "Element is covered by a dialog", evidence: { blockedBy: "modal" },
    }),
    // Harmful beats wasted: the same call again, now onto the decoy.
    stepRecord(3, at(14_500), {
      observedAt: at(14_000), decidedAt: at(14_200), observation: TRAP_PAGE, action: click("Continue"),
      evidence: { target: { role: "primary-action", text: "Continue", decoy: true } },
    }),
    stepRecord(4, at(16_500), {
      observedAt: at(16_000), decidedAt: at(16_200), observation: TRAP_PAGE, action: INSPECT,
    }),
  ];
}

/** Grok: never reaches the trap. */
function racer4Steps(): StepRecord[] {
  return [
    stepRecord(1, at(6_000), {
      observedAt: at(5_000), decidedAt: at(5_500), observation: PRODUCT, action: INSPECT,
    }),
    stepRecord(2, at(8_000), {
      kind: "error", observedAt: at(7_000), decidedAt: at(7_400), observation: PRODUCT,
      action: click("Search", "search"), error: "Element is not visible", evidence: { blockedBy: "hidden" },
    }),
  ];
}

export function steelEvent(offset: number, type = "click"): DatasetSteelEvent {
  return {
    at: T + offset,
    endAt: null,
    type,
    label: `e${offset}`,
    role: "button",
    tag: "button",
    selector: null,
    url: "https://shop.test/",
    bbox: [600, 400, 120, 40],
    pointer: { x: 660, y: 420, button: "left" },
    input: null,
    key: null,
    decoy: false,
  };
}

/** Racer-1's Steel events: +7 s falls before its first decision and belongs to no step. */
export const R1_STEEL_OFFSETS = [7_000, 8_600, 10_800, 12_400, 18_999, 19_000, 50_000] as const;

/** Racer-1's raw Agent Traces, as Steel returned them. */
export const RAW_TRACE: unknown[] = [
  { timestamp: "2026-09-10T12:00:08.600Z", type: "click", target: { accessibleName: "Add to cart" } },
  { timestamp: "2026-09-10T12:00:10.800Z", type: "click", target: { accessibleName: "Continue" } },
];

function event(type: RaceEvent["type"], offset: number, extra: Partial<RaceEvent> = {}): RaceEvent {
  return {
    id: `${RACE_ID}:${offset}:${type}:${extra.racerId ?? "race"}`,
    raceId: RACE_ID,
    type,
    occurredAt: T + offset,
    ...extra,
  };
}

function hit(racerId: string, offset: number): RaceEvent {
  return event("sabotage_applied", offset, {
    racerId,
    checkpoint: 1,
    metadata: {
      tier: "basic",
      policy: { hazardType: "insert_decoy", targetRole: "primary-action", durationMs: 5_000, intensity: 1 },
      stepId: TRAP,
      step: 1,
    },
  });
}

function recovered(racerId: string, offset: number): RaceEvent {
  return event("sabotage_recovered", offset, {
    racerId,
    metadata: { checkpoint: 1, cause: "manual", stepId: TRAP, step: 1 },
  });
}

export function goldenEvents(): RaceEvent[] {
  return [
    event("race_started", 0),
    event("checkpoint_reached", 10_000, { racerId: "racer-1", checkpoint: 1 }),
    hit("racer-1", 10_000),
    event("checkpoint_reached", 11_000, { racerId: "racer-2", checkpoint: 1 }),
    hit("racer-2", 11_000),
    event("checkpoint_reached", 12_000, { racerId: "racer-3", checkpoint: 1 }),
    hit("racer-3", 12_000),
    recovered("racer-2", 13_000),
    recovered("racer-1", 14_500),
    event("checkpoint_reached", 20_000, { racerId: "racer-1", checkpoint: 2 }),
    event("checkpoint_reached", 30_000, { racerId: "racer-1", checkpoint: 3 }),
    event("racer_finished", 40_000, { racerId: "racer-1" }),
    event("race_finished", 40_000, { metadata: { winner: true } }),
  ];
}

export function reaction(label: ReactionLabel, appliedOffset: number): SabotageReaction {
  return {
    stepId: TRAP,
    stepIndex: 1,
    label: "Plant a decoy control",
    hazardType: "insert_decoy",
    tier: "basic",
    checkpoint: 1,
    checkpointLabel: "Cart",
    appliedAt: T + appliedOffset,
    expiredAt: null,
    progressedAt: null,
    reaction: label,
    timeLostMs: null,
    actionsInWindow: 2,
    errorsInWindow: 0,
    deceived: label === "deceived",
    firstResponse: null,
    explanation: `${label} at the decoy`,
    score: 50,
    evidence: {
      before: { key: `${TRAP}-before`, capturedAt: T + appliedOffset - 1_000, contentType: "image/jpeg" },
      after: null,
      replayOffsetSec: 12,
    },
  };
}

function agentEvaluation(index: number, overrides: Partial<AgentEvaluation> = {}): AgentEvaluation {
  return {
    racerId: `racer-${index + 1}`,
    agent: { ...AGENTS[index] },
    outcome: "stopped",
    success: false,
    durationMs: null,
    checkpointsReached: 1,
    checkpointCount: 3,
    steps: 4,
    maxSteps: 20,
    errors: 1,
    loops: 0,
    paceMs: 10_000,
    sabotage: [],
    robustness: null,
    summary: "Stopped when the fight ended.",
    crowd: { openingYes: 0.25, beforeFirstHitYes: 0.3, afterFirstHitYes: 0.2, finalYes: 0.1 },
    trace: [],
    steel: { traceAvailable: false, replayAvailable: false, trace: [] },
    ...overrides,
  };
}

export function goldenEvaluation(): FightEvaluation {
  return {
    raceId: RACE_ID,
    number: 7,
    title: "Golden fight",
    task: TASK,
    courseId: "course-g",
    mode: "live",
    status: "final",
    generatedAt: T + 40_000,
    startedAt: T,
    finishedAt: T + 40_000,
    winnerRacerId: "racer-1",
    voided: false,
    sabotageSteps: [{
      stepId: TRAP,
      index: 1,
      label: "Plant a decoy control",
      hazardType: "insert_decoy",
      tier: "basic",
      checkpoint: 1,
      checkpointLabel: "Cart",
    }],
    agents: [
      agentEvaluation(0, {
        outcome: "won", success: true, durationMs: 40_000, checkpointsReached: 3, steps: 8,
        robustness: 55, sabotage: [reaction("deceived", 10_000)],
      }),
      agentEvaluation(1, { sabotage: [reaction("recovered", 11_000)], robustness: 80 }),
      agentEvaluation(2, { sabotage: [reaction("stalled", 12_000)], robustness: 25 }),
      agentEvaluation(3, { checkpointsReached: 0, steps: 2 }),
    ],
    findings: [],
  };
}

export const SCREENSHOTS = {
  r1s1: "assets/race-g/racer-1/step-0001.jpg",
  r1s2: "assets/race-g/racer-1/step-0002.jpg",
  r1s3: "assets/race-g/racer-1/step-0003.jpg",
  r3s2: "assets/race-g/racer-3/step-0002.svg",
} as const;
export const TRACES = {
  r1: "steel/race-g/racer-1.trace.json",
  r2: "steel/race-g/racer-2.trace.json",
} as const;

export function goldenRecord(): FightDatasetRecord {
  return {
    schemaVersion: 1,
    raceId: RACE_ID,
    fightNumber: 7,
    title: "Golden fight",
    mode: "live",
    task: {
      text: TASK,
      courseId: "course-g",
      seed: "seed-g",
      checkpointLabels: ["Cart", "Shipping", "Payment"],
      checkpointCount: 3,
    },
    startedAt: T,
    finishedAt: T + 40_000,
    evaluation: goldenEvaluation(),
    events: goldenEvents(),
    agents: [
      {
        racerId: "racer-1",
        agent: { ...AGENTS[0] },
        steps: racer1Steps(),
        screenshots: { 1: SCREENSHOTS.r1s1, 2: SCREENSHOTS.r1s2, 3: SCREENSHOTS.r1s3 },
        steelEvents: R1_STEEL_OFFSETS.map((offset) => steelEvent(offset)),
        steelTraceFile: TRACES.r1,
      },
      {
        racerId: "racer-2",
        agent: { ...AGENTS[1] },
        steps: racer2Steps(),
        screenshots: {},
        steelEvents: [],
        // Steel was read and returned no events: an empty trace is still a file.
        steelTraceFile: TRACES.r2,
      },
      {
        racerId: "racer-3",
        agent: { ...AGENTS[2] },
        steps: racer3Steps(),
        screenshots: { 2: SCREENSHOTS.r3s2 },
        steelEvents: [],
        steelTraceFile: null,
      },
      {
        racerId: "racer-4",
        agent: { ...AGENTS[3] },
        steps: racer4Steps(),
        screenshots: {},
        steelEvents: [],
        steelTraceFile: null,
      },
    ],
  };
}

export function jpeg(marker: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, marker, 0xff, 0xd9]);
}

/** The golden fight's bundle files. */
export function goldenFiles(): DatasetFileInput[] {
  return [
    { path: SCREENSHOTS.r1s1, contentType: "image/jpeg", body: jpeg(1) },
    { path: SCREENSHOTS.r1s2, contentType: "image/jpeg", body: jpeg(2) },
    { path: SCREENSHOTS.r1s3, contentType: "image/jpeg", body: jpeg(3) },
    { path: SCREENSHOTS.r3s2, contentType: "image/svg+xml", body: "<svg>racer-3 step 2</svg>" },
    { path: TRACES.r1, contentType: "application/json", body: JSON.stringify(RAW_TRACE) },
    { path: TRACES.r2, contentType: "application/json", body: "[]" },
  ];
}

/** The golden fight under another raceId, mode and finish time, with no bundle files. */
export function variant(
  raceId: string,
  finishedAt: number,
  mode: ServerMode,
  generatedAt = finishedAt,
): FightDatasetRecord {
  const record = goldenRecord();
  record.raceId = raceId;
  record.mode = mode;
  record.finishedAt = finishedAt;
  record.evaluation = { ...record.evaluation, raceId, mode, finishedAt, generatedAt };
  for (const agent of record.agents) {
    agent.screenshots = {};
    agent.steelTraceFile = null;
  }
  return record;
}
