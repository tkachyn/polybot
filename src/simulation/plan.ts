import { Rng } from "./rng.js";

/** How hard a fight is for every agent. Brutal fights usually void at the cap. */
export type FightDifficulty = "normal" | "hard" | "brutal";

export const DIFFICULTY_FACTOR: Readonly<Record<FightDifficulty, number>> = {
  normal: 1,
  hard: 1.55,
  brutal: 4.2,
};

/** Action budget reported to spectators. */
export const SIM_MAX_STEPS = 90;
/** Wall-clock step duration at timeScale 1. */
export const STEP_DELAY_MIN_MS = 2_500;
export const STEP_DELAY_MAX_MS = 6_000;
/** Productive steps for an average agent on a normal fight, across all stages. */
const BASE_TOTAL_STEPS = 22;
const FAILURE_CHANCE = 0.05;

export type RacerPlan = {
  racerId: string;
  key: string;
  /** Multiplier on each step's delay (lower is faster). */
  speed: number;
  /** Productive steps per stage; the last entry is the finish page. */
  stepsPerStage: number[];
  /** Chance that a step is an error that makes no progress. */
  errorRate: number;
  /** Chance per stage of repeating one action 3+ times (LOOPING). */
  loopRate: number;
  /** Step at which the agent crashes, or null. */
  failAtStep: number | null;
};

export type FightPlan = {
  difficulty: FightDifficulty;
  racers: Record<string, RacerPlan>;
};

export type PlanRacer = { racerId: string; key: string };

function chooseDifficulty(rng: Rng): FightDifficulty {
  const roll = rng.float();
  if (roll < 0.06) return "brutal";
  if (roll < 0.2) return "hard";
  return "normal";
}

/**
 * Seeded per-fight skill profiles. Profiles are keyed by fight seed and agent
 * key, so the same agent is strong in one fight and weak in the next.
 */
export function planFight(
  seed: string,
  racers: readonly PlanRacer[],
  stageCount: number,
  options: { difficulty?: FightDifficulty } = {},
): FightPlan {
  const difficulty = options.difficulty ?? chooseDifficulty(new Rng(`${seed}/difficulty`));
  const factor = DIFFICULTY_FACTOR[difficulty];
  const plans: Record<string, RacerPlan> = {};
  for (const { racerId, key } of racers) {
    const rng = new Rng(`${seed}/skill/${key}`);
    const agentFactor = rng.range(0.72, 1.35);
    const total = BASE_TOTAL_STEPS * factor * agentFactor;
    const weights = Array.from({ length: stageCount }, () => rng.range(0.8, 1.2));
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
    const stepsPerStage = weights.map((weight) => Math.max(2, Math.round((total * weight) / weightSum)));
    stepsPerStage.push(rng.int(1, 3));
    const totalSteps = stepsPerStage.reduce((sum, steps) => sum + steps, 0);
    plans[racerId] = {
      racerId,
      key,
      speed: rng.range(0.88, 1.12),
      stepsPerStage,
      errorRate: rng.range(0.03, 0.12),
      loopRate: rng.range(0.05, 0.25),
      failAtStep: rng.chance(FAILURE_CHANCE) ? rng.int(3, Math.max(4, totalSteps - 1)) : null,
    };
  }
  return { difficulty, racers: plans };
}

export type RacerTimeline = {
  /** Offset from the start when checkpoint k was cleared (index k - 1). */
  checkpointAt: number[];
  /** Offset of the verified finish, or null when the agent failed first. */
  finishAt: number | null;
  /** Offset of the crash, or null. */
  failAt: number | null;
  /** Cumulative step count at each checkpoint (index k - 1). */
  stepsAt: number[];
};

/**
 * Offline timeline of one agent, for seeding history. Mirrors the live
 * runner: errors and loops cost extra steps, and the sabotage costs its
 * duration plus `intensity` recovery steps on the page after its checkpoint.
 */
export function planTimeline(
  plan: RacerPlan,
  rng: Rng,
  sabotage: { checkpoint: number; durationMs: number; intensity: number } | null,
): RacerTimeline {
  const stageCount = plan.stepsPerStage.length - 1;
  const checkpointAt: number[] = [];
  const stepsAt: number[] = [];
  let t = 0;
  let steps = 0;
  for (let stage = 0; stage <= stageCount; stage += 1) {
    let stageSteps = plan.stepsPerStage[stage];
    for (let index = 0; index < plan.stepsPerStage[stage]; index += 1) {
      if (rng.chance(plan.errorRate)) stageSteps += 1;
    }
    if (rng.chance(plan.loopRate)) stageSteps += 3;
    if (sabotage && stage === sabotage.checkpoint) {
      t += sabotage.durationMs;
      stageSteps += sabotage.intensity;
    }
    for (let index = 0; index < stageSteps; index += 1) {
      t += rng.range(STEP_DELAY_MIN_MS, STEP_DELAY_MAX_MS) * plan.speed;
      steps += 1;
      if (plan.failAtStep !== null && steps >= plan.failAtStep) {
        return { checkpointAt, finishAt: null, failAt: Math.round(t), stepsAt };
      }
    }
    if (stage < stageCount) {
      checkpointAt.push(Math.round(t));
      stepsAt.push(steps);
    }
  }
  return { checkpointAt, finishAt: Math.round(t), failAt: null, stepsAt };
}
