import type { DisruptionCommand, SabotageTier } from "./types.js";

export type SabotagePresetId =
  | "shift-primary-action"
  | "plant-decoy-control"
  | "disable-primary-action"
  | "rename-primary-action"
  | "cover-with-modal";

export type SabotagePreset = {
  id: SabotagePresetId;
  tier: SabotageTier;
  label: string;
  policy: DisruptionCommand;
};

/**
 * The master chooses from this bounded catalog. Presets are deliberately
 * semantic: the site adapter only needs to expose the target role.
 */
export const SABOTAGE_PRESETS: readonly SabotagePreset[] = [
  {
    id: "shift-primary-action",
    tier: "basic",
    label: "Shift the primary action",
    policy: {
      hazardType: "move_primary_action",
      targetRole: "primary-action",
      durationMs: 4_000,
      intensity: 1,
    },
  },
  {
    id: "plant-decoy-control",
    tier: "basic",
    label: "Plant a decoy control",
    policy: {
      hazardType: "insert_decoy",
      targetRole: "primary-action",
      durationMs: 5_000,
      intensity: 1,
    },
  },
  {
    id: "disable-primary-action",
    tier: "intermediate",
    label: "Temporarily disable the primary action",
    policy: {
      hazardType: "temporary_disable",
      targetRole: "primary-action",
      durationMs: 6_000,
      intensity: 2,
    },
  },
  {
    id: "rename-primary-action",
    tier: "intermediate",
    label: "Rename the primary action",
    policy: {
      hazardType: "rename_control",
      targetRole: "primary-action",
      durationMs: 6_000,
      intensity: 2,
    },
  },
  {
    id: "cover-with-modal",
    tier: "difficult",
    label: "Cover the page with a modal",
    policy: {
      hazardType: "blocking_modal",
      targetRole: "primary-action",
      durationMs: 8_000,
      intensity: 3,
    },
  },
];

export const SABOTAGE_PRESET_IDS = SABOTAGE_PRESETS.map((preset) => preset.id);

export function sabotagePreset(id: string): SabotagePreset | undefined {
  return SABOTAGE_PRESETS.find((preset) => preset.id === id);
}

