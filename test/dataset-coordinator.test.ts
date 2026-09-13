import assert from "node:assert/strict";
import test from "node:test";
import type { DatasetAction, StepObservation } from "../src/api/dto.js";
import type {
  AgentActionReport,
  CompetitorAgentRunner,
  CompetitorContext,
  CourseVerifier,
  RacerSessionHandle,
  RacerSessionManager,
} from "../src/application/contracts.js";
import { RaceCoordinator, type RaceCoordinatorDependencies } from "../src/application/race-coordinator.js";
import { buildDatasetRows } from "../src/dataset/build.js";
import { InMemoryDatasetStore, type DatasetStore } from "../src/dataset/store.js";
import type { DatasetFileInput, FightDatasetRecord } from "../src/dataset/types.js";
import type { DisruptionCommand, DisruptionResult, ObstacleProvider } from "../src/domain/types.js";
import { InMemoryRaceEventStore } from "../src/persistence/in-memory-event-store.js";

const T = 1_700_000_000_000;
const LIVE_KEY = "ste-live-key";
const DECOY: DisruptionCommand = {
  hazardType: "insert_decoy",
  targetRole: "primary-action",
  durationMs: 5_000,
  intensity: 1,
};

const PRODUCT: StepObservation = {
  url: "https://course.test/product",
  title: "Blue mug",
  text: "Blue mug $12",
  controls: [{ tag: "button", role: null, arenaRole: "primary-action", label: "Add to cart", visible: true, disabled: false }],
};
const CART: StepObservation = {
  url: "https://course.test/cart",
  title: "Cart",
  text: "Cart",
  controls: [
    { tag: "button", role: null, arenaRole: "primary-action", label: "Continue", visible: true, disabled: false },
    { tag: "button", role: null, arenaRole: "primary-action", label: "Checkout", visible: true, disabled: false },
  ],
};
const STEEL_EVENTS = [{
  timestamp: new Date(T + 11_500).toISOString(),
  type: "click",
  page: { url: "https://course.test/cart" },
  target: {
    tagName: "BUTTON",
    role: "button",
    accessibleName: "Continue",
    attributes: { id: "arena-decoy-1" },
    selector: { css: "#arena-decoy-1", id: "arena-decoy-1" },
  },
}];
/** Every other session: one page load. */
const PAGE_LOAD = [{
  timestamp: new Date(T + 500).toISOString(),
  type: "navigate",
  navigation: { url: "https://course.test/product" },
}];

class Sessions implements RacerSessionManager {
  async create(racerId: string): Promise<RacerSessionHandle> {
    return { racerId, steelSessionId: `steel-${racerId}` };
  }

  async release(): Promise<void> {}

  async releaseAll(): Promise<void> {}
}

/** A live Steel manager: it remembers each session's creating key after release. */
class SteelSessions extends Sessions {
  evidence(racerId: string): { steelSessionId: string; apiKey: string } {
    return { steelSessionId: `steel-${racerId}`, apiKey: LIVE_KEY };
  }
}

/** run() settles once stopped, like a real runner. */
class Runner implements CompetitorAgentRunner {
  private readonly stops = new Map<string, () => void>();

  constructor(private readonly prepareError?: Error) {}

  async prepare(): Promise<void> {
    if (this.prepareError) throw this.prepareError;
  }

  run(context: CompetitorContext): Promise<void> {
    return new Promise((resolve) => {
      this.stops.set(context.racerId, resolve);
    });
  }

  async stop(racerId: string): Promise<void> {
    this.stops.get(racerId)?.();
  }
}

const verifier: CourseVerifier = {
  async verifyTargetOpening() { return true; },
  async verifyCheckpoint() { return true; },
  async verifyFinish() { return true; },
};

class Obstacles implements ObstacleProvider {
  async getPolicy(): Promise<DisruptionCommand | null> {
    return DECOY;
  }

  async apply(): Promise<DisruptionResult> {
    return { applied: true };
  }
}

class CountingDatasetStore extends InMemoryDatasetStore {
  puts = 0;

  override async put(record: FightDatasetRecord, files: readonly DatasetFileInput[]): Promise<void> {
    this.puts += 1;
    await super.put(record, files);
  }
}

type Setup = {
  store: DatasetStore;
  mode?: "live" | "simulated";
  steelFetch?: typeof fetch;
  runner?: Runner;
  /** Steel read timing. */
  steel?: Pick<RaceCoordinatorDependencies, "steelEvidenceTimeoutMs" | "steelEvidenceRetryMs" | "steelBackfillDelaysMs">;
};

