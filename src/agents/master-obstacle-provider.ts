import type {
  DisruptionCommand,
  DisruptionResult,
  ObstacleProvider,
  RacerStatus,
  SabotagePlan,
  SabotageSchedule,
  SabotageTier,
  SabotageTrigger,
} from "../domain/types.js";
import { sabotageCheckpoints } from "../domain/sabotage.js";
import { validateDisruptionCommand } from "../infra/cdp-obstacle-provider.js";
import {
  SABOTAGE_PRESET_IDS,
  sabotagePreset,
  type SabotagePresetId,
} from "../domain/sabotage-presets.js";

const ALLOWED_HAZARDS: DisruptionCommand["hazardType"][] = [
  "blocking_modal",
  "move_primary_action",
  "insert_decoy",
  "temporary_disable",
  "rename_control",
];
const CANONICAL_TARGET_ROLE = "primary-action";
const FALLBACK_HAZARD_ORDER: readonly DisruptionCommand["hazardType"][] = [
  "blocking_modal",
  "insert_decoy",
  "temporary_disable",
  "rename_control",
  "move_primary_action",
];
const TARGETED_HAZARDS = new Set<DisruptionCommand["hazardType"]>([
  "move_primary_action",
  "insert_decoy",
  "temporary_disable",
  "rename_control",
]);

export type MasterRaceObservation = {
  raceId: string;
  checkpoint: number;
  racers: Array<{
    racerId: string;
    checkpoint: number;
    status: RacerStatus;
    url?: string;
    lastAction?: string;
  }>;
};

export interface RaceObservationSource {
  observe(raceId: string, checkpoint: number): Promise<MasterRaceObservation>;
}

export interface MasterPolicyModel {
  selectObstacle?(input: {
    observation: MasterRaceObservation;
    allowedHazards: DisruptionCommand["hazardType"][];
  }): Promise<DisruptionCommand>;
  selectSabotage?(input: {
    observation: MasterRaceObservation;
    allowedHazards: DisruptionCommand["hazardType"][];
    allowedTiers: SabotageTier[];
  }): Promise<{ tier: SabotageTier; policy: DisruptionCommand }>;
  selectSabotageSequence?(input: {
    observation: MasterRaceObservation;
    checkpoints: readonly number[];
    allowedPresetIds: readonly SabotagePresetId[];
  }): Promise<{ presetIds: readonly SabotagePresetId[] }>;
}

export class MasterObstacleProvider implements ObstacleProvider {
  private readonly timeoutMs: number;
  private readonly plans = new Map<string, Promise<SabotagePlan | null>>();
  private readonly fallbackPolicies: Record<SabotageTier, DisruptionCommand>;
  private readonly legacyFallback: boolean;

  constructor(
    private readonly model: MasterPolicyModel,
    private readonly observations: RaceObservationSource,
    private readonly executor: Pick<ObstacleProvider, "apply">,
    fallbackPolicies: Record<number, DisruptionCommand> | Partial<Record<SabotageTier, DisruptionCommand>> = {},
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 2_500;
    const legacy = fallbackPolicies as Record<number, DisruptionCommand>;
    const byTier = fallbackPolicies as Partial<Record<SabotageTier, DisruptionCommand>>;
    this.legacyFallback = Object.keys(fallbackPolicies).some((key) => /^\d+$/.test(key));
    this.fallbackPolicies = {
      basic: byTier.basic ?? legacy[1] ?? {
        hazardType: "blocking_modal",
        targetRole: "primary-action",
        durationMs: 4_000,
        intensity: 1,
      },
      intermediate: byTier.intermediate ?? legacy[2] ?? {
        hazardType: "move_primary_action",
        targetRole: "primary-action",
        durationMs: 6_000,
        intensity: 2,
      },
      difficult: byTier.difficult ?? legacy[3] ?? {
        hazardType: "temporary_disable",
        targetRole: "primary-action",
        durationMs: 8_000,
        intensity: 3,
      },
    };
  }

  async armRace(input: {
    raceId: string;
    courseId: string;
    seed: string;
    checkpointCount: number;
    sabotageSchedule?: Partial<SabotageSchedule>;
    trigger: SabotageTrigger;
  }): Promise<SabotagePlan | null> {
    const existing = this.plans.get(input.raceId);
    if (existing) return existing;
    const selection = this.selectPlan(input);
    this.plans.set(input.raceId, selection);
    return selection;
  }

