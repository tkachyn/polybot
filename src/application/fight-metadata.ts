import type { AgentIdentity } from "../api/dto.js";
import { DomainError } from "../domain/errors.js";
import {
  HAZARD_TYPES,
  SABOTAGE_DETAIL_MAX,
  SABOTAGE_SUMMARY_MAX,
  type SabotagePlan,
} from "../domain/sabotage.js";
import { validateDisruptionCommand } from "../infra/cdp-obstacle-provider.js";

/** Spectator-facing description of one fight (market). */
export type FightMetadata = {
  /** Sequential fight number, displayed zero-padded. */
  number: number;
  /** At most 90 characters. */
  title: string;
  task: string;
  taskDetail: string;
  successCondition: string;
  /** One label per checkpoint, index k - 1 for checkpoint k. */
  checkpointLabels: string[];
  /** Exactly four, in racer order racer-1..racer-4. */
  agents: AgentIdentity[];
  /** The effective plan, or null when the fight has no sabotage. */
  sabotage: SabotagePlan | null;
  createdAt: number;
  /** Scheduled start for upcoming fights. */
  startsAt: number | null;
};

export type FightMetadataInput = {
  courseId: string;
  checkpointCount: number;
  /** Master task. Used when fight.task is absent. */
  task?: string;
  fight?: Partial<FightMetadata>;
};

export const TITLE_MAX = 90;
export const DEFAULT_SUCCESS_CONDITION =
  "The course verifier confirms the final task state.";
export const UNCONFIGURED_MODEL = "unconfigured";

export const DEFAULT_AGENT_ROSTER: readonly AgentIdentity[] = [
  { key: "gpt", name: "GPT-5.2", provider: "openai", model: UNCONFIGURED_MODEL },
  { key: "claude", name: "Claude Opus 4.6", provider: "anthropic", model: UNCONFIGURED_MODEL },
  { key: "gemini", name: "Gemini 3 Pro", provider: "google", model: UNCONFIGURED_MODEL },
  { key: "grok", name: "Grok 4.1", provider: "xai", model: UNCONFIGURED_MODEL },
];

export function defaultCheckpointLabel(checkpoint: number): string {
  return `Checkpoint ${checkpoint}`;
}

/** Collapses whitespace and truncates to `max` characters with "…". */
export function truncateText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function invalid(message: string): never {
  throw new DomainError("invalid", message);
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${name} must be a non-empty string`);
  }
  return value;
}

function normalizeAgents(agents: unknown): AgentIdentity[] {
  if (agents === undefined || agents === null) {
    return DEFAULT_AGENT_ROSTER.map((agent) => ({ ...agent }));
  }
  if (!Array.isArray(agents) || agents.length !== 4) {
    invalid("agents must contain exactly 4 entries");
  }
  const normalized = agents.map((agent: unknown, index): AgentIdentity => {
    const record = (agent ?? {}) as Partial<AgentIdentity>;
    const label = `agents[${index}]`;
    return {
      key: optionalString(record.key, `${label}.key`) ?? invalid(`${label}.key is required`),
      name: optionalString(record.name, `${label}.name`) ?? invalid(`${label}.name is required`),
      provider: optionalString(record.provider, `${label}.provider`) ??
        invalid(`${label}.provider is required`),
      model: optionalString(record.model, `${label}.model`) ?? UNCONFIGURED_MODEL,
    };
  });
  if (new Set(normalized.map((agent) => agent.key)).size !== normalized.length) {
    invalid("agent keys must be unique");
  }
  return normalized;
}

function normalizeSabotage(
  sabotage: unknown,
  checkpointCount: number,
): SabotagePlan | null {
  if (sabotage === undefined || sabotage === null) return null;
  const plan = sabotage as Partial<SabotagePlan>;
  if (
    !Number.isInteger(plan.checkpoint) ||
    Number(plan.checkpoint) < 1 ||
    Number(plan.checkpoint) > checkpointCount
  ) {
    invalid(`sabotage.checkpoint must be an integer from 1 to ${checkpointCount}`);
  }
  const summary = optionalString(plan.summary, "sabotage.summary") ??
    invalid("sabotage.summary is required");
  if (summary.length > SABOTAGE_SUMMARY_MAX) {
    invalid(`sabotage.summary must be at most ${SABOTAGE_SUMMARY_MAX} characters`);
  }
  const detail = optionalString(plan.detail, "sabotage.detail");
  if (detail !== undefined && detail.length > SABOTAGE_DETAIL_MAX) {
    invalid(`sabotage.detail must be at most ${SABOTAGE_DETAIL_MAX} characters`);
  }
  const normalized: SabotagePlan = { checkpoint: Number(plan.checkpoint), summary };
  if (detail !== undefined) normalized.detail = detail;
  if (plan.policy !== undefined && plan.policy !== null) {
    if (!HAZARD_TYPES.includes(plan.policy.hazardType)) {
      invalid(`sabotage.policy.hazardType must be one of ${HAZARD_TYPES.join(", ")}`);
    }
    try {
      validateDisruptionCommand(plan.policy);
    } catch (error) {
      invalid(`sabotage.policy: ${error instanceof Error ? error.message : String(error)}`);
    }
    normalized.policy = { ...plan.policy };
  }
  return normalized;
}

/**
 * Fills fight metadata defaults and validates operator overrides. Violations
 * throw DomainError `invalid`.
 */
export function normalizeFightMetadata(
  input: FightMetadataInput,
  now = Date.now(),
): FightMetadata {
  const fight = input.fight ?? {};
  const checkpointCount = input.checkpointCount;

  if (fight.number !== undefined && (!Number.isInteger(fight.number) || fight.number < 1)) {
    invalid("fight number must be a positive integer");
  }
  const task = optionalString(fight.task, "task") ??
    optionalString(input.task, "task") ??
    `Complete course ${input.courseId}`;
  const title = optionalString(fight.title, "title");
  if (title !== undefined && title.length > TITLE_MAX) {
    invalid(`title must be at most ${TITLE_MAX} characters`);
  }

  let checkpointLabels: string[];
  if (fight.checkpointLabels === undefined || fight.checkpointLabels === null) {
    checkpointLabels = Array.from(
      { length: checkpointCount },
      (_, index) => defaultCheckpointLabel(index + 1),
    );
  } else {
    if (!Array.isArray(fight.checkpointLabels) ||
      fight.checkpointLabels.length !== checkpointCount) {
      invalid(`checkpointLabels must contain exactly ${checkpointCount} labels`);
    }
    checkpointLabels = fight.checkpointLabels.map((label, index) =>
      optionalString(label, `checkpointLabels[${index}]`) ??
        invalid(`checkpointLabels[${index}] is required`));
  }

  if (fight.createdAt !== undefined && !Number.isFinite(fight.createdAt)) {
    invalid("createdAt must be a timestamp");
  }
  if (fight.startsAt !== undefined && fight.startsAt !== null &&
    !Number.isFinite(fight.startsAt)) {
    invalid("startsAt must be a timestamp");
  }

  return {
    number: fight.number ?? 1,
    title: title ?? truncateText(task, TITLE_MAX),
    task,
    taskDetail: optionalString(fight.taskDetail, "taskDetail") ?? task,
    successCondition: optionalString(fight.successCondition, "successCondition") ??
      DEFAULT_SUCCESS_CONDITION,
    checkpointLabels,
    agents: normalizeAgents(fight.agents),
    sabotage: normalizeSabotage(fight.sabotage, checkpointCount),
    createdAt: fight.createdAt ?? now,
    startsAt: fight.startsAt ?? null,
  };
}