/** Three checkpoints; a fixed decoy fires at checkpoint 2. */
function setup({ store, mode = "simulated", steelFetch, runner = new Runner(), steel }: Setup): RaceCoordinator {
  return new RaceCoordinator(
    {
      raceId: "race-data",
      courseId: "course-data",
      seed: "seed-data",
      checkpointCount: 3,
      task: "Buy the blue mug and check out",
      fight: {
        createdAt: T - 60_000,
        checkpointLabels: ["Cart", "Shipping", "Payment"],
        sabotage: { checkpoint: 2, summary: "Decoy at shipping", policy: DECOY },
      },
    },
    {
      sessionManager: mode === "live" ? new SteelSessions() : new Sessions(),
      agentRunner: runner,
      courseVerifier: verifier,
      eventStore: new InMemoryRaceEventStore(),
      obstacleProvider: new Obstacles(),
      datasetStore: store,
      mode,
      steelFetch,
      ...steel,
    },
  );
}

function report(
  step: number,
  action: DatasetAction,
  observation: StepObservation,
  observedAt: number,
  extra: Partial<AgentActionReport> = {},
): AgentActionReport {
  return {
    kind: "action",
    text: `step ${step}`,
    step,
    maxSteps: 20,
    signature: JSON.stringify(action),
    observation,
    action,
    observedAt,
    decidedAt: observedAt + 300,
    ...extra,
  };
}

