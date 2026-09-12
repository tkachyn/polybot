import type { DisruptionCommand, SabotageTier } from "./types.js";

// Presentation helpers for the race-wide sabotage. The domain plan itself is
// `SabotagePlan` in ./types.ts, armed on the engine; the bettor-facing brief
// is `SabotageBrief` in application/fight-metadata.ts.

export const HAZARD_TYPES: readonly DisruptionCommand["hazardType"][] = [
  "blocking_modal",
  "move_primary_action",
  "insert_decoy",
  "temporary_disable",
  "rename_control",
];

export const SABOTAGE_SUMMARY_MAX = 70;
export const SABOTAGE_DETAIL_MAX = 280;

/** Default trigger checkpoint when a fight names none. */
export const DEFAULT_SABOTAGE_CHECKPOINT = 1;

/** Tier implied by a policy's intensity (1 basic, 2 intermediate, 3 difficult). */
export function tierForPolicy(policy: DisruptionCommand): SabotageTier {
  if (policy.intensity <= 1) return "basic";
  if (policy.intensity === 2) return "intermediate";
  return "difficult";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function humanizeRole(targetRole: string): string {
  const words = targetRole.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words.length > 0 ? words : "primary";
}

/** One-line bettor-facing summary, at most 70 characters. */
export function describeHazard(
  policy: DisruptionCommand,
  checkpointLabel: string,
): string {
  const role = humanizeRole(policy.targetRole);
  const seconds = Math.round(policy.durationMs / 1_000);
  let text: string;
  switch (policy.hazardType) {
    case "blocking_modal":
      text = `Blocking modal covers the page at ${checkpointLabel}`;
      break;
    case "move_primary_action":
      text = `The ${role} control jumps position at ${checkpointLabel}`;
      break;
    case "insert_decoy":
      text = `Decoy button planted beside ${role} at ${checkpointLabel}`;
      break;
    case "temporary_disable":
      text = `The ${role} control is disabled for ${seconds}s at ${checkpointLabel}`;
      break;
    case "rename_control":
      text = `The ${role} control is relabelled at ${checkpointLabel}`;
      break;
    default:
      text = `Sabotage armed at ${checkpointLabel}`;
  }
  return truncate(text, SABOTAGE_SUMMARY_MAX);
}

/** Longer description for the sabotage strip, at most 280 characters. */
export function describeHazardDetail(
  policy: DisruptionCommand,
  checkpointLabel: string,
): string {
  const seconds = Math.round(policy.durationMs / 1_000);
  const hazard = policy.hazardType.replace(/_/g, " ");
  return truncate(
    `When an agent reaches ${checkpointLabel}, the master agent injects a ` +
      `${hazard} targeting "${policy.targetRole}" for ${seconds}s ` +
      `(intensity ${policy.intensity} of 3). Agents are not told in advance.`,
    SABOTAGE_DETAIL_MAX,
  );
}

/** Summary shown for a default plan until its hazard is armed. */
export function sabotagePlaceholder(checkpointLabel: string): string {
  return truncate(`Sabotage armed at ${checkpointLabel}`, SABOTAGE_SUMMARY_MAX);
}

/** Short hazard name for log lines, e.g. "blocking modal". */
export function hazardLabel(hazardType: string): string {
  return hazardType.replace(/_/g, " ");
}
