import { appendFile, mkdir, open, readFile, stat, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { FightEvaluation, ServerMode } from "../api/dto.js";

export type EvaluationListFilter = {
  /** Keeps evaluations whose `finishedAt ?? generatedAt` is at or after this time. */
  since?: number;
  mode?: ServerMode;
};

/** Final fight evaluations, one per raceId: the latest put wins. */
export interface EvaluationStore {
  put(evaluation: FightEvaluation): Promise<void>;
  get(raceId: string): Promise<FightEvaluation | null>;
  /** Oldest first by `finishedAt ?? generatedAt`, then raceId. */
  list(filter?: EvaluationListFilter): Promise<FightEvaluation[]>;
}

/** The time `list({ since })` filters on. */
export function evaluationTime(
  evaluation: Pick<FightEvaluation, "finishedAt" | "generatedAt">,
): number {
  return evaluation.finishedAt ?? evaluation.generatedAt;
}

function assertEvaluation(evaluation: FightEvaluation): void {
  if (
    !evaluation ||
    typeof evaluation !== "object" ||
    typeof evaluation.raceId !== "string" ||
    evaluation.raceId.length === 0
  ) {
    throw new Error("evaluation.raceId is required");
  }
}

function isEvaluation(value: unknown): value is FightEvaluation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<FightEvaluation>;
  return typeof candidate.raceId === "string" &&
    candidate.raceId.length > 0 &&
    Array.isArray(candidate.agents);
}

function matches(evaluation: FightEvaluation, filter: EvaluationListFilter): boolean {
  if (
    typeof filter.since === "number" &&
    Number.isFinite(filter.since) &&
    !(evaluationTime(evaluation) >= filter.since)
  ) {
    return false;
  }
  return filter.mode === undefined || evaluation.mode === filter.mode;
}

function select(
  evaluations: Iterable<FightEvaluation>,
  filter: EvaluationListFilter = {},
): FightEvaluation[] {
  return [...evaluations]
    .filter((evaluation) => matches(evaluation, filter))
    .sort((left, right) =>
      evaluationTime(left) - evaluationTime(right) ||
      (left.raceId < right.raceId ? -1 : left.raceId > right.raceId ? 1 : 0))
    .map((evaluation) => structuredClone(evaluation));
}

/** Simulated mode: evaluations live as long as the process. */
export class InMemoryEvaluationStore implements EvaluationStore {
  private readonly evaluations = new Map<string, FightEvaluation>();

  async put(evaluation: FightEvaluation): Promise<void> {
    assertEvaluation(evaluation);
    this.evaluations.set(evaluation.raceId, structuredClone(evaluation));
  }

  async get(raceId: string): Promise<FightEvaluation | null> {
    const evaluation = this.evaluations.get(raceId);
    return evaluation ? structuredClone(evaluation) : null;
  }

  async list(filter?: EvaluationListFilter): Promise<FightEvaluation[]> {
    return select(this.evaluations.values(), filter);
  }
}

/**
 * Append-only JSONL: one evaluation per line, the latest line per raceId
 * wins. Writes are serialised. Reads parse the file once and then follow
 * this process's own appends; a size change from another writer triggers a
 * full re-read. A missing file reads as empty and a torn line is skipped.
 */
export class JsonlEvaluationStore implements EvaluationStore {
  private tail: Promise<void> = Promise.resolve();
  private cache: Map<string, FightEvaluation> | null = null;
  private cachedBytes = 0;
  private endChecked = false;

  constructor(private readonly filePath: string) {
    if (!filePath) throw new Error("Evaluation store file path is required");
  }

  put(evaluation: FightEvaluation): Promise<void> {
    let line: string;
    try {
      assertEvaluation(evaluation);
      line = `${JSON.stringify(evaluation)}\n`;
    } catch (error) {
      return Promise.reject(error);
    }
    const write = this.tail.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const text = `${await this.separator()}${line}`;
      await appendFile(this.filePath, text, "utf8");
      if (this.cache) {
        this.cache.set(evaluation.raceId, JSON.parse(line) as FightEvaluation);
        this.cachedBytes += Buffer.byteLength(text, "utf8");
      }
    });
    this.tail = write.catch(() => undefined);
    return write;
  }

  /** "\n" when the file ends mid-line (a torn append), so the next line starts clean. */
  private async separator(): Promise<string> {
    if (this.endChecked) return "";
    this.endChecked = true;
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.filePath, "r");
      const { size } = await handle.stat();
      if (size === 0) return "";
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      return last[0] === 0x0a ? "" : "\n";
    } catch {
      return "";
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async get(raceId: string): Promise<FightEvaluation | null> {
    const evaluation = (await this.load()).get(raceId);
    return evaluation ? structuredClone(evaluation) : null;
  }

  async list(filter?: EvaluationListFilter): Promise<FightEvaluation[]> {
    return select((await this.load()).values(), filter);
  }

  private async load(): Promise<Map<string, FightEvaluation>> {
    await this.tail;
    let size: number;
    try {
      size = (await stat(this.filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cache = new Map();
      this.cachedBytes = 0;
      return this.cache;
    }
    if (this.cache && size === this.cachedBytes) return this.cache;

    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      contents = "";
    }
    const evaluations = new Map<string, FightEvaluation>();
    for (const line of contents.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isEvaluation(parsed)) evaluations.set(parsed.raceId, parsed);
      } catch {
        // A torn or corrupt line (e.g. a crash mid-append) is skipped.
      }
    }
    this.cache = evaluations;
    this.cachedBytes = Buffer.byteLength(contents, "utf8");
    return evaluations;
  }
}
