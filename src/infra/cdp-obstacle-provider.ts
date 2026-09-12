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

/** Decoy labels by intensity (1-3). Later entries are collision fallbacks. */
export const DECOY_LABELS = [
  "Continue",
  "Proceed to next step",
  "Continue (recommended)",
] as const;
const DECOY_FALLBACK_LABELS = ["Next", "Go on", "Keep going", "Skip ahead"] as const;
/** rename_control labels by intensity (1-3). */
export const RENAME_LABELS = ["Unavailable", "Not now", "Cancel"] as const;
/** The Close control inside a blocking_modal overlay. */
export const DISMISS_OVERLAY_ROLE = "dismiss-overlay";
export const DISMISS_OVERLAY_LABEL = "Close";
/** The disclosure that hides the target during move_primary_action. */
export const MORE_ACTIONS_ROLE = "more-actions";
export const MORE_ACTIONS_LABEL = "More options";
/** Planted decoys get `id="arena-decoy-…"`; Steel traces report ids, not data-*. */
export const DECOY_ID_PREFIX = "arena-decoy-";

/**
 * The page script for one hazard, evaluated through CDP. Every hazard reverts
 * after `durationMs` by restoring the exact original attributes, children and
 * nodes, so a second revert or an earlier partial one (Close, disclosure) is
 * harmless. Returns `{ applied, reason? }`.
 */
