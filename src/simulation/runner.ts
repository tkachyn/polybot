import type { AgentIdentity, HazardType } from "../api/dto.js";
import type {
  CompetitorAgentRunner,
  CompetitorContext,
} from "../application/contracts.js";
import { effectLabelFor, type SimPage, type SimTemplate } from "./catalogue.js";
import { renderSimFrame } from "./frames.js";
import { SIM_MAX_STEPS, type FightPlan, type RacerPlan } from "./plan.js";
import { Rng } from "./rng.js";
import {
  SimRacerScript,
  actionReport,
  stepCaption,
  type ScriptHazard,
  type ScriptStep,
  type SimStepContext,
} from "./script.js";

type StepTiming = Omit<SimStepContext, "brand">;
import type { SimulatedWorld } from "./world.js";

type PrepareContext = Omit<CompetitorContext, "reportCheckpoint" | "reportFinish">;

/** Unscaled wait between progress reports while the racer is recovering. */
const RECOVERY_RETRY_MS = 500;
/** Covers the longest sabotage (30 s) at any time scale. */
const RECOVERY_MAX_RETRIES = 120;

/** Resolves after `ms`, or as soon as the signal aborts. Leaves no timer behind. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
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

/** Resolves only when the signal aborts. */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export type SimulatedRunnerOptions = {
  /** Fitted to the fight's checkpoint count. */
  template: SimTemplate;
  world: SimulatedWorld;
  plan: FightPlan;
  /** Agent identity per racerId. */
  agents: Record<string, AgentIdentity>;
  timeScale: number;
  seed: string;
  maxSteps?: number;
};

/**
 * Seeded stand-in for a browser agent. Each racer follows its SimRacerScript
 * through the course, reporting actions (with browser evidence) and SVG
 * frames, and advances only through the real reportCheckpoint/reportFinish
 * callbacks.
 */
export class SimulatedCompetitorRunner implements CompetitorAgentRunner {
  private readonly controllers = new Map<string, AbortController>();
  private readonly stopped = new Set<string>();
  private readonly maxSteps: number;

  constructor(private readonly options: SimulatedRunnerOptions) {
    if (!Number.isFinite(options.timeScale) || options.timeScale <= 0) {
      throw new Error("timeScale must be a positive number");
    }
    this.maxSteps = options.maxSteps ?? SIM_MAX_STEPS;
  }

  async prepare(context: PrepareContext): Promise<void> {
    const page = this.options.template.stages[0] ?? this.options.template.finish;
    context.reportAction?.({
      kind: "note",
      text: `open ${page.url}`,
      url: page.url,
      step: 0,
      maxSteps: this.maxSteps,
    });
    this.reportFrame(context, page, 1, 0, "waiting for the start", null, "working");
  }

  async run(context: CompetitorContext): Promise<void> {
    const racerId = context.racerId;
    if (this.stopped.has(racerId)) return;
    const controller = new AbortController();
    this.controllers.set(racerId, controller);
    try {
      await this.loop(context, controller.signal);
    } finally {
      if (this.controllers.get(racerId) === controller) {
        this.controllers.delete(racerId);
      }
    }
  }

  /** Aborts promptly. Never waits for the loop, which may be inside a callback. */
  async stop(racerId: string): Promise<void> {
    this.stopped.add(racerId);
    this.controllers.get(racerId)?.abort();
  }

  /** Racers whose loop is still running. */
  activeRacers(): string[] {
    return [...this.controllers.keys()];
  }

  private planFor(racerId: string): RacerPlan {
    const plan = this.options.plan.racers[racerId];
    if (plan) return plan;
    const stages = this.options.template.stages.length;
    return {
      racerId,
      key: racerId,
      speed: 1,
      stepsPerStage: [...Array.from({ length: stages }, () => 5), 2],
      errorRate: 0.05,
      loopRate: 0.1,
      failAtStep: null,
    };
  }

  /** The racer's active sabotage as its current page shows it. */
  private activeHazard(racerId: string, page: SimPage): ScriptHazard | null {
    const disruption = this.options.world.disruption(racerId);
    if (!disruption) return null;
    const hazardType = disruption.policy.hazardType;
    return {
      hazardType,
      intensity: disruption.policy.intensity,
      appliedAt: disruption.appliedAt,
      until: disruption.until,
      effectLabel: effectLabelFor(this.options.template, hazardType, page),
    };
  }

