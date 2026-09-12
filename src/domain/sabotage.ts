import { validateDisruptionCommand } from "../infra/cdp-obstacle-provider.js";
import type {
  DisruptionCommand,
  DisruptionResult,
  ObstacleProvider,
} from "./types.js";

/** The one sabotage a fight carries, revealed to bettors before it fires. */
export type SabotagePlan = {
  /** 1-based checkpoint at which the sabotage fires. */
  checkpoint: number;
  /** At most 70 characters. */
  summary: string;
  /** At most 280 characters. */
  detail?: string;
  /** Fixed policy. Otherwise the inner obstacle provider chooses one. */
  policy?: DisruptionCommand;
};

export const HAZARD_TYPES: readonly DisruptionCommand["hazardType"][] = [
  "blocking_modal",
  "move_primary_action",
  "insert_decoy",
  "temporary_disable",
  "rename_control",
];

export const SABOTAGE_SUMMARY_MAX = 70;
export const SABOTAGE_DETAIL_MAX = 280;

/**
 * Restricts an obstacle provider to one sabotage per fight. The policy is
 * chosen once (armed) and only returned for the plan's checkpoint; every
 * racer who reaches that checkpoint receives the same policy.
 */
export class SabotageObstacleProvider implements ObstacleProvider {
  private arming?: Promise<DisruptionCommand | null>;
  private armed: DisruptionCommand | null | undefined;

  constructor(
    private readonly inner: ObstacleProvider,
    readonly plan: SabotagePlan,
  ) {}

  /** Chooses the policy once. Failures and invalid policies arm `null`. */
  arm(raceId: string): Promise<DisruptionCommand | null> {
    if (!this.arming) {
      this.arming = this.choosePolicy(raceId)
        .catch(() => null)
        .then((policy) => {
          this.armed = policy;
          return policy;
        });
    }
    return this.arming;
  }

  /** undefined until arming has settled. */
  armedPolicy(): DisruptionCommand | null | undefined {
    return this.armed === undefined || this.armed === null
      ? this.armed
      : { ...this.armed };
  }

  async getPolicy(
    raceId: string,
    checkpoint: number,
  ): Promise<DisruptionCommand | null> {
    return checkpoint === this.plan.checkpoint ? this.arm(raceId) : null;
  }

  apply(racerId: string, policy: DisruptionCommand): Promise<DisruptionResult> {
    return this.inner.apply(racerId, policy);
  }

  private async choosePolicy(raceId: string): Promise<DisruptionCommand | null> {
    const policy = this.plan.policy
      ? { ...this.plan.policy }
      : await this.inner.getPolicy(raceId, this.plan.checkpoint);
    if (!policy) return null;
    if (!HAZARD_TYPES.includes(policy.hazardType)) {
      throw new Error(`unknown hazardType: ${String(policy.hazardType)}`);
    }
    validateDisruptionCommand(policy);
    return policy;
  }
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
