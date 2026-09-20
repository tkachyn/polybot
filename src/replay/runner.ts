/**
 * Replays one recorded fight through the real coordinator.
 *
 * A recorded racer is a list of steps with the times they happened, and the
 * engine events that say when its progress was verified. This walks that
 * timeline at the original pace: it reports each step (the model's own text,
 * action, reasoning and browser evidence), pushes the screenshot taken with
 * it, and claims each checkpoint and the finish where the recording did.
 *
 * Nothing here talks to a browser or a model. Progress still goes through
 * reportCheckpoint/reportFinish, so the engine, market, ledger and evaluation
 * behave exactly as they do for a live fight.
 */
import type {
  AgentActionReport,
  CompetitorAgentRunner,
  CompetitorContext,
} from "../application/contracts.js";
import type { StepRecord } from "../application/race-telemetry.js";
import type { DatasetStore } from "../dataset/store.js";
import type { FightDatasetAgent } from "../dataset/types.js";
import type { ReplayRecording } from "./library.js";

/** Fallback gap when a recording has no usable time between two steps. */
const DEFAULT_STEP_GAP_MS = 1_200;
/** No single gap holds the replay longer than this, however long the original pause was. */
const MAX_STEP_GAP_MS = 12_000;

export type ReplayRunnerOptions = {
  recording: ReplayRecording;
  /** Reads the recorded screenshots; omit to replay without frames. */
  store?: DatasetStore;
  /** 1 is the original pace; 2 replays twice as fast. Default 1. */
  timeScale?: number;
};

/** What the replay does next for one racer, in recorded order. */
type TimelineEntry =
  | { at: number; kind: "step"; step: StepRecord }
  | { at: number; kind: "checkpoint"; checkpoint: number }
  | { at: number; kind: "finish" };

/** Resolves after `ms`, or as soon as the signal aborts. Leaves no timer behind. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** The recorded step as the telemetry expects it. */
function reportFor(step: StepRecord, maxSteps: number): AgentActionReport {
  return {
    kind: step.kind,
    text: step.text,
    step: step.step,
    maxSteps,
    ...(step.url === null ? {} : { url: step.url }),
    ...(step.signature === null ? {} : { signature: step.signature }),
    ...(step.error === null ? {} : { error: step.error }),
    ...(step.modelError === null ? {} : { modelError: step.modelError }),
    ...(step.observation === null ? {} : { observation: step.observation }),
    ...(step.action === null ? {} : { action: step.action }),
    ...(step.reasoning === null ? {} : { reasoning: step.reasoning }),
    ...(step.decisionIssue === null ? {} : { decisionIssue: step.decisionIssue }),
    evidence: {
      ...(step.evidence.target === null ? {} : { target: step.evidence.target }),
      ...(step.evidence.blockedBy === null ? {} : { blockedBy: step.evidence.blockedBy }),
      ...(step.evidence.cursor === null ? {} : { cursor: step.evidence.cursor }),
      navigated: step.evidence.navigated,
      clearedSabotage: step.evidence.clearedSabotage,
    },
  };
}

/**
 * The racer's recorded steps, checkpoints and finish in one ordered list.
 * Checkpoints and the finish come from the engine events, which are the only
 * record of when progress was actually verified.
 */
export function timelineFor(recording: ReplayRecording, agent: FightDatasetAgent): TimelineEntry[] {
  const entries: TimelineEntry[] = agent.steps.map((step) => ({
    at: step.actedAt,
    kind: "step" as const,
    step,
  }));
  for (const event of recording.events) {
    if (event.racerId !== agent.racerId) continue;
    if (event.type === "checkpoint_reached" && typeof event.checkpoint === "number") {
      entries.push({ at: event.occurredAt, kind: "checkpoint", checkpoint: event.checkpoint });
    }
    if (event.type === "racer_finished") {
      entries.push({ at: event.occurredAt, kind: "finish" });
    }
  }
  // A checkpoint verified at the same instant as the step that earned it must
  // come after it, so the step that cleared a hazard is reported first.
  const rank = { step: 0, checkpoint: 1, finish: 2 };
  return entries.sort((left, right) => left.at - right.at || rank[left.kind] - rank[right.kind]);
}

