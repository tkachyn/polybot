import type { AgentIdentity } from "../api/dto.js";
import type { ApiCreateRaceInput, RaceRegistry } from "../api/race-registry.js";
import type { RaceCoordinator } from "../application/race-coordinator.js";
import { isDomainError } from "../domain/errors.js";
import type { DisruptionCommand, RaceStatus, SabotagePlan } from "../domain/types.js";
import {
  SIM_HISTORY_COURSE_ID,
  SIM_TEMPLATES,
  courseIdFor,
  fitTemplate,
  type SimTemplate,
} from "./catalogue.js";
import { SIM_AGENT_ROSTER, assertTimeScale, type SimulationOptions } from "./factory.js";
import { renderSimFrame } from "./frames.js";
import { SIM_MAX_STEPS, planFight, type FightDifficulty } from "./plan.js";
import { Rng } from "./rng.js";
import {
  actionReport,
  scriptHistoryRuns,
  stepCaption,
  type ScriptEvent,
  type ScriptSabotageStep,
  type ScriptStep,
} from "./script.js";
import { scaleDurationMs } from "./world.js";

export type SimulationAutopilotOptions = SimulationOptions & {
  liveFights?: number;
  upcomingFights?: number;
  historyFights?: number;
  bots?: boolean;
};

/** Race timing at timeScale 1 (backend defaults). */
export const SIM_TARGET_DURATION_MS = 180_000;
export const SIM_ABSOLUTE_DURATION_MS = 300_000;
export const BOT_COUNT = 12;
export const BOT_FUNDING = 5_000;
export const MAX_RESOLVED_FIGHTS = 60;
const DAY_MS = 86_400_000;
const HISTORY_SPAN_MS = 10 * DAY_MS;
const BOT_TOP_UP_BELOW = 300;
const MIN_TIMER_MS = 20;

type HistoryEvent =
  | { t: number; order: number; kind: "trade" }
  | (ScriptEvent & { order: number; racerId: string; racerIndex: number });

type HistoryStepEvent = Extract<HistoryEvent, { kind: "note" | "step" | "crash" }>;

function isLive(status: RaceStatus): boolean {
  return status === "running" || status === "hazards_frozen" || status === "finishing";
}

function isOver(coordinator: RaceCoordinator): boolean {
  const status = coordinator.engine.race.status;
  return status === "finished" || status === "timed_out";
}

/** The engine's ordered sabotage sequence; a legacy plan is one step. */
export function sabotageStepsOf(plan: SabotagePlan | undefined): ScriptSabotageStep[] {
  if (!plan) return [];
  const steps: ReadonlyArray<{ checkpoint: number; policy: DisruptionCommand }> =
    plan.steps && plan.steps.length > 0
      ? plan.steps
      : [{ checkpoint: plan.trigger.checkpoint, policy: plan.policy }];
  return steps.map((step) => ({
    checkpoint: step.checkpoint,
    hazardType: step.policy.hazardType,
    durationMs: step.policy.durationMs,
    intensity: step.policy.intensity,
  }));
}

/**
 * Keeps a simulated lobby populated: seeds resolved history, maintains live
 * and upcoming fights, and runs bot traders. Everything goes through the real
 * registry, coordinators, market and ledger.
 */
export class SimulationAutopilot {
  readonly bots: string[] = [];

  private readonly rng: Rng;
  private readonly timeScale: number;
  private readonly liveTarget: number;
  private readonly upcomingTarget: number;
  private readonly historyCount: number;
  private readonly botsEnabled: boolean;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private counter = 0;
  private refilling = false;
  private stopped = false;

  constructor(
    private readonly registry: RaceRegistry,
    private readonly options: SimulationAutopilotOptions,
  ) {
    assertTimeScale(options.timeScale);
    this.rng = new Rng(`${options.seed}/autopilot`);
    this.timeScale = options.timeScale;
    this.liveTarget = Math.max(0, Math.floor(options.liveFights ?? 2));
    this.upcomingTarget = Math.max(0, Math.floor(options.upcomingFights ?? 2));
    this.historyCount = Math.max(0, Math.floor(options.historyFights ?? 8));
    this.botsEnabled = options.bots ?? true;
  }

