import type {
  DisruptionCommand,
  DisruptionResult,
  ObstacleProvider,
  RacerStatus,
  SabotagePlan,
  SabotageTier,
  SabotageTrigger,
} from "../domain/types.js";
import {
  sabotagePreset,
  SABOTAGE_PRESETS,
  type SabotagePresetId,
} from "../domain/sabotage-presets.js";
import { validateDisruptionCommand } from "../infra/cdp-obstacle-provider.js";

const ALLOWED_HAZARDS: DisruptionCommand["hazardType"][] = [
  "blocking_modal",
  "move_primary_action",
  "insert_decoy",
  "temporary_disable",
  "rename_control",
];

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
    checkpoints: [number, number, number];
    allowedPresetIds: readonly SabotagePresetId[];
  }): Promise<{ presetIds: [SabotagePresetId, SabotagePresetId, SabotagePresetId] }>;
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
      checkpointCount: checkpoint,
      trigger: { kind: "target_opened", checkpoint: 1, milestone: "first_verified_checkpoint" },
    });
    return plan?.policy ?? null;
  }

  async apply(
    racerId: string,
    policy: DisruptionCommand,
  ): Promise<DisruptionResult> {
    return this.executor.apply(racerId, policy);
  }

  private async selectPlan(input: {
    raceId: string;
    courseId: string;
    seed: string;
    checkpointCount: number;
    trigger: SabotageTrigger;
  }): Promise<SabotagePlan | null> {
    try {
      const observation = await this.observations.observe(input.raceId, input.trigger.checkpoint);
      if (this.model.selectSabotageSequence && input.checkpointCount >= 4) {
        const checkpoints: [number, number, number] = [2, 3, 4];
        const selected = await this.withTimeout(
          this.model.selectSabotageSequence({
            observation,
            checkpoints,
            allowedPresetIds: SABOTAGE_PRESETS.map((preset) => preset.id),
          }),
        );
        return freezePlan(buildSequencePlan(input, selected.presetIds));
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
      validateSelectedPlan(selected);
      return freezePlan({
        raceId: input.raceId,
        tier: selected.tier,
        trigger: input.trigger,
        policy: selected.policy,
        selectedAt: Date.now(),
        source: "model",
      });
    } catch {
      if (this.model.selectSabotageSequence && input.checkpointCount >= 4) {
        return freezePlan(buildSequencePlan(input, fallbackPresetSequence(input.seed)));
      }
      const tier = this.legacyFallback ? "basic" : fallbackTier(input.seed);
      const policy = this.fallbackPolicies[tier];
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
  return (["basic", "intermediate", "difficult"] as const)[hash % 3];
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

function buildSequencePlan(
  input: {
    raceId: string;
    trigger: SabotageTrigger;
  },
  presetIds: readonly string[],
): SabotagePlan {
  if (presetIds.length !== 3 || new Set(presetIds).size !== 3) {
    throw new Error("Master must select three different sabotage presets");
  }
  const steps = presetIds.map((presetId, index) => {
    const preset = sabotagePreset(presetId);
    if (!preset) throw new Error(`Unknown sabotage preset: ${presetId}`);
    return {
      stepId: preset.id,
      checkpoint: index + 2,
      tier: preset.tier,
      policy: { ...preset.policy },
      selectedAt: Date.now(),
    };
  });
  return {
    raceId: input.raceId,
    tier: steps[0].tier,
    trigger: { ...input.trigger, checkpoint: 2 },
    policy: { ...steps[0].policy },
    selectedAt: Date.now(),
    source: "model",
    steps,
  };
}

function fallbackPresetSequence(seed: string): [SabotagePresetId, SabotagePresetId, SabotagePresetId] {
  const offset = [...seed].reduce((sum, character) => sum + character.charCodeAt(0), 0) %
    SABOTAGE_PRESETS.length;
  const ids = SABOTAGE_PRESETS
    .filter((preset) => preset.id !== "cover-with-modal")
    .map((preset) => preset.id);
  return [
    ids[offset % ids.length] as SabotagePresetId,
    ids[(offset + 1) % ids.length] as SabotagePresetId,
    ids[(offset + 2) % ids.length] as SabotagePresetId,
  ];
}