export class ReplayCompetitorRunner implements CompetitorAgentRunner {
  private readonly controllers = new Map<string, AbortController>();
  private readonly stopped = new Set<string>();
  private readonly agents = new Map<string, FightDatasetAgent>();
  private readonly timeScale: number;
  readonly maxSteps: number;

  constructor(private readonly options: ReplayRunnerOptions) {
    this.timeScale = options.timeScale && options.timeScale > 0 ? options.timeScale : 1;
    for (const agent of options.recording.agents) this.agents.set(agent.racerId, agent);
    this.maxSteps = Math.max(
      1,
      ...options.recording.evaluation.agents.map((agent) => agent.maxSteps || 0),
    );
  }

  async prepare(context: Omit<CompetitorContext, "reportCheckpoint" | "reportFinish">): Promise<void> {
    const agent = this.agents.get(context.racerId);
    const first = agent?.steps[0];
    context.reportAction?.({
      kind: "note",
      text: first?.url ? `open ${first.url}` : "waiting for the start",
      step: 0,
      maxSteps: this.maxSteps,
      ...(first?.url ? { url: first.url } : {}),
    });
    if (agent) await this.sendFrame(context, agent, first?.step);
  }

  async run(context: CompetitorContext): Promise<void> {
    const racerId = context.racerId;
    if (this.stopped.has(racerId)) return;
    const agent = this.agents.get(racerId);
    if (!agent) return;
    const controller = new AbortController();
    this.controllers.set(racerId, controller);
    try {
      await this.loop(context, agent, controller.signal);
    } finally {
      if (this.controllers.get(racerId) === controller) this.controllers.delete(racerId);
    }
  }

  async stop(racerId: string): Promise<void> {
    this.stopped.add(racerId);
    this.controllers.get(racerId)?.abort();
  }

  private async loop(
    context: CompetitorContext,
    agent: FightDatasetAgent,
    signal: AbortSignal,
  ): Promise<void> {
    const timeline = timelineFor(this.options.recording, agent);
    let previous: number | null = null;

    for (const entry of timeline) {
      if (signal.aborted) return;
      await sleep(this.gapFor(previous, entry.at), signal);
      if (signal.aborted) return;
      previous = entry.at;

      if (entry.kind === "step") {
        context.reportAction?.(reportFor(entry.step, this.maxSteps));
        await this.sendFrame(context, agent, entry.step.step);
        // The engine holds progress until the racer's hazard is cleared, and
        // only the step that cleared it lifts that gate.
        if (entry.step.evidence.clearedSabotage) await context.reportRecovery?.();
        continue;
      }
      if (entry.kind === "checkpoint") {
        if ((await context.reportCheckpoint(entry.checkpoint)) === false) return;
        continue;
      }
      if ((await context.reportFinish()) === false) return;
      return;
    }
  }

  /** The recorded pause before this entry, scaled and capped. */
  private gapFor(previous: number | null, at: number): number {
    if (previous === null) return 0;
    const gap = Number.isFinite(at - previous) ? at - previous : DEFAULT_STEP_GAP_MS;
    return Math.min(Math.max(0, gap), MAX_STEP_GAP_MS) / this.timeScale;
  }

  /** Pushes the screenshot recorded with this step, when there is one. */
  private async sendFrame(
    context: Omit<CompetitorContext, "reportCheckpoint" | "reportFinish">,
    agent: FightDatasetAgent,
    step: number | undefined,
  ): Promise<void> {
    if (!context.reportFrame || !this.options.store || step === undefined) return;
    const path = agent.screenshots[step];
    if (!path) return;
    const file = await this.options.store.readFile(path).catch(() => null);
    if (!file) return;
    const contentType = file.contentType === "image/png" || file.contentType === "image/svg+xml"
      ? file.contentType
      : "image/jpeg";
    context.reportFrame({ contentType, body: file.body, step });
  }
}