  /** Seeds history and the first fights, then starts the loops. */
  async start(now = Date.now()): Promise<void> {
    if (this.botsEnabled) this.createBots(now - HISTORY_SPAN_MS - DAY_MS);
    await this.seedHistory(now);
    await this.refill(now);
    this.loop(() => this.refill(Date.now()), () => Math.max(50, 1_000 / this.timeScale));
    if (this.botsEnabled) {
      this.loop(
        async () => this.tradeRound(Date.now()),
        () => this.rng.range(1_500, 4_000) / this.timeScale,
      );
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  // ------------------------------------------------------------- fights

  /** Creates immediate fights while below the live target, and upcoming ones. */
  async refill(now: number): Promise<void> {
    if (this.refilling || this.stopped) return;
    this.refilling = true;
    try {
      const races = this.registry.list();
      const active = new Set<string>();
      let live = 0;
      const scheduled: number[] = [];
      for (const race of races) {
        const status = race.engine.race.status;
        if (isLive(status)) {
          live += 1;
          active.add(race.engine.race.courseId);
        } else if (status === "starting") {
          const startsAt = this.registry.scheduledStart(race.raceId);
          if (startsAt !== null) {
            scheduled.push(startsAt);
            active.add(race.engine.race.courseId);
          }
        }
      }

      const soonWindow = 15_000 / this.timeScale;
      const startingSoon = scheduled.filter((startsAt) => startsAt <= now + soonWindow).length;
      const immediate = Math.max(0, this.liveTarget - live - startingSoon);
      for (let index = 0; index < immediate && !this.stopped; index += 1) {
        await this.createFight(now, undefined, active);
      }

      let latest = Math.max(now, ...scheduled);
      for (let count = scheduled.length; count < this.upcomingTarget && !this.stopped; count += 1) {
        latest += this.rng.range(45_000, 120_000) / this.timeScale;
        await this.createFight(now, Math.round(latest), active);
      }

      this.registry.prune(MAX_RESOLVED_FIGHTS);
    } finally {
      this.refilling = false;
    }
  }

  private async createFight(now: number, startsAt: number | undefined, active: Set<string>): Promise<void> {
    const template = this.pickTemplate(active);
    active.add(courseIdFor(template));
    const input = this.buildInput(template, { history: false, startsAt });
    try {
      await this.registry.create(input, now);
    } catch {
      // A failed start is voided by the coordinator; try again next round.
    }
  }

  private pickTemplate(active: ReadonlySet<string>): SimTemplate {
    const fresh = SIM_TEMPLATES.filter((template) => !active.has(courseIdFor(template)));
    return this.rng.pick(fresh.length > 0 ? fresh : SIM_TEMPLATES);
  }

  private buildInput(
    template: SimTemplate,
    options: { history: boolean; startsAt?: number },
  ): ApiCreateRaceInput {
    this.counter += 1;
    const tag = `${this.counter.toString(36).padStart(3, "0")}-${this.rng.hex(6)}`;
    const scale = options.history ? 1 : this.timeScale;
    const input: ApiCreateRaceInput = {
      raceId: `sim-${tag}`,
      courseId: options.history ? SIM_HISTORY_COURSE_ID : courseIdFor(template),
      seed: `fight-${tag}`,
      checkpointCount: template.stages.length,
      targetDurationMs: Math.round(SIM_TARGET_DURATION_MS / scale),
      absoluteDurationMs: Math.round(SIM_ABSOLUTE_DURATION_MS / scale),
      task: template.task,
      startUrl: template.stages[0].url,
      obstaclesEnabled: true,
      title: template.title,
      taskDetail: template.taskDetail,
      successCondition: template.successCondition,
      checkpointLabels: template.stages.map((stage) => stage.label),
      sabotage: {
        checkpoint: template.sabotage.checkpoint,
        summary: template.sabotage.summary,
        detail: template.sabotage.detail,
        // Scaled like the race durations so the engine's recoverAt matches
        // the simulated world at any time scale.
        policy: {
          ...template.sabotage.policy,
          durationMs: scaleDurationMs(template.sabotage.policy.durationMs, scale),
        },
      },
      agents: SIM_AGENT_ROSTER.map((agent) => ({ ...agent })),
    };
    if (options.startsAt !== undefined) input.startsAt = options.startsAt;
    return input;
  }

  // ------------------------------------------------------------ history

  /** Seeds resolved fights spread over the last ~10 days, oldest first. */
  async seedHistory(now: number): Promise<void> {
    const count = this.historyCount;
    if (count === 0) return;
    const slot = HISTORY_SPAN_MS / count;
    const voidIndex = count >= 3 ? Math.floor(count / 2) : -1;
    for (let index = 0; index < count && !this.stopped; index += 1) {
      const startAt = Math.min(
        now - 2 * 3_600_000,
        Math.round(now - HISTORY_SPAN_MS + slot * index + this.rng.range(0, slot * 0.6)),
      );
      try {
        await this.seedHistoryFight(startAt, index === voidIndex);
      } catch {
        // One bad seed must not block the lobby.
      }
    }
  }

  /**
   * Replays one fight in the past. Each racer's script (the same one the live
   * runner follows) is run offline against the engine's rules, then every
   * step, frame, checkpoint and finish is recorded through the coordinator
   * with its past timestamp, so the fight closes with a real evaluation.
   */
  private async seedHistoryFight(startAt: number, voided: boolean): Promise<void> {
    const template = this.rng.pick(SIM_TEMPLATES);
    const input = this.buildInput(template, { history: true });
    await this.registry.create(input, startAt);
    const coordinator = this.registry.get(input.raceId);
    const fight = coordinator.fight;
    const course = fitTemplate(template, fight.checkpointLabels);
    const racerIds = [...coordinator.market.racerIds];
    const difficulty: FightDifficulty = voided ? "brutal" : this.rng.chance(0.25) ? "hard" : "normal";
    const plan = planFight(
      `${this.options.seed}/${input.seed}`,
      racerIds.map((racerId, index) => ({ racerId, key: fight.agents[index]?.key ?? racerId })),
      course.stages.length,
      { difficulty },
    );
    const race = coordinator.engine.race;
    const cap = race.absoluteDurationMs;
    const runs = scriptHistoryRuns({
      template: course,
      plans: racerIds.map((racerId) => plan.racers[racerId]),
      seeds: racerIds.map((racerId) => `${input.seed}/script/${racerId}`),
      sabotage: sabotageStepsOf(race.sabotagePlan),
      freezeAtMs: race.targetDurationMs,
      capMs: cap,
      voided,
      maxSteps: SIM_MAX_STEPS,
    });

    let order = 0;
    const events: HistoryEvent[] = [];
    runs.forEach((run, racerIndex) => {
      for (const event of run.events) {
        events.push({ ...event, racerId: racerIds[racerIndex], racerIndex, order: order++ });
      }
    });
    if (this.bots.length > 0) {
      const finishes = runs
        .map((run) => run.finishAt)
        .filter((finishAt): finishAt is number => finishAt !== null);
      const fastest = finishes.length > 0 ? Math.min(...finishes) : null;
      const tradeUntil = Math.min(
        race.targetDurationMs - 2_000,
        fastest !== null ? fastest - 1_000 : cap,
      );
      const trades = this.rng.int(10, 24);
      for (let index = 0; index < trades; index += 1) {
        events.push({ t: this.rng.range(2_000, Math.max(3_000, tradeUntil)), kind: "trade", order: order++ });
      }
    }
    events.sort((left, right) => left.t - right.t || left.order - right.order);

    let lastAt = startAt;
    for (const event of events) {
      if (isOver(coordinator)) break;
      if (event.t >= cap) break;
      let at = startAt + Math.max(1, Math.round(event.t));
      switch (event.kind) {
        case "checkpoint":
          at = await this.pastRecovery(coordinator, event.racerId, at);
          lastAt = Math.max(lastAt, at);
          await coordinator.recordCheckpoint(event.racerId, event.checkpoint, at);
          break;
        case "finish":
          at = await this.pastRecovery(coordinator, event.racerId, at);
          lastAt = Math.max(lastAt, at);
          await coordinator.recordFinish(event.racerId, at);
          break;
        case "crash":
          lastAt = Math.max(lastAt, at);
          this.recordHistoryStep(coordinator, course, fight.agents, event, at);
          coordinator.engine.failRacer(event.racerId, "simulated agent crashed: browser context lost", at);
          await coordinator.tick(at);
          break;
        case "trade":
          lastAt = Math.max(lastAt, at);
          this.botTrade(coordinator, at);
          break;
        default:
          lastAt = Math.max(lastAt, at);
          this.recordHistoryStep(coordinator, course, fight.agents, event, at);
          break;
      }
    }
    if (!isOver(coordinator)) {
      lastAt = startAt + cap + 1;
      await coordinator.tick(lastAt);
    }
    this.recordFinalFrames(coordinator, course, lastAt);
    await coordinator.shutdown();
  }

  /** Records one scripted step, with its browser evidence and frame, at `at`. */
  private recordHistoryStep(
    coordinator: RaceCoordinator,
    course: SimTemplate,
    agents: readonly AgentIdentity[],
    event: HistoryStepEvent,
    at: number,
  ): void {
    const racer = coordinator.engine.racers.get(event.racerId);
    if (!racer || (racer.status !== "running" && racer.status !== "recovering")) return;
    let caption: string;
    let disruption: ScriptStep["disruption"] = null;
    let status: "working" | "failed" | "idle" = "working";
    if (event.kind === "note") {
      coordinator.recordAgentAction(event.racerId, {
        kind: "note",
        text: event.text,
        url: event.page.url,
        step: event.step,
        maxSteps: SIM_MAX_STEPS,
      }, at);
      caption = event.text;
      if (event.idle) status = "idle";
    } else {
      coordinator.recordAgentAction(
        event.racerId,
        actionReport(event.entry, event.page, event.step, SIM_MAX_STEPS),
        at,
      );
      caption = stepCaption(event.entry);
      disruption = event.entry.disruption;
      if (event.kind === "crash") status = "failed";
    }
    const agent = agents[event.racerIndex];
    coordinator.recordAgentFrame(event.racerId, {
      contentType: "image/svg+xml",
      capturedAt: at,
      body: renderSimFrame({
        brand: course.brand,
        page: event.page,
        stageNumber: event.stageNumber,
        stageCount: course.stages.length,
        stageLabel: course.stages[event.stageNumber - 1]?.label ?? "Finish",
        agentKey: agent?.key ?? event.racerId,
        agentName: agent?.name ?? event.racerId,
        step: event.step,
        maxSteps: SIM_MAX_STEPS,
        action: caption,
        disruption,
        status,
      }),
    }, at);
  }

  /**
   * The engine rejects progress while a racer is recovering. Returns `at`,
   * or, when the racer is still recovering then, its recoverAt after ticking
   * the coordinator there so the racer is running again. Scripted history
   * already waits out every hazard; this is a safety net.
   */
  private async pastRecovery(
    coordinator: RaceCoordinator,
    racerId: string,
    at: number,
  ): Promise<number> {
    const racer = coordinator.engine.racers.get(racerId);
    if (racer?.status !== "recovering" || racer.recoverAt === undefined || at >= racer.recoverAt) {
      return at;
    }
    const recoverAt = racer.recoverAt;
    await coordinator.tick(recoverAt);
    return recoverAt;
  }

  private recordFinalFrames(coordinator: RaceCoordinator, course: SimTemplate, at: number): void {
    const fight = coordinator.fight;
    coordinator.market.racerIds.forEach((racerId, index) => {
      const racer = coordinator.engine.racers.get(racerId);
      if (!racer) return;
      const stageCount = course.stages.length;
      const page = course.stages[racer.checkpoint] ?? course.finish;
      const status = racer.status === "finished"
        ? "finished"
        : racer.status === "failed"
          ? "failed"
          : "idle";
      const telemetry = coordinator.racerTelemetry(racerId);
      const agent = fight.agents[index];
      coordinator.recordAgentFrame(racerId, {
        contentType: "image/svg+xml",
        capturedAt: at,
        body: renderSimFrame({
          brand: course.brand,
          page,
          stageNumber: racer.checkpoint + 1,
          stageCount,
          stageLabel: course.stages[racer.checkpoint]?.label ?? "Finish",
          agentKey: agent?.key ?? racerId,
          agentName: agent?.name ?? racerId,
          step: telemetry.step,
          maxSteps: SIM_MAX_STEPS,
          action: telemetry.currentAction,
          disruption: null,
          status,
        }),
      }, at);
    });
  }

  // --------------------------------------------------------------- bots

  private createBots(at: number): void {
    const botRng = new Rng(`${this.options.seed}/bots`);
    while (this.bots.length < BOT_COUNT) {
      const userId = `bot-${botRng.hex(6)}`;
      if (this.bots.includes(userId)) continue;
      this.bots.push(userId);
      this.registry.users.ensure({ userId, displayName: `Bot ${userId.slice(-4).toUpperCase()}` }, at);
      this.fundTo(userId, at);
    }
  }

  /** Deposits enough virtual credits to bring the bot back to BOT_FUNDING. */
  private fundTo(userId: string, at: number): void {
    const balance = this.registry.ledger.balance(userId);
    if (balance < BOT_FUNDING) {
      this.registry.ledger.credit(userId, BOT_FUNDING - balance, { type: "deposit", method: "virtual", at });
    }
  }

  private topUp(userId: string, at: number): void {
    if (this.registry.ledger.balance(userId) < BOT_TOP_UP_BELOW) this.fundTo(userId, at);
  }

  /** A few trades on every open market. */
  tradeRound(now: number): void {
    if (this.stopped) return;
    for (const coordinator of this.registry.list()) {
      if (coordinator.market.status !== "open") continue;
      const trades = this.rng.int(1, 3);
      for (let index = 0; index < trades; index += 1) this.botTrade(coordinator, now);
    }
  }

  /** One small bot order, biased toward leaders. Expected rejections are swallowed. */
  botTrade(coordinator: RaceCoordinator, now: number): void {
    if (this.bots.length === 0 || coordinator.market.status !== "open") return;
    const market = coordinator.market;
    const userId = this.rng.pick(this.bots);
    this.topUp(userId, now);
    const positions = market.positionsFor(userId);
    try {
      if (positions.length > 0 && this.rng.chance(0.18)) {
        const position = this.rng.pick(positions);
        coordinator.placeOrder({
          userId,
          racerId: position.racerId,
          side: position.side,
          action: "sell",
          quantity: this.rng.int(1, position.quantity),
        }, now);
        return;
      }
      const prices = market.pricesSnapshot();
      const strength = (racerId: string): number => {
        const racer = coordinator.engine.racers.get(racerId);
        if (!racer || racer.status === "failed" || racer.status === "timed_out") return 0.001;
        const hurt = racer.status === "recovering" ? 0.5 : 1;
        return (prices[racerId] ** 1.5 + 0.12 * racer.checkpoint + 0.03) * hurt;
      };
      let racerId: string;
      let side: "yes" | "no";
      if (this.rng.chance(0.68)) {
        racerId = this.rng.weighted(market.racerIds, strength);
        side = prices[racerId] > 0.85 ? "no" : "yes";
      } else {
        racerId = this.rng.weighted(market.racerIds, (id) => 1 / strength(id));
        side = "no";
      }
      coordinator.placeOrder({
        userId,
        racerId,
        side,
        action: "buy",
        quantity: this.rng.int(1, 40),
      }, now);
    } catch (error) {
      if (!isDomainError(error)) throw error;
    }
  }

  // ------------------------------------------------------------- timers

  private loop(task: () => Promise<void> | void, delay: () => number): void {
    const schedule = (): void => {
      if (this.stopped) return;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (this.stopped) return;
        Promise.resolve()
          .then(task)
          .catch(() => undefined)
          .finally(schedule);
      }, Math.max(MIN_TIMER_MS, delay()));
      timer.unref?.();
      this.timers.add(timer);
    };
    schedule();
  }
}

/**
 * Seeds history, fills the lobby and starts the bot traders. Resolves once
 * seeding is done; the returned function stops every autopilot timer.
 */
export async function startSimulationAutopilot(
  registry: RaceRegistry,
  options: SimulationAutopilotOptions,
): Promise<() => void> {
  const autopilot = new SimulationAutopilot(registry, options);
  try {
    await autopilot.start();
  } catch (error) {
    autopilot.stop();
    throw error;
  }
  return () => autopilot.stop();
}
