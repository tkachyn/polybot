import type { CDPSession } from "playwright";
import type { SteelSessionManager } from "./steel-session-manager.js";
import { SessionCommandQueue } from "./session-command-queue.js";
import type {
  DisruptionCommand,
  DisruptionResult,
  ObstacleProvider,
  SabotagePlan,
  SabotageTrigger,
} from "../domain/types.js";

const MAX_DURATION_MS = 30_000;

export function validateDisruptionCommand(
  command: DisruptionCommand,
): void {
  if (!command || typeof command !== "object") {
    throw new Error("disruption command must be an object");
  }
  if (![
    "blocking_modal",
    "move_primary_action",
    "insert_decoy",
    "temporary_disable",
    "rename_control",
  ].includes(command.hazardType)) {
    throw new Error("unsupported hazardType");
  }
  if (!Number.isInteger(command.durationMs) || command.durationMs < 0) {
    throw new Error("durationMs must be a non-negative integer");
  }
  if (command.durationMs > MAX_DURATION_MS) {
    throw new Error(`durationMs cannot exceed ${MAX_DURATION_MS}`);
  }
  if (!Number.isInteger(command.intensity) || command.intensity < 1 || command.intensity > 3) {
    throw new Error("intensity must be an integer from 1 to 3");
  }
  if (
    typeof command.targetRole !== "string" ||
    command.targetRole.length === 0 ||
    command.targetRole.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(command.targetRole)
  ) {
    throw new Error("targetRole must be between 1 and 100 characters");
  }
  if (
    command.disruptionId !== undefined &&
    (
      typeof command.disruptionId !== "string" ||
      command.disruptionId.length === 0 ||
      command.disruptionId.length > 100 ||
      !/^[a-zA-Z0-9._:-]+$/.test(command.disruptionId)
    )
  ) {
    throw new Error("disruptionId contains invalid characters");
  }
}

export function buildDisruptionScript(
  command: DisruptionCommand,
  disruptionId: string,
): string {
  validateDisruptionCommand(command);
  const role = JSON.stringify(command.targetRole);
  const id = JSON.stringify(disruptionId);
  const duration = command.durationMs;
  const intensity = command.intensity;

  return `
    (() => {
      const role = ${role};
      const disruptionId = ${id};
      const durationMs = ${duration};
      const intensity = ${intensity};
      const selector = '[data-arena-role="' + CSS.escape(role) + '"]';
      const target = document.querySelector(selector);
      const marker = '[data-arena-disruption-id="' + disruptionId + '"]';

      if (document.querySelector(marker)) {
        return { applied: false, reason: "already_applied" };
      }

      if (!target && ${JSON.stringify(command.hazardType)} !== "blocking_modal") {
        return { applied: false, reason: "target_not_found" };
      }

      const cleanup = [];
      const rememberStyle = (element, property) => {
        const previous = element.style[property];
        cleanup.push(() => { element.style[property] = previous; });
      };

      if (${JSON.stringify(command.hazardType)} === "blocking_modal") {
        const modal = document.createElement("div");
        modal.dataset.arenaDisruptionId = disruptionId;
        modal.textContent = "The interface is temporarily unavailable";
        Object.assign(modal.style, {
          position: "fixed",
          inset: "0",
          zIndex: "2147483647",
          display: "grid",
          placeItems: "center",
          background: "rgba(0, 0, 0, 0.72)",
          color: "white",
          fontSize: (16 + intensity * 2) + "px",
          fontFamily: "sans-serif",
        });
        document.body.appendChild(modal);
        cleanup.push(() => modal.remove());
      } else if (${JSON.stringify(command.hazardType)} === "move_primary_action") {
        rememberStyle(target, "position");
        rememberStyle(target, "top");
        rememberStyle(target, "left");
        target.style.position = "relative";
        target.style.top = (12 * intensity) + "px";
        target.style.left = (18 * intensity) + "px";
      } else if (${JSON.stringify(command.hazardType)} === "insert_decoy") {
        const decoy = target.cloneNode(true);
        decoy.dataset.arenaDisruptionId = disruptionId;
        decoy.removeAttribute("data-arena-role");
        decoy.textContent = "Continue";
        target.parentElement?.insertBefore(decoy, target);
        cleanup.push(() => decoy.remove());
      } else if (${JSON.stringify(command.hazardType)} === "temporary_disable") {
        rememberStyle(target, "pointerEvents");
        rememberStyle(target, "opacity");
        target.style.pointerEvents = "none";
        target.style.opacity = "0.45";
      } else if (${JSON.stringify(command.hazardType)} === "rename_control") {
        const element = target;
        const previousText = element.textContent;
        element.textContent = "Unavailable";
        cleanup.push(() => { element.textContent = previousText; });
      }

      if (target) target.setAttribute("data-arena-disruption-id", disruptionId);
      window.setTimeout(() => cleanup.forEach((undo) => undo()), durationMs);
      return { applied: true, disruptionId };
    })()
  `;
}