/** racer-1 is hit at +10 s, clicks the decoy, repairs the page and wins at +25 s. */
async function playWin(coordinator: RaceCoordinator, frames: "image/jpeg" | "image/svg+xml"): Promise<void> {
  const frame = (step: number, at: number) => coordinator.recordAgentFrame("racer-1", {
    contentType: frames,
    body: frames === "image/jpeg" ? Buffer.from([0xff, 0xd8, step, 0xff, 0xd9]) : `<svg>${step}</svg>`,
    capturedAt: at,
    step,
  }, at);
  frame(1, T + 1_000);
  coordinator.recordAgentAction("racer-1", report(1, { type: "click", targetRole: "primary-action", label: "Add to cart" }, PRODUCT, T + 1_000, {
    reasoning: "Add the mug to the cart.",
  }), T + 2_000);
  await coordinator.recordCheckpoint("racer-1", 1, T + 3_000);
  frame(2, T + 8_000);
  coordinator.recordAgentAction("racer-1", report(2, { type: "click", targetRole: "primary-action", label: "Checkout" }, CART, T + 8_000), T + 9_000);
  await coordinator.recordCheckpoint("racer-1", 2, T + 10_000);
  frame(3, T + 11_000);
  coordinator.recordAgentAction("racer-1", report(3, { type: "click", targetRole: "primary-action", label: "Continue" }, CART, T + 11_000, {
    evidence: { target: { role: "primary-action", text: "Continue", decoy: true } },
  }), T + 12_000);
  // As the runner does: the recovery is reported during the repairing step, before the step itself.
  await coordinator.recordRecovery("racer-1", T + 12_900);
  coordinator.recordAgentAction("racer-1", report(4, { type: "evaluate", script: "window.__arenaRecoverDisruptions?.()" }, CART, T + 12_500, {
    reasoning: "Remove the decoy.",
    evidence: { clearedSabotage: true },
  }), T + 13_000);
  await coordinator.recordCheckpoint("racer-1", 3, T + 20_000);
  await coordinator.recordFinish("racer-1", T + 25_000);
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The Steel backfill runs on real timers: waits until `done()` holds. */
async function until(done: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the Steel backfill");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a closed live fight is stored once: steps, step screenshots and the Steel trace it already read", async () => {
  const store = new CountingDatasetStore();
  const calls: string[] = [];
  const steelFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname.endsWith("/hls")) {
      return new Response("#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2023-11-14T22:13:10.000Z\n#EXT-X-ENDLIST\n");
    }
    const events = url.pathname.includes("/steel-racer-1/") ? STEEL_EVENTS : PAGE_LOAD;
    return Response.json({ events, total: events.length, hasMore: false });
  }) as typeof fetch;
  const coordinator = setup({ store, mode: "live", steelFetch });
  await coordinator.prepareAndStart(T);
  await playWin(coordinator, "image/jpeg");

  const final = await coordinator.whenEvaluationFinal();
  await settle();
  assert.equal(store.puts, 1);
  assert.equal(calls.length, 8, "Steel traces and HLS once per session, shared by the evaluation and the dataset");
  const [record] = await store.list();
  assert.deepEqual(
    [record.raceId, record.fightNumber, record.mode, record.startedAt, record.finishedAt],
    ["race-data", final.number, "live", T, T + 25_000],
  );
  assert.deepEqual(record.task, {
    text: "Buy the blue mug and check out",
    courseId: "course-data",
    seed: "seed-data",
    checkpointLabels: ["Cart", "Shipping", "Payment"],
    checkpointCount: 3,
  });
  assert.deepEqual(record.evaluation, final);
  assert.ok(record.events.some((event) => event.type === "sabotage_applied" && event.racerId === "racer-1"));
  assert.deepEqual(record.agents.map((agent) => agent.racerId), ["racer-1", "racer-2", "racer-3", "racer-4"]);

  const gpt = record.agents[0];
  assert.deepEqual(gpt.steps.map((step) => step.step), [1, 2, 3, 4]);
  assert.deepEqual(gpt.steps[0].observation, PRODUCT);
  assert.equal(gpt.steps[0].reasoning, "Add the mug to the cart.");
  assert.deepEqual([gpt.steps[0].observedAt, gpt.steps[0].decidedAt, gpt.steps[0].actedAt], [T + 1_000, T + 1_300, T + 2_000]);
  assert.deepEqual(gpt.screenshots, {
    1: "assets/race-data/racer-1/step-0001.jpg",
    2: "assets/race-data/racer-1/step-0002.jpg",
    3: "assets/race-data/racer-1/step-0003.jpg",
  });
  assert.deepEqual((await store.readFile(gpt.screenshots[2]))?.body, Buffer.from([0xff, 0xd8, 2, 0xff, 0xd9]));
  assert.equal(gpt.steelTraceFile, "steel/race-data/racer-1.trace.json");
  const trace = await store.readFile(gpt.steelTraceFile);
  assert.deepEqual(JSON.parse(trace?.body.toString("utf8") ?? "null"), STEEL_EVENTS);
  assert.deepEqual(gpt.steelEvents.map((event) => [event.type, event.label, event.decoy]), [["click", "Continue", true]]);
  assert.equal(record.agents[1].steelTraceFile, "steel/race-data/racer-2.trace.json");
  const pageLoad = await store.readFile("steel/race-data/racer-2.trace.json");
  assert.deepEqual(JSON.parse(pageLoad?.body.toString("utf8") ?? "null"), PAGE_LOAD);
  assert.deepEqual(record.agents[1].steps, []);

  // The rows derive from the stored record.
  const rows = buildDatasetRows([record], { now: T + 60_000, days: 1, mode: "live" });
  assert.equal(rows.episodes.length, 4);
  const decoy = rows.steps.find((step) => step.id === "race-data:racer-1:3");
  assert.equal(decoy?.hazard?.hazardType, "insert_decoy");
  assert.equal(decoy?.labels.quality, "harmful");
  assert.equal(decoy?.labels.reaction, final.agents[0].sabotage[0].reaction);
  assert.deepEqual(decoy?.steel.map((event) => event.label), ["Continue"]);
  assert.deepEqual(rows.preferences.map((pair) => pair.id), [
    "self-correction:race-data:racer-1:3>race-data:racer-1:4",
  ]);

  await coordinator.tick(T + 400_000);
  await coordinator.shutdown();
  await settle();
  assert.equal(store.puts, 1, "stored exactly once");
});

