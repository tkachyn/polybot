/**
 * The training dataset on "/evaluations": what each downloadable file holds,
 * and the warning shown when the download includes simulated rows. Schema and
 * rules: docs/training-data.md; types: "Dataset export" in @contract.
 */
import type { DatasetFile } from "@contract";
import type { EvaluationMode } from "../../api/client";

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
