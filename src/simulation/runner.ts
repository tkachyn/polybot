import type { AgentIdentity, HazardType } from "../api/dto.js";
import type {
  AgentActionReport,
  CompetitorAgentRunner,
  CompetitorContext,
} from "../application/contracts.js";
import { effectLabelFor, type SimPage, type SimTemplate } from "./catalogue.js";
import { renderSimFrame } from "./frames.js";
import {
  SIM_MAX_STEPS,
  STEP_DELAY_MAX_MS,
  STEP_DELAY_MIN_MS,
  type FightPlan,
  type RacerPlan,
} from "./plan.js";
import { Rng } from "./rng.js";
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

type StepReport = { kind: "action" | "error"; text: string; error?: string; signature?: string };

/** Texts for a step spent fighting an active sabotage. */
export function blockedStep(
  hazardType: HazardType,
  page: SimPage,
  effectLabel: string,
  attempt: number,
): StepReport {
  const target = page.target;
  const options: StepReport[] = (() => {
    switch (hazardType) {
      case "blocking_modal":
        return [
          { kind: "error", text: `click "${target}"`, error: "click intercepted by an overlay" },
          { kind: "action", text: `look for a close button on "${effectLabel}"` },
          { kind: "action", text: "press Escape to dismiss the overlay" },
          { kind: "action", text: "click \"No thanks\" on the modal" },
        ];
      case "insert_decoy":
        return [
          { kind: "action", text: `click "${effectLabel}"` },
          { kind: "error", text: `expected "${page.heading}"`, error: "landed on an unrelated sign-up page" },
          { kind: "action", text: "navigate back to the previous page" },
          { kind: "action", text: `compare "${effectLabel}" with "${target}"` },
        ];
      case "temporary_disable":
        return [
          { kind: "error", text: `click "${target}"`, error: "button is disabled" },
          { kind: "action", text: `wait for "${target}" to become enabled`, signature: `wait:${target}` },
          { kind: "action", text: `wait for "${target}" to become enabled`, signature: `wait:${target}` },
          { kind: "action", text: "re-check the form for validation errors" },
        ];
      case "rename_control":
        return [
          { kind: "action", text: `search the page for "${target}"` },
          { kind: "error", text: `click "${target}"`, error: "no control with that label" },
          { kind: "action", text: `inspect the "${effectLabel}" button` },
          { kind: "action", text: "read the surrounding page copy" },
        ];
      case "move_primary_action":
      default:
        return [
          { kind: "error", text: `click "${target}" at its usual position`, error: "no element at that point" },
          { kind: "action", text: `scroll to find "${target}"` },
          { kind: "action", text: `locate "${target}" in the page footer` },
          { kind: "action", text: "take a fresh page snapshot" },
        ];
    }
  })();
  return options[attempt % options.length];
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
 * Seeded stand-in for a browser agent. Each racer steps through the course,
 * reporting actions and SVG frames, and advances only through the real
 * reportCheckpoint/reportFinish callbacks.
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

  private async loop(context: CompetitorContext, signal: AbortSignal): Promise<void> {
    const { template, world, timeScale } = this.options;
    const racerId = context.racerId;
    const plan = this.planFor(racerId);
    const rng = new Rng(`${this.options.seed}/run/${racerId}`);
    const stageCount = template.stages.length;
    let step = 0;

    const report = (
      page: SimPage,
      stageNumber: number,
      entry: StepReport,
      disruption: { hazardType: HazardType; effectLabel: string } | null,
    ): void => {
      step += 1;
      const action: AgentActionReport = {
        kind: entry.kind,
        text: entry.text,
        url: page.url,
        step,
        maxSteps: this.maxSteps,
        signature: entry.signature ?? entry.text,
      };
      if (entry.error) action.error = entry.error;
      context.reportAction?.(action);
      const shown = entry.error ? `${entry.text} (${entry.error})` : entry.text;
      this.reportFrame(context, page, stageNumber, step, shown, disruption, "working");
    };

    for (let stage = 0; stage <= stageCount; stage += 1) {
      const page = stage < stageCount ? template.stages[stage] : template.finish;
      const stageNumber = stage + 1;
      let remaining = plan.stepsPerStage[stage] ?? 2;
      let actionIndex = 0;
      const loopAt = rng.chance(plan.loopRate) ? rng.int(0, Math.max(0, remaining - 1)) : -1;
      let looped = false;
      let loopLeft = 0;
      let blockedAttempts = 0;
      let lastHazard: { hazardType: HazardType; intensity: number } | null = null;
      let recoverySteps = 0;

      while (remaining > 0) {
        const delay = rng.range(STEP_DELAY_MIN_MS, STEP_DELAY_MAX_MS) * plan.speed / timeScale;
        await sleep(delay, signal);
        if (signal.aborted) return;

        if (step >= this.maxSteps) {
          context.reportAction?.({
            kind: "note",
            text: "Step budget exhausted; waiting for the referee",
            url: page.url,
            step,
            maxSteps: this.maxSteps,
          });
          this.reportFrame(context, page, stageNumber, step, "step budget exhausted", null, "idle");
          await untilAborted(signal);
          return;
        }
        if (plan.failAtStep !== null && step + 1 >= plan.failAtStep) {
          report(page, stageNumber, {
            kind: "error",
            text: "take page snapshot",
            error: "browser context lost",
          }, null);
          this.reportFrame(context, page, stageNumber, step, "browser context lost", null, "failed");
          throw new Error("simulated agent crashed: browser context lost");
        }

        const disruption = world.disruption(racerId);
        if (disruption) {
          const hazardType = disruption.policy.hazardType;
          const effect = {
            hazardType,
            effectLabel: effectLabelFor(template, hazardType, page),
          };
          report(page, stageNumber, blockedStep(hazardType, page, effect.effectLabel, blockedAttempts), effect);
          blockedAttempts += 1;
          lastHazard = { hazardType, intensity: disruption.policy.intensity };
          continue;
        }
        if (lastHazard) {
          recoverySteps = Math.max(0, lastHazard.intensity - 1);
          lastHazard = null;
          blockedAttempts = 0;
          report(page, stageNumber, { kind: "action", text: `resume: "${page.target}" is usable again` }, null);
          continue;
        }
        if (recoverySteps > 0) {
          recoverySteps -= 1;
          report(page, stageNumber, { kind: "action", text: "re-check the page state after the disruption" }, null);
          continue;
        }
        if (loopLeft > 0) {
          loopLeft -= 1;
          report(page, stageNumber, {
            kind: "action",
            text: `click "${page.target}" (no visible change)`,
            signature: `loop:${page.targetRole}`,
          }, null);
          continue;
        }
        if (!looped && actionIndex === loopAt) {
          looped = true;
          loopLeft = rng.int(2, 3);
          report(page, stageNumber, {
            kind: "action",
            text: `click "${page.target}" (no visible change)`,
            signature: `loop:${page.targetRole}`,
          }, null);
          continue;
        }

        const text = page.actions[actionIndex % page.actions.length] ?? `click "${page.target}"`;
        if (rng.chance(plan.errorRate)) {
          report(page, stageNumber, {
            kind: "error",
            text,
            error: rng.pick(["element not interactable", "timed out waiting for selector", "stale element reference"]),
          }, null);
          continue;
        }
        report(page, stageNumber, { kind: "action", text }, null);
        actionIndex += 1;
        remaining -= 1;
      }

      if (stage < stageCount) {
        const checkpoint = stage + 1;
        if (!await this.reportProgress(() => context.reportCheckpoint(checkpoint), signal)) return;
      } else {
        if (!await this.reportProgress(() => context.reportFinish(), signal)) return;
        this.reportFrame(context, page, stageNumber, step, "final task state verified", null, "finished");
        return;
      }
      if (signal.aborted) return;
    }
  }

  /**
   * Reports a checkpoint or the finish. The engine rejects progress while the
   * racer is still recovering from the sabotage, so this waits and retries
   * until the coordinator has recovered it. False when stopped meanwhile.
   */
  private async reportProgress(
    report: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<boolean> {
    const retryMs = Math.max(5, RECOVERY_RETRY_MS / this.options.timeScale);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await report();
        return true;
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