  async getPolicy(
    raceId: string,
    checkpoint: number,
  ): Promise<DisruptionCommand | null> {
    const plan = await this.armRace({
      raceId,
      courseId: "unknown",
      seed: "unknown",
      // Legacy callers only provide the trigger checkpoint. Give the
      // selector one completion checkpoint beyond it; the coordinator's
      // race-aware path rejects a true final checkpoint before this fallback.
      checkpointCount: checkpoint + 1,
      sabotageSchedule: undefined,
      trigger: { kind: "target_opened", checkpoint: 1, milestone: "first_verified_checkpoint" },
    });
    return plan?.policy ?? null;
  }

  async apply(
    racerId: string,
    policy: DisruptionCommand,
  ): Promise<DisruptionResult> {
    let last: DisruptionResult = { applied: false, reason: "not_applied" };
    for (const candidate of fallbackPolicies(policy)) {
      let result: DisruptionResult;
      try {
        result = await this.executor.apply(racerId, candidate);
      } catch (error) {
        // A CDP/session error on one hazard should not prevent the next
        // compatible hazard from being attempted for this racer.
        last = {
          applied: false,
          reason: error instanceof Error ? error.message : String(error),
        };
        continue;
      }
      if (result.applied) {
        return samePolicy(candidate, policy)
          ? result
          : { ...result, policy: candidate };
      }
      last = result;
      if (!isRecoverableApplyFailure(result.reason)) return result;
    }
    return last;
  }