export function buildDisruptionScript(
  command: DisruptionCommand,
  disruptionId: string,
): string {
  validateDisruptionCommand(command);
  const role = JSON.stringify(command.targetRole);
  const id = JSON.stringify(disruptionId);
  const hazard = JSON.stringify(command.hazardType);
  const duration = command.durationMs;
  const intensity = command.intensity;

  return `
    (() => {
      const role = ${role};
      const disruptionId = ${id};
      const hazardType = ${hazard};
      const durationMs = ${duration};
      const intensity = ${intensity};
      const decoyLabels = ${JSON.stringify([...DECOY_LABELS, ...DECOY_FALLBACK_LABELS])};
      const renameLabels = ${JSON.stringify(RENAME_LABELS)};
      const registryKey = "__arenaDisruptions";
      if (!window[registryKey]) {
        Object.defineProperty(window, registryKey, { value: Object.create(null), configurable: true });
      }
      const registry = window[registryKey];
      const selector = '[data-arena-role="' + CSS.escape(role) + '"]';
      const marker = '[data-arena-disruption-id="' + CSS.escape(disruptionId) + '"]';

      if (registry[disruptionId] || document.querySelector(marker)) {
        return { applied: false, reason: "already_applied" };
      }

      // Never aim at a decoy planted by an earlier hazard.
      const target = document.querySelector(selector + ':not([data-arena-decoy="true"])');
      if (!target && hazardType !== "blocking_modal") {
        return { applied: false, reason: "target_not_found" };
      }

      const undo = [];
      const timers = [];
      const saved = new Map();
      const rememberAttribute = (element, name) => {
        let attributes = saved.get(element);
        if (!attributes) {
          attributes = new Map();
          saved.set(element, attributes);
        }
        if (attributes.has(name)) return;
        attributes.set(name, element.getAttribute(name));
        undo.push(() => restoreAttribute(element, name));
      };
      const restoreAttribute = (element, name) => {
        const attributes = saved.get(element);
        if (!attributes || !attributes.has(name)) return;
        const previous = attributes.get(name);
        if (previous === null) element.removeAttribute(name);
        else element.setAttribute(name, previous);
      };
      const setStyle = (element, property, value) => {
        rememberAttribute(element, "style");
        element.style.setProperty(property, value, "important");
      };
      const normalize = (text) => String(text || "").replace(/\\s+/g, " ").trim();
      const labelOf = (element) => normalize(
        element.innerText || element.textContent ||
        element.getAttribute("aria-label") || element.value || "",
      );
      const sameLabel = (a, b) => normalize(a).toLowerCase() === normalize(b).toLowerCase();
      const overlaps = (a, b) => {
        const left = normalize(a).toLowerCase();
        const right = normalize(b).toLowerCase();
        return left.length > 0 && right.length > 0 && (left.includes(right) || right.includes(left));
      };
      // Replaces the visible label; the original child nodes come back on revert.
      const setLabel = (element, label, reversible) => {
        if (element.tagName === "INPUT") {
          if (reversible) rememberAttribute(element, "value");
          element.setAttribute("value", label);
        } else {
          const children = Array.from(element.childNodes);
          element.replaceChildren(document.createTextNode(label));
          if (reversible) undo.push(() => element.replaceChildren(...children));
        }
        if (element.hasAttribute("aria-label")) {
          if (reversible) rememberAttribute(element, "aria-label");
          element.setAttribute("aria-label", label);
        }
      };
      const uniqueId = (base) => {
        let candidate = base;
        for (let suffix = 2; document.getElementById(candidate); suffix += 1) {
          candidate = base + "-" + suffix;
        }
        return candidate;
      };

      let reverted = false;
      const revert = () => {
        if (reverted) return;
        reverted = true;
        timers.forEach((timer) => window.clearTimeout(timer));
        undo.reverse().forEach((step) => {
          try { step(); } catch (error) { /* keep reverting */ }
        });
      };

      try {
        if (target) {
          rememberAttribute(target, "data-arena-disruption-id");
        }

        if (hazardType === "blocking_modal") {
          const overlay = document.createElement("div");
          overlay.setAttribute("data-arena-disruption-id", disruptionId);
          overlay.setAttribute("role", "dialog");
          overlay.setAttribute("aria-modal", "true");
          Object.assign(overlay.style, {
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
          const panel = document.createElement("div");
          Object.assign(panel.style, {
            display: "grid",
            gap: "16px",
            justifyItems: "center",
            padding: "24px 32px",
            borderRadius: "12px",
            background: "rgba(20, 20, 20, 0.95)",
          });
          const message = document.createElement("p");
          message.style.margin = "0";
          message.textContent = "The interface is temporarily unavailable";
          panel.appendChild(message);
          const close = document.createElement("button");
          close.type = "button";
          close.setAttribute("data-arena-role", ${JSON.stringify(DISMISS_OVERLAY_ROLE)});
          close.textContent = ${JSON.stringify(DISMISS_OVERLAY_LABEL)};
          Object.assign(close.style, {
            padding: "8px 20px",
            fontSize: "16px",
            cursor: "pointer",
          });
          close.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            overlay.remove();
          });
          overlay.appendChild(panel);
          if (intensity >= 3) {
            timers.push(window.setTimeout(() => {
              if (!reverted) panel.appendChild(close);
            }, Math.floor(durationMs / 2)));
          } else {
            panel.appendChild(close);
          }
          (document.body || document.documentElement).appendChild(overlay);
          undo.push(() => overlay.remove());
        } else if (hazardType === "move_primary_action") {
          const disclosure = document.createElement("button");
          disclosure.type = "button";
          disclosure.setAttribute("data-arena-role", ${JSON.stringify(MORE_ACTIONS_ROLE)});
          disclosure.setAttribute("data-arena-disruption-id", disruptionId);
          disclosure.setAttribute("aria-expanded", "false");
          disclosure.textContent = ${JSON.stringify(MORE_ACTIONS_LABEL)};
          disclosure.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            restoreAttribute(target, "style");
            disclosure.remove();
          });
          setStyle(target, "display", "none");
          target.parentNode.insertBefore(disclosure, target);
          undo.push(() => disclosure.remove());
        } else if (hazardType === "insert_decoy") {
          const decoy = target.cloneNode(true);
          [decoy, ...decoy.querySelectorAll("*")].forEach((element) => {
            Array.from(element.attributes).forEach((attribute) => {
              if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
            });
            if (element !== decoy) element.removeAttribute("id");
          });
          ["name", "form", "aria-labelledby", "aria-describedby"].forEach((name) => {
            decoy.removeAttribute(name);
          });
          // Placed first, a submit clone would become the form's default
          // button and swallow Enter-key submission; it only traps clicks.
          if ((decoy.tagName === "BUTTON" || decoy.tagName === "INPUT") && decoy.type === "submit") {
            decoy.setAttribute("type", "button");
          }
          decoy.setAttribute("data-arena-decoy", "true");
          decoy.setAttribute("data-arena-disruption-id", disruptionId);
          const suffix = disruptionId.replace(/^disruption-/, "").replace(/[^A-Za-z0-9_-]+/g, "-") || "1";
          decoy.id = uniqueId(${JSON.stringify(DECOY_ID_PREFIX)} + suffix);
          const targetLabel = labelOf(target);
          const preferred = [decoyLabels[intensity - 1], ...decoyLabels];
          const label = preferred.find((candidate) => !overlaps(candidate, targetLabel)) ||
            preferred.find((candidate) => !sameLabel(candidate, targetLabel)) ||
            preferred[0];
          setLabel(decoy, label, false);
          decoy.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
          });
          target.parentNode.insertBefore(decoy, target);
          undo.push(() => decoy.remove());
        } else if (hazardType === "temporary_disable") {
          if ("disabled" in target) {
            rememberAttribute(target, "disabled");
            target.setAttribute("disabled", "");
          }
          rememberAttribute(target, "aria-disabled");
          target.setAttribute("aria-disabled", "true");
          setStyle(target, "pointer-events", "none");
          setStyle(target, "opacity", "0.45");
        } else if (hazardType === "rename_control") {
          const current = labelOf(target);
          const preferred = [renameLabels[intensity - 1], ...renameLabels];
          const label = preferred.find((candidate) => !sameLabel(candidate, current)) || preferred[0];
          setLabel(target, label, true);
        }

        if (target) target.setAttribute("data-arena-disruption-id", disruptionId);
      } catch (error) {
        revert();
        return { applied: false, reason: "apply_failed" };
      }

      registry[disruptionId] = { hazardType, revert };
      timers.push(window.setTimeout(revert, durationMs));
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