export class CdpObstacleProvider implements ObstacleProvider {
  private readonly queues = new Map<string, SessionCommandQueue>();
  private readonly policies: Map<number, DisruptionCommand>;
  private readonly applied = new Set<string>();

  constructor(
    private readonly sessions: SteelSessionManager,
    policies: Record<number, DisruptionCommand> = {},
  ) {
    this.policies = new Map(Object.entries(policies).map(([key, value]) => [
      Number(key),
      validateAndReturn(value),
    ]));
  }

  async armRace(input: {
    raceId: string;
    courseId: string;
    seed: string;
    checkpointCount: number;
    trigger: SabotageTrigger;
  }): Promise<SabotagePlan | null> {
    const policy = this.policies.get(input.trigger.checkpoint);
    if (!policy) return null;
    return {
      raceId: input.raceId,
      tier: policy.intensity <= 1
        ? "basic"
        : policy.intensity === 2
          ? "intermediate"
          : "difficult",
      trigger: input.trigger,
      policy,
      selectedAt: Date.now(),
      source: "fallback",
    };
  }

  async getPolicy(
    _raceId: string,
    checkpoint: number,
  ): Promise<DisruptionCommand | null> {
    return this.policies.get(checkpoint) ?? null;
  }

  async apply(
    racerId: string,
    policy: DisruptionCommand,
  ): Promise<DisruptionResult> {
    validateDisruptionCommand(policy);
    const queue = this.queues.get(racerId) ?? new SessionCommandQueue();
    this.queues.set(racerId, queue);

    return queue.run(async () => {
      const disruptionId = policy.disruptionId ??
        `disruption-${racerId}-${stablePolicyKey(policy)}`;
      const applicationKey = `${racerId}:${disruptionId}`;
      if (this.applied.has(applicationKey)) {
        return { applied: false, reason: "already_applied" };
      }
      const session = this.sessions.get(racerId);
      const cdp: CDPSession = await session.page.context().newCDPSession(session.page);
      try {
        const response = await cdp.send("Runtime.evaluate", {
          expression: buildDisruptionScript(policy, disruptionId),
          returnByValue: true,
          awaitPromise: true,
        });
        const value = response.result.value;
        if (typeof value === "object" && value !== null && "applied" in value) {
          const result = value as DisruptionResult;
          if (result.applied) this.applied.add(applicationKey);
          return result;
        }
        return { applied: false, reason: "invalid_cdp_response" };
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    });
  }

  async cleanup(): Promise<void> {
    this.applied.clear();
    this.queues.clear();
  }
}

function validateAndReturn(policy: DisruptionCommand): DisruptionCommand {
  validateDisruptionCommand(policy);
  return policy;
}

function stablePolicyKey(policy: DisruptionCommand): string {
  return [
    policy.hazardType,
    policy.targetRole,
    policy.durationMs,
    policy.intensity,
  ].join("-");
}