  private async selectPlan(input: {
    raceId: string;
    courseId: string;
    seed: string;
    checkpointCount: number;
    sabotageSchedule?: Partial<SabotageSchedule>;
    trigger: SabotageTrigger;
  }): Promise<SabotagePlan | null> {
    const checkpoints = sabotageCheckpoints(
      input.checkpointCount,
      input.trigger.checkpoint,
      input.sabotageSchedule,
    );
    if (checkpoints.length === 0) return null;
    try {
      const observation = await this.observations.observe(input.raceId, input.trigger.checkpoint);
      if (this.model.selectSabotageSequence && checkpoints.length >= 1) {
        const selected = await this.withTimeout(
          this.model.selectSabotageSequence({
            observation,
            checkpoints,
            allowedPresetIds: SABOTAGE_PRESET_IDS,
          }),
        );
        if (
          selected.presetIds.length !== checkpoints.length ||
          new Set(selected.presetIds).size !== selected.presetIds.length ||
          selected.presetIds.some((presetId) => !SABOTAGE_PRESET_IDS.includes(presetId))
        ) {
          throw new Error("Invalid sabotage preset sequence");
        }
        const steps = selected.presetIds.map((presetId, index) => {
          const preset = sabotagePreset(presetId);
          if (!preset) throw new Error(`Unknown sabotage preset: ${presetId}`);
          return {
            stepId: preset.id,
            checkpoint: checkpoints[index]!,
            tier: preset.tier,
            policy: { ...preset.policy },
            selectedAt: Date.now(),
          };
        });
        const first = steps[0]!;
        return freezePlan({
          raceId: input.raceId,
          tier: highestTier(steps.map((step) => step.tier)),
          trigger: input.trigger,
          policy: first.policy,
          selectedAt: Date.now(),
          source: "model",
          steps,
        });
      }
      const selected = await this.withTimeout(
        this.model.selectSabotage
          ? this.model.selectSabotage({
              observation,
              allowedHazards: ALLOWED_HAZARDS,
              allowedTiers: ["basic", "intermediate", "difficult"],
            })
          : this.model.selectObstacle
            ? this.model.selectObstacle({
                observation,
                allowedHazards: ALLOWED_HAZARDS,
              }).then((policy) => ({
                tier: tierForPolicy(policy),
                policy,
              }))
            : Promise.reject(new Error("Master policy model has no selector")),
      );
      const policy = normalizeTarget(selected.policy);
      validateSelectedPlan({ ...selected, policy });
      return freezePlan({
        raceId: input.raceId,
        tier: selected.tier,
        trigger: input.trigger,
        policy,
        selectedAt: Date.now(),
        source: "model",
      });
    } catch {
      if (!this.legacyFallback && checkpoints.length >= 2) {
        const presets = fallbackPresetIds(input.seed);
        const steps = presets.slice(0, checkpoints.length).map((presetId, index) => {
          const preset = sabotagePreset(presetId)!;
          return {
            stepId: preset.id,
            checkpoint: checkpoints[index]!,
            tier: preset.tier,
            policy: { ...preset.policy },
            selectedAt: Date.now(),
          };
        });
        return freezePlan({
          raceId: input.raceId,
          tier: highestTier(steps.map((step) => step.tier)),
          trigger: input.trigger,
          policy: steps[0]!.policy,
          selectedAt: Date.now(),
          source: "fallback",
          steps,
        });
      }
      const tier = this.legacyFallback ? "basic" : fallbackTier(input.seed);
      const policy = normalizeTarget(this.fallbackPolicies[tier]);
      validateSelectedPlan({ tier, policy });
      return freezePlan({
        raceId: input.raceId,
        tier,
        trigger: input.trigger,
        policy,
        selectedAt: Date.now(),
        source: "fallback",
      });
    }
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("master policy selection timed out")),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function tierForPolicy(policy: DisruptionCommand): SabotageTier {
  if (policy.intensity <= 1) return "basic";
  if (policy.intensity === 2) return "intermediate";
  return "difficult";
}

function fallbackTier(seed: string): SabotageTier {
  const hash = [...seed].reduce((total, character) => total + character.charCodeAt(0), 0);
  return (["intermediate", "difficult", "difficult"] as const)[hash % 3];
}

function fallbackPresetIds(seed: string): SabotagePresetId[] {
  const preferred: SabotagePresetId[] = [
    "cover-with-modal",
    "plant-decoy-control",
    "disable-primary-action",
  ];
  const offset = [...seed].reduce((total, character) => total + character.charCodeAt(0), 0) % preferred.length;
  const rotated = [...preferred.slice(offset), ...preferred.slice(0, offset)];
  return rotated;
}

function highestTier(tiers: readonly SabotageTier[]): SabotageTier {
  return tiers.includes("difficult")
    ? "difficult"
    : tiers.includes("intermediate")
      ? "intermediate"
      : "basic";
}

function validateSelectedPlan(input: {
  tier: SabotageTier;
  policy: DisruptionCommand;
}): void {
  if (!["basic", "intermediate", "difficult"].includes(input.tier)) {
    throw new Error("Invalid sabotage tier");
  }
  validateDisruptionCommand(input.policy);
  const maximums: Record<SabotageTier, { durationMs: number; intensity: number }> = {
    basic: { durationMs: 5_000, intensity: 1 },
    intermediate: { durationMs: 12_000, intensity: 2 },
    difficult: { durationMs: 30_000, intensity: 3 },
  };
  const maximum = maximums[input.tier];
  if (input.policy.intensity !== maximum.intensity) {
    throw new Error(`Policy intensity must match the ${input.tier} sabotage tier`);
  }
  if (
    input.policy.durationMs > maximum.durationMs ||
    input.policy.intensity > maximum.intensity
  ) {
    throw new Error(`Policy exceeds ${input.tier} sabotage limits`);
  }
}

function freezePlan(plan: SabotagePlan): SabotagePlan {
  return Object.freeze({
    ...plan,
    trigger: Object.freeze({ ...plan.trigger }),
    policy: Object.freeze({ ...plan.policy }),
    ...(plan.steps
      ? {
          steps: Object.freeze(plan.steps.map((step) => Object.freeze({
            ...step,
            policy: Object.freeze({ ...step.policy }),
          }))),
        }
      : {}),
  }) as SabotagePlan;
}

function normalizeTarget(policy: DisruptionCommand): DisruptionCommand {
  if (!TARGETED_HAZARDS.has(policy.hazardType) ||
    policy.targetRole === CANONICAL_TARGET_ROLE) {
    return policy;
  }
  // Every production course exposes this stable semantic hook. Keeping the
  // master model's target role from leaking into CDP is what prevents a
  // perfectly valid hazard from becoming target_not_found.
  return { ...policy, targetRole: CANONICAL_TARGET_ROLE };
}

function fallbackPolicies(policy: DisruptionCommand): DisruptionCommand[] {
  const candidates: DisruptionCommand[] = [normalizeTarget(policy)];
  for (const hazardType of FALLBACK_HAZARD_ORDER) {
    if (hazardType === policy.hazardType) continue;
    candidates.push({
      ...policy,
      hazardType,
      targetRole: CANONICAL_TARGET_ROLE,
    });
  }
  return candidates.filter((candidate, index) =>
    candidates.findIndex((other) => samePolicy(other, candidate)) === index,
  );
}

function samePolicy(left: DisruptionCommand, right: DisruptionCommand): boolean {
  return left.hazardType === right.hazardType &&
    left.targetRole === right.targetRole &&
    left.durationMs === right.durationMs &&
    left.intensity === right.intensity &&
    left.disruptionId === right.disruptionId;
}

function isRecoverableApplyFailure(reason: string | undefined): boolean {
  return reason === "target_not_found" ||
    reason === "apply_failed" ||
    reason === "invalid_cdp_response";
}