test("a live fight is stored again, with its Steel traces, when Steel publishes them after the fight", async () => {
  const store = new CountingDatasetStore();
  let published = false;
  const steelFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/hls")) {
      return new Response("#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2023-11-14T22:13:10.000Z\n#EXT-X-ENDLIST\n");
    }
    // A released session's traces read as empty until Steel publishes them.
    const racerOne = url.pathname.includes("/steel-racer-1/");
    const events = published ? (racerOne ? STEEL_EVENTS : PAGE_LOAD) : [];
    return Response.json({ events, total: events.length, hasMore: false });
  }) as typeof fetch;
  const coordinator = setup({
    store,
    mode: "live",
    steelFetch,
    steel: { steelEvidenceTimeoutMs: 200, steelEvidenceRetryMs: 50, steelBackfillDelaysMs: [20, 60] },
  });
  await coordinator.prepareAndStart(T);
  await playWin(coordinator, "image/jpeg");

  const first = await coordinator.whenEvaluationFinal();
  published = true;
  const [stored] = await store.list();
  assert.equal(store.puts, 1);
  assert.deepEqual(stored.evaluation, first);
  assert.ok(stored.agents.every((agent) => agent.steelEvents.length === 0));
  assert.equal(stored.agents[0].steelTraceFile, "steel/race-data/racer-1.trace.json", "an empty trace is still a file");
  const emptyTrace = await store.readFile("steel/race-data/racer-1.trace.json");
  assert.deepEqual(JSON.parse(emptyTrace?.body.toString("utf8") ?? "null"), []);

  await until(() => store.puts === 2);
  const [record] = await store.list();
  const updated = coordinator.evaluation();
  assert.equal(updated.status, "final");
  assert.deepEqual(updated.agents[0].steel.trace.map((entry) => entry.label), ["Continue"]);
  assert.deepEqual(record.evaluation, updated, "the record carries the updated final evaluation");
  const gpt = record.agents[0];
  assert.deepEqual(gpt.steelEvents.map((event) => [event.type, event.label, event.decoy]), [["click", "Continue", true]]);
  const trace = await store.readFile("steel/race-data/racer-1.trace.json");
  assert.deepEqual(JSON.parse(trace?.body.toString("utf8") ?? "null"), STEEL_EVENTS);
  assert.deepEqual(record.agents[1].steelEvents.map((event) => event.type), ["navigate"]);
  // The rest of the record is kept, step screenshots included.
  assert.deepEqual([gpt.steps, gpt.screenshots], [stored.agents[0].steps, stored.agents[0].screenshots]);
  assert.deepEqual((await store.readFile(gpt.screenshots[2]))?.body, Buffer.from([0xff, 0xd8, 2, 0xff, 0xd9]));
  assert.deepEqual(record.events, stored.events);

  // The per-step Steel slices derive from the new record.
  const rows = buildDatasetRows([record], { now: T + 60_000, days: 1, mode: "live" });
  const decoy = rows.steps.find((step) => step.id === "race-data:racer-1:3");
  assert.deepEqual(decoy?.steel.map((event) => event.label), ["Continue"]);
  await coordinator.shutdown();
});

test("a simulated fight is stored with SVG step screenshots and no Steel data", async () => {
  const store = new CountingDatasetStore();
  const coordinator = setup({ store });
  await coordinator.prepareAndStart(T);
  await playWin(coordinator, "image/svg+xml");
  await coordinator.whenEvaluationFinal();
  const [record] = await store.list();
  assert.equal(record.mode, "simulated");
  assert.equal(record.agents[0].screenshots[1], "assets/race-data/racer-1/step-0001.svg");
  assert.equal((await store.readFile(record.agents[0].screenshots[1]))?.body.toString(), "<svg>1</svg>");
  assert.ok(record.agents.every((agent) => agent.steelTraceFile === null && agent.steelEvents.length === 0));
});

test("a failing dataset store never breaks the race or holds up the final evaluation", async () => {
  const failures: Record<string, () => Promise<void>> = {
    rejects: () => Promise.reject(new Error("disk full")),
    throws: () => {
      throw new Error("boom");
    },
    hangs: () => new Promise<void>(() => undefined),
  };
  for (const [name, fail] of Object.entries(failures)) {
    let puts = 0;
    const store: DatasetStore = {
      put: () => {
        puts += 1;
        return fail();
      },
      list: async () => [],
      readFile: async () => null,
    };
    const coordinator = setup({ store });
    await coordinator.prepareAndStart(T);
    await playWin(coordinator, "image/svg+xml");
    const final = await coordinator.whenEvaluationFinal();
    assert.equal(final.status, "final", name);
    assert.equal(coordinator.evaluationPointer?.status, "final", name);
    await coordinator.tick(T + 400_000);
    await coordinator.shutdown();
    await settle();
    assert.equal(puts, 1, `${name}: attempted exactly once`);
  }
});

test("a fight that never started stores nothing", async () => {
  const store = new CountingDatasetStore();
  const coordinator = setup({ store, runner: new Runner(new Error("steel unavailable")) });
  await assert.rejects(coordinator.prepareAndStart(T), /steel unavailable/);
  await settle();
  assert.equal(store.puts, 0);
});
