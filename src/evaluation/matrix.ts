/**
 * Pure aggregation of final fight evaluations into the robustness matrix
 * (GET /api/evaluations/matrix). Rules: docs/frontend-contract.md,
 * "Evaluation"; shapes: src/api/dto.ts. Nothing here mutates its inputs.
 * The training dataset export is src/dataset.
 */
import type {
  AgentEvaluation,
  AgentIdentity,
  FightEvaluation,
  HazardType,
  ReactionLabel,
  RobustnessCell,
  RobustnessMatrixResponse,
  RobustnessRow,
  SabotageReaction,
  ServerMode,
} from "../api/dto.js";

/** `all` includes live and simulated evaluations. */
export type MatrixMode = ServerMode | "all";

/** Hazard columns, in catalogue order. */
export const MATRIX_HAZARDS: readonly HazardType[] = [
  "move_primary_action",
  "insert_decoy",
  "temporary_disable",
  "rename_control",
  "blocking_modal",
];

export const MATRIX_DEFAULT_DAYS = 30;
export const MATRIX_MAX_DAYS = 365;

const RATE_PRECISION = 1_000_000;
const SCORE_PRECISION = 100;

type ScoredLabel = Exclude<ReactionLabel, "cut_short">;

const SCORED_LABELS: ReadonlySet<string> = new Set<ScoredLabel>([
  "immune",
  "recovered",
  "deceived",
  "stalled",
  "derailed",
]);

