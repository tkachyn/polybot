import type { AgentIdentity } from "../api/dto.js";
import {
  DEFAULT_AGENT_ROSTER,
  UNCONFIGURED_MODEL,
} from "../application/fight-metadata.js";
import {
  createCompetitorModel,
  type CreateCompetitorModelOptions,
} from "./openai-compatible-model.js";
import type { CompetitorDecisionModel } from "./playwright-competitor-runner.js";

export type RosterEnv = Record<string, string | undefined>;

/** Fallback model for anthropic racers without their own model. */
export const ANTHROPIC_FALLBACK_MODEL_ENV = "COMPETITOR_LLM_MODEL";
export const ROSTER_SIZE = 4;

function envValue(env: RosterEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** "racer-1".."racer-4", matching the engine's racer ids. */
export function racerIdAt(index: number): string {
  return `racer-${index + 1}`;
}

/**
 * The live roster: the fight's agents (or the default roster) with
 * RACER_n_PROVIDER / _MODEL / _NAME / _KEY overrides applied, n = 1..4.
 * Anthropic racers without a model fall back to COMPETITOR_LLM_MODEL. The
 * model stays "unconfigured" when nothing supplies one.
 */
export function resolveCompetitorRoster(
  agents: readonly AgentIdentity[] | undefined,
  env: RosterEnv = process.env,
): AgentIdentity[] {
  const base = agents ?? DEFAULT_AGENT_ROSTER;
  if (base.length !== ROSTER_SIZE) {
    throw new Error(`A live fight needs exactly ${ROSTER_SIZE} agents, got ${base.length}`);
  }
  return base.map((agent, index): AgentIdentity => {
    const prefix = `RACER_${index + 1}_`;
    const provider = envValue(env, `${prefix}PROVIDER`) ?? agent.provider;
    const ownModel = agent.model && agent.model !== UNCONFIGURED_MODEL ? agent.model : undefined;
    const model = envValue(env, `${prefix}MODEL`) ??
      ownModel ??
      (provider === "anthropic" ? envValue(env, ANTHROPIC_FALLBACK_MODEL_ENV) : undefined) ??
      UNCONFIGURED_MODEL;
    return {
      key: envValue(env, `${prefix}KEY`) ?? agent.key,
      name: envValue(env, `${prefix}NAME`) ?? agent.name,
      provider,
      model,
    };
  });
}

export type CompetitorModelFactory = (
  options: CreateCompetitorModelOptions,
) => CompetitorDecisionModel;

/**
 * One decision model per racer id. Collects every configuration problem
 * (missing model, unknown provider, missing key) into one Error.
 */
export function createRosterModels(
  roster: readonly AgentIdentity[],
  env: RosterEnv = process.env,
  create: CompetitorModelFactory = createCompetitorModel,
): Map<string, CompetitorDecisionModel> {
  const models = new Map<string, CompetitorDecisionModel>();
  const problems: string[] = [];
  roster.forEach((agent, index) => {
    const racerId = racerIdAt(index);
    const label = `${racerId} (${agent.name}, ${agent.provider})`;
    if (!agent.model || agent.model === UNCONFIGURED_MODEL) {
      const fallback = agent.provider === "anthropic"
        ? ` or ${ANTHROPIC_FALLBACK_MODEL_ENV}`
        : "";
      problems.push(`${label} has no model: set RACER_${index + 1}_MODEL${fallback}`);
      return;
    }
    try {
      models.set(racerId, create({ provider: agent.provider, model: agent.model, env }));
    } catch (error) {
      problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  if (problems.length > 0) {
    throw new Error(`Live competitor configuration is incomplete: ${problems.join("; ")}`);
  }
  return models;
}