  private async loop(context: CompetitorContext, signal: AbortSignal): Promise<void> {
    const { template, world, timeScale } = this.options;
    const racerId = context.racerId;
    const plan = this.planFor(racerId);
    const script = new SimRacerScript(plan, template, new Rng(`${this.options.seed}/run/${racerId}`));

    const report = (entry: ScriptStep, page: SimPage, stageNumber: number, timing: StepTiming): void => {
      context.reportAction?.(
        actionReport(entry, page, script.steps, this.maxSteps, { brand: template.brand, ...timing }),
      );
      // The page as the agent read it for this step, tagged with the step.
      this.reportFrame(
        context, page, stageNumber, script.steps, stepCaption(entry), entry.disruption, "working", true,
      );
    };

    for (;;) {
      if (script.pageDone) {
        if (script.onFinishPage) {
          if (!await this.reportProgress(() => context.reportFinish(), signal)) return;
          this.reportFrame(
            context, script.page, script.stageNumber, script.steps, "final task state verified", null, "finished",
          );
          return;
        }
        const checkpoint = script.stage + 1;
        if (!await this.reportProgress(() => context.reportCheckpoint(checkpoint), signal)) return;
        if (signal.aborted) return;
        script.advance();
        continue;
      }

      // The agent reads the page, thinks for the step's delay, then acts.
      const observedAt = world.now();
      await sleep(script.nextDelay() / timeScale, signal);
      if (signal.aborted) return;
      const timing: StepTiming = { observedAt, decidedAt: world.now() };
      const page = script.page;
      const stageNumber = script.stageNumber;

      if (script.steps >= this.maxSteps) {
        context.reportAction?.({
          kind: "note",
          text: "Step budget exhausted; waiting for the referee",
          url: page.url,
          step: script.steps,
          maxSteps: this.maxSteps,
        });
        this.reportFrame(context, page, stageNumber, script.steps, "step budget exhausted", null, "idle");
        await untilAborted(signal);
        return;
      }
      if (plan.failAtStep !== null && script.steps + 1 >= plan.failAtStep) {
        report(script.crash(), page, stageNumber, timing);
        this.reportFrame(context, page, stageNumber, script.steps, "browser context lost", null, "failed");
        throw new Error("simulated agent crashed: browser context lost");
      }
      const entry = script.next(this.activeHazard(racerId, page), world.now());
      report(entry, page, stageNumber, timing);
      if (entry?.recovered) {
        world.clear(racerId);
        await context.reportRecovery?.();
      }
    }
  }

  /**
   * Reports a checkpoint or the finish. The engine rejects progress while the
   * racer is still recovering from the sabotage, so this waits and retries
   * until the coordinator has recovered it. False when stopped meanwhile.
   */
  private async reportProgress(
    report: () => Promise<boolean | void>,
    signal: AbortSignal,
  ): Promise<boolean> {
    const retryMs = Math.max(5, RECOVERY_RETRY_MS / this.options.timeScale);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return (await report()) !== false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (signal.aborted || !/while recovering/.test(message) ||
          attempt >= RECOVERY_MAX_RETRIES) {
          throw error;
        }
      }
      await sleep(retryMs, signal);
      if (signal.aborted) return false;
    }
  }

  private reportFrame(
    context: PrepareContext,
    page: SimPage,
    stageNumber: number,
    step: number,
    action: string,
    disruption: { hazardType: HazardType; effectLabel: string } | null,
    status: "working" | "finished" | "failed" | "idle",
    /** The frame shows the page the agent read for `step`: tag it with the step. */
    forStep = false,
  ): void {
    if (!context.reportFrame) return;
    const agent = this.options.agents[context.racerId];
    const stageCount = this.options.template.stages.length;
    const label = this.options.template.stages[stageNumber - 1]?.label ?? "Finish";
    context.reportFrame({
      contentType: "image/svg+xml",
      body: renderSimFrame({
        brand: this.options.template.brand,
        page,
        stageNumber,
        stageCount,
        stageLabel: label,
        agentKey: agent?.key ?? context.racerId,
        agentName: agent?.name ?? context.racerId,
        step,
        maxSteps: this.maxSteps,
        action,
        disruption,
        status,
      }),
      ...(forStep ? { step } : {}),
    });
  }
}

/**
 * Runner for seeded history fights: never acts, and run() settles only when
 * stopped. The autopilot drives these fights through the coordinator.
 */
export class InertCompetitorRunner implements CompetitorAgentRunner {
  private readonly waiters = new Map<string, () => void>();
  private readonly stopped = new Set<string>();

  async prepare(): Promise<void> {}

  run(context: CompetitorContext): Promise<void> {
    if (this.stopped.has(context.racerId)) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.set(context.racerId, resolve);
    });
  }

  async stop(racerId: string): Promise<void> {
    this.stopped.add(racerId);
    const resolve = this.waiters.get(racerId);
    this.waiters.delete(racerId);
    resolve?.();
  }

  /** Racers whose run() is still pending. */
  pendingRacers(): string[] {
    return [...this.waiters.keys()];
  }
}
