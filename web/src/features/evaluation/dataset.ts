/**
 * The training dataset on "/evaluations": what each downloadable file holds,
 * and the warning shown when the download includes simulated rows. Schema and
 * rules: docs/training-data.md; types: "Dataset export" in @contract.
 */
import type { DatasetFile } from "@contract";
import type { EvaluationMode } from "../../api/client";
import { formatNumber } from "../../lib/format";

/** A file that downloads on its own as well as inside the zip. */
export type DatasetDownload = DatasetFile | "manifest";

export type DatasetFileInfo = {
  file: DatasetDownload;
  /** Its name inside the zip, and the single-file download's name. */
  name: string;
  /** One line: what a row is, and what it is for. */
  description: string;
};

/** Keyed by file, so a new contract file fails the build until it is described. The core record first. */
const CATALOGUE: Readonly<Record<DatasetDownload, Omit<DatasetFileInfo, "file">>> = {
  steps: {
    name: "steps.jsonl",
    description:
      "One row per agent step: what the model saw, its action and reasoning, the verified result, the sabotage in effect and Steel’s browser events. The core training record.",
  },
  episodes: {
    name: "episodes.jsonl",
    description: "One row per agent per fight: outcome, robustness and reactions to each sabotage.",
  },
  sft: {
    name: "sft.jsonl",
    description: "Chat-format examples from good steps of successful runs, for supervised fine-tuning.",
  },
  preferences: {
    name: "preferences.jsonl",
    description: "Pairs from sabotage moments: the action that worked vs one that failed, for DPO.",
  },
  manifest: {
    name: "manifest.json",
    description: "Filters and row counts, plus the agents’ system prompt and action tool, so sft.jsonl replays as-is.",
  },
};

export const DATASET_FILES: readonly DatasetFileInfo[] = (Object.keys(CATALOGUE) as DatasetDownload[]).map((file) => ({ file, ...CATALOGUE[file] }));

/** Fallback name for the zip; the server's dated attachment name wins. */
export const DATASET_ZIP_NAME = "sabotage-markets-dataset.zip";

/** Every fight carries exactly four agents, so each fight adds four episodes. */
export const AGENTS_PER_FIGHT = 4;

/** Shown beside the disabled downloads when the window has no fight. */
export const EMPTY_DATASET_COPY = "No fights in this window";

export type DatasetScope = {
  /** No fight in the window and mode: every download would be empty, so they are disabled. */
  empty: boolean;
  /** "12 fights · 48 episodes", {@link EMPTY_DATASET_COPY}, or null while the count is unknown. */
  summary: string | null;
};

/**
 * What the window's download holds, from its fight count (the matrix's final
 * evaluations). An unknown count (loading, or the matrix failed) keeps the
 * downloads enabled: the server can still answer.
 */
export function datasetScope(fights: number | null): DatasetScope {
  if (fights === null) return { empty: false, summary: null };
  if (fights <= 0) return { empty: true, summary: EMPTY_DATASET_COPY };
  const episodes = fights * AGENTS_PER_FIGHT;
  return { empty: false, summary: `${formatNumber(fights)} ${fights === 1 ? "fight" : "fights"} · ${formatNumber(episodes)} episodes` };
}

const SIMULATED_ROWS = "Simulated rows are scripted agents, not real models, and shouldn’t be used for training.";

/**
 * The warning for a download that includes simulated rows (mode simulated or
 * all); null for live rows only, or while the mode is unknown.
 */
export function simulatedDatasetWarning(mode: EvaluationMode | null): string | null {
  if (mode === "simulated") return SIMULATED_ROWS;
  if (mode === "all") return `${SIMULATED_ROWS} Every row records its mode, so you can filter them out.`;
  return null;
}