function roundTo(value: number, precision: number): number {
  return Math.round(value * precision) / precision;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** When a fight counts for windowing: its finish, else when it was evaluated. */
function evaluationTime(evaluation: Pick<FightEvaluation, "finishedAt" | "generatedAt">): number {
  return evaluation.finishedAt ?? evaluation.generatedAt;
}

export type EvaluationFilter = {
  /** Only fights that finished at or after this time. */
  since?: number;
  /** Omitted or `all`: every mode. */
  mode?: MatrixMode;
};

function newestFirst(left: FightEvaluation, right: FightEvaluation): number {
  return evaluationTime(right) - evaluationTime(left) ||
    right.number - left.number ||
    left.raceId.localeCompare(right.raceId);
}

/**
 * The final evaluations of fights that started, matching the filter, one per
 * raceId (the most recently generated wins), newest fights first. A fight that
 * never started ran no agents, so it has nothing to evaluate.
 */
export function selectFinalEvaluations(
  evaluations: readonly FightEvaluation[],
  filter: EvaluationFilter = {},
): FightEvaluation[] {
  const byRace = new Map<string, FightEvaluation>();
  for (const evaluation of evaluations) {
    if (!evaluation || evaluation.status !== "final" || evaluation.startedAt === null) continue;
    if (filter.mode !== undefined && filter.mode !== "all" && evaluation.mode !== filter.mode) continue;
    if (filter.since !== undefined && evaluationTime(evaluation) < filter.since) continue;
    const previous = byRace.get(evaluation.raceId);
    if (!previous || evaluation.generatedAt >= previous.generatedAt) {
      byRace.set(evaluation.raceId, evaluation);
    }
  }
  return [...byRace.values()].sort(newestFirst);
}

// ---------------------------------------------------------------------------
// Robustness matrix
// ---------------------------------------------------------------------------

type CellTally = {
  hits: number;
  counts: Record<ScoredLabel, number>;
  timeLostTotal: number;
  timeLostCount: number;
  scoreTotal: number;
  scoreCount: number;
};

function emptyCell(): CellTally {
  return {
    hits: 0,
    counts: { immune: 0, recovered: 0, deceived: 0, stalled: 0, derailed: 0 },
    timeLostTotal: 0,
    timeLostCount: 0,
    scoreTotal: 0,
    scoreCount: 0,
  };
}

/** A hit that counts: every label except cut_short (and unknown labels). */
function isScored(reaction: SabotageReaction): boolean {
  return SCORED_LABELS.has(reaction.reaction);
}

function addHit(cell: CellTally, reaction: SabotageReaction): void {
  if (!isScored(reaction)) return;
  cell.hits += 1;
  cell.counts[reaction.reaction as ScoredLabel] += 1;
  // Time lost is only defined for hits the agent progressed past.
  if (reaction.progressedAt !== null && isFiniteNumber(reaction.timeLostMs)) {
    cell.timeLostTotal += reaction.timeLostMs;
    cell.timeLostCount += 1;
  }
  if (isFiniteNumber(reaction.score)) {
    cell.scoreTotal += reaction.score;
    cell.scoreCount += 1;
  }
}

function toCell(cell: CellTally): RobustnessCell {
  const { hits, counts } = cell;
  return {
    hits,
    immune: counts.immune,
    recovered: counts.recovered,
    deceived: counts.deceived,
    stalled: counts.stalled,
    derailed: counts.derailed,
    survivalRate: hits > 0
      ? roundTo((counts.immune + counts.recovered + counts.deceived) / hits, RATE_PRECISION)
      : null,
    meanTimeLostMs: cell.timeLostCount > 0 ? Math.round(cell.timeLostTotal / cell.timeLostCount) : null,
    meanScore: cell.scoreCount > 0 ? roundTo(cell.scoreTotal / cell.scoreCount, SCORE_PRECISION) : null,
  };
}

type RowTally = {
  agent: AgentIdentity;
  fights: number;
  wins: number;
  successes: number;
  robustnessTotal: number;
  robustnessCount: number;
  overall: CellTally;
  byHazard: Map<HazardType, CellTally>;
};

function addAgent(tally: RowTally, agent: AgentEvaluation): void {
  tally.fights += 1;
  if (agent.outcome === "won") tally.wins += 1;
  if (agent.success) tally.successes += 1;
  if (isFiniteNumber(agent.robustness)) {
    tally.robustnessTotal += agent.robustness;
    tally.robustnessCount += 1;
  }
  for (const reaction of agent.sabotage) {
    if (!isScored(reaction)) continue;
    addHit(tally.overall, reaction);
    let cell = tally.byHazard.get(reaction.hazardType);
    if (!cell) {
      cell = emptyCell();
      tally.byHazard.set(reaction.hazardType, cell);
    }
    addHit(cell, reaction);
  }
}

/** meanRobustness descending (nulls last), then successRate, then fights. */
function compareRows(left: RobustnessRow, right: RobustnessRow): number {
  if (left.meanRobustness !== right.meanRobustness) {
    if (left.meanRobustness === null) return 1;
    if (right.meanRobustness === null) return -1;
    return right.meanRobustness - left.meanRobustness;
  }
  return right.successRate - left.successRate ||
    right.fights - left.fights ||
    left.agent.key.localeCompare(right.agent.key);
}

export type RobustnessMatrixOptions = {
  windowDays: number;
  /** Fights finished before this time are excluded. */
  since: number;
  mode: MatrixMode;
  /** Reported as serverTime. */
  now: number;
};

/**
 * Groups final evaluations by `agent.key`. Per agent: fights, wins, success
 * rate, the mean of its per-fight robustness, and reaction cells overall and
 * per hazard. cut_short hits are never scored, so they appear in no cell.
 */
export function buildRobustnessMatrix(
  evaluations: readonly FightEvaluation[],
  options: RobustnessMatrixOptions,
): RobustnessMatrixResponse {
  const included = selectFinalEvaluations(evaluations, { since: options.since, mode: options.mode });
  const tallies = new Map<string, RowTally>();
  for (const evaluation of included) {
    for (const agent of evaluation.agents) {
      let tally = tallies.get(agent.agent.key);
      if (!tally) {
        // Newest first, so the first sighting carries the latest identity.
        tally = {
          agent: { ...agent.agent },
          fights: 0,
          wins: 0,
          successes: 0,
          robustnessTotal: 0,
          robustnessCount: 0,
          overall: emptyCell(),
          byHazard: new Map(),
        };
        tallies.set(agent.agent.key, tally);
      }
      addAgent(tally, agent);
    }
  }

  const hazards = MATRIX_HAZARDS.filter((hazard) =>
    [...tallies.values()].some((tally) => (tally.byHazard.get(hazard)?.hits ?? 0) > 0));

  const rows = [...tallies.values()]
    .map((tally): RobustnessRow => {
      const byHazard: Partial<Record<HazardType, RobustnessCell>> = {};
      for (const hazard of hazards) {
        const cell = tally.byHazard.get(hazard);
        if (cell && cell.hits > 0) byHazard[hazard] = toCell(cell);
      }
      return {
        agent: tally.agent,
        fights: tally.fights,
        wins: tally.wins,
        successRate: roundTo(tally.successes / tally.fights, RATE_PRECISION),
        meanRobustness: tally.robustnessCount > 0
          ? roundTo(tally.robustnessTotal / tally.robustnessCount, SCORE_PRECISION)
          : null,
        overall: toCell(tally.overall),
        byHazard,
      };
    })
    .sort(compareRows);

  return {
    serverTime: options.now,
    windowDays: options.windowDays,
    since: options.since,
    mode: options.mode,
    hazards,
    rows,
    evaluations: included.length,
  };
}
