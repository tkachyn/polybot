/**
 * Where fight dataset records and their bundle files live
 * (docs/training-data.md): in memory for simulated runs, or a directory
 * holding `fights.jsonl` plus the files for live runs.
 */
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { ServerMode } from "../api/dto.js";
import { contentTypeForPath, DATASET_RECORDS_FILE, normalizeDatasetPath } from "./paths.js";
import {
  datasetRecordTime,
  type DatasetFileInput,
  type FightDatasetRecord,
  type StoredDatasetFile,
} from "./types.js";

export type DatasetListFilter = {
  /** Keeps records whose `finishedAt ?? evaluation.generatedAt` is at or after this time. */
  since?: number;
  mode?: ServerMode;
};

/** One record per fight; the latest put per raceId wins. */
export interface DatasetStore {
  /** Stores a fight's record with its bundle files. A bad path rejects the whole put. */
  put(record: FightDatasetRecord, files: readonly DatasetFileInput[]): Promise<void>;
  /** The latest record per raceId, oldest first by `datasetRecordTime`, then raceId. */
  list(filter?: DatasetListFilter): Promise<FightDatasetRecord[]>;
  /** A stored bundle file; null when it is missing or the path is invalid. */
  readFile(path: string): Promise<StoredDatasetFile | null>;
}

function isRecord(value: unknown): value is FightDatasetRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<FightDatasetRecord>;
  return typeof candidate.raceId === "string" &&
    candidate.raceId.length > 0 &&
    typeof candidate.evaluation === "object" &&
    candidate.evaluation !== null &&
    Array.isArray(candidate.agents) &&
    Array.isArray(candidate.events);
}

function assertRecord(record: FightDatasetRecord): void {
  if (!isRecord(record)) {
    throw new Error("dataset record needs a raceId, an evaluation, agents and events");
  }
}

function matches(record: FightDatasetRecord, filter: DatasetListFilter): boolean {
  if (
    typeof filter.since === "number" &&
    Number.isFinite(filter.since) &&
    !(datasetRecordTime(record) >= filter.since)
  ) {
    return false;
  }
  return filter.mode === undefined || record.mode === filter.mode;
}

function compareRecords(left: FightDatasetRecord, right: FightDatasetRecord): number {
  return datasetRecordTime(left) - datasetRecordTime(right) ||
    (left.raceId < right.raceId ? -1 : left.raceId > right.raceId ? 1 : 0);
}

type NormalizedFile = { path: string; contentType: string; body: Buffer };

/** Validates every file before anything is stored. A repeated path keeps its last body. */
function normalizeFiles(files: readonly DatasetFileInput[]): NormalizedFile[] {
  if (!Array.isArray(files)) throw new Error("dataset files must be an array");
  const byPath = new Map<string, NormalizedFile>();
  for (const file of files) {
    if (typeof file !== "object" || file === null) throw new Error("dataset file must be an object");
    const path = normalizeDatasetPath(file.path);
    const body = typeof file.body === "string"
      ? Buffer.from(file.body, "utf8")
      : file.body instanceof Uint8Array
        ? Buffer.from(file.body)
        : null;
    if (!body) throw new Error(`dataset file body must be a Buffer or a string: ${path}`);
    const contentType = typeof file.contentType === "string" && file.contentType.length > 0
      ? file.contentType
      : contentTypeForPath(path);
    byPath.set(path, { path, contentType, body });
  }
  return [...byPath.values()];
}

export const MEMORY_DATASET_MAX_FIGHTS = 200;
export const MEMORY_DATASET_MAX_BYTES = 256 * 1024 * 1024;

export type InMemoryDatasetStoreOptions = {
  /** Fights kept; the oldest put is evicted first. Default 200. */
  maxFights?: number;
  /** Record JSON plus file bytes kept. Default 256 MiB. */
  maxBytes?: number;
};

type MemoryEntry = { record: FightDatasetRecord; paths: Set<string>; bytes: number };
type MemoryFile = { raceId: string; contentType: string; body: Buffer };

/**
 * Simulated mode: the latest ~200 fights and their files, for the life of the
 * process. A put is applied synchronously, before its promise settles, so a
 * record is listed as soon as `put` has been called.
 */
export class InMemoryDatasetStore implements DatasetStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly files = new Map<string, MemoryFile>();
  private readonly maxFights: number;
  private readonly maxBytes: number;
  private totalBytes = 0;

  constructor(options: InMemoryDatasetStoreOptions = {}) {
    this.maxFights = Math.max(1, Math.floor(options.maxFights ?? MEMORY_DATASET_MAX_FIGHTS));
    this.maxBytes = Math.max(0, options.maxBytes ?? MEMORY_DATASET_MAX_BYTES);
  }

  /** Fights currently kept. */
  get size(): number {
    return this.entries.size;
  }

  async put(record: FightDatasetRecord, files: readonly DatasetFileInput[]): Promise<void> {
    assertRecord(record);
    const normalized = normalizeFiles(files);
    const copy = structuredClone(record);
    const entry: MemoryEntry = {
      record: copy,
      paths: new Set(),
      bytes: Buffer.byteLength(JSON.stringify(copy), "utf8"),
    };
    this.remove(copy.raceId);
    for (const file of normalized) {
      this.detach(file.path);
      this.files.set(file.path, { raceId: copy.raceId, contentType: file.contentType, body: file.body });
      entry.paths.add(file.path);
      entry.bytes += file.body.length;
    }
    this.entries.set(copy.raceId, entry);
    this.totalBytes += entry.bytes;
    this.evict(copy.raceId);
  }

  async list(filter: DatasetListFilter = {}): Promise<FightDatasetRecord[]> {
    return [...this.entries.values()]
      .map((entry) => entry.record)
      .filter((record) => matches(record, filter))
      .sort(compareRecords)
      .map((record) => structuredClone(record));
  }

  async readFile(path: string): Promise<StoredDatasetFile | null> {
    let key: string;
    try {
      key = normalizeDatasetPath(path);
    } catch {
      return null;
    }
    const file = this.files.get(key);
    return file ? { contentType: file.contentType, body: Buffer.from(file.body) } : null;
  }

  private remove(raceId: string): void {
    const entry = this.entries.get(raceId);
    if (!entry) return;
    this.entries.delete(raceId);
    this.totalBytes -= entry.bytes;
    for (const path of entry.paths) {
      if (this.files.get(path)?.raceId === raceId) this.files.delete(path);
    }
  }

  /** Another fight's file at this path is replaced: the latest put wins. */
  private detach(path: string): void {
    const previous = this.files.get(path);
    if (!previous) return;
    this.files.delete(path);
    const owner = this.entries.get(previous.raceId);
    if (owner?.paths.delete(path)) {
      owner.bytes -= previous.body.length;
      this.totalBytes -= previous.body.length;
    }
  }

  /** Drops the oldest fights until both bounds hold. The fight just put always stays. */
  private evict(keep: string): void {
    for (const raceId of [...this.entries.keys()]) {
      if (this.entries.size <= this.maxFights && this.totalBytes <= this.maxBytes) return;
      if (raceId !== keep) this.remove(raceId);
    }
  }
}

/**
 * Live mode: `<dir>/fights.jsonl` holds one record per line (the latest line
 * per raceId wins) and bundle files live under `<dir>/`. Writes are
 * serialised, and each put writes its files before appending its record, so
 * a listed record's files are already on disk. Files are written under a
 * temporary name and renamed. Reads stream the records file; a torn last line
 * is skipped and the next append starts on a fresh line.
 */
export class JsonlDatasetStore implements DatasetStore {
  readonly dir: string;
  private readonly recordsPath: string;
  private tail: Promise<void> = Promise.resolve();
  private endChecked = false;

  constructor(dir: string) {
    if (!dir) throw new Error("Dataset directory is required");
    this.dir = resolve(dir);
    this.recordsPath = join(this.dir, DATASET_RECORDS_FILE);
  }

  put(record: FightDatasetRecord, files: readonly DatasetFileInput[]): Promise<void> {
    let line: string;
    let normalized: NormalizedFile[];
    try {
      assertRecord(record);
      line = `${JSON.stringify(record)}\n`;
      normalized = normalizeFiles(files);
      for (const file of normalized) this.target(file.path);
    } catch (error) {
      return Promise.reject(error);
    }
    const write = this.tail.then(async () => {
      for (const file of normalized) await this.writeBundleFile(file);
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.recordsPath, `${await this.separator()}${line}`, "utf8");
    });
    this.tail = write.catch(() => undefined);
    return write;
  }

  async list(filter: DatasetListFilter = {}): Promise<FightDatasetRecord[]> {
    await this.tail;
    let handle: FileHandle;
    try {
      handle = await open(this.recordsPath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const latest = new Map<string, FightDatasetRecord>();
    try {
      const lines = createInterface({
        input: handle.createReadStream({ encoding: "utf8", autoClose: false }),
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      for await (const line of lines) {
        if (line.trim().length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // A torn or corrupt line (e.g. a crash mid-append) is skipped.
          continue;
        }
        if (!isRecord(parsed)) continue;
        // The latest line per raceId wins, so a newer line outside the
        // filter also removes an older one inside it.
        if (matches(parsed, filter)) latest.set(parsed.raceId, parsed);
        else latest.delete(parsed.raceId);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    return [...latest.values()].sort(compareRecords);
  }

  async readFile(path: string): Promise<StoredDatasetFile | null> {
    let normalized: string;
    let target: string;
    try {
      normalized = normalizeDatasetPath(path);
      target = this.target(normalized);
    } catch {
      return null;
    }
    await this.tail;
    try {
      return { contentType: contentTypeForPath(normalized), body: await readFile(target) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return null;
      throw error;
    }
  }

  /** The absolute file for a normalised bundle path. Throws if it would leave the directory. */
  private target(path: string): string {
    const target = resolve(this.dir, ...path.split("/"));
    if (!target.startsWith(`${this.dir}${sep}`)) {
      throw new Error(`dataset path escapes the store: ${path}`);
    }
    return target;
  }

  private async writeBundleFile(file: NormalizedFile): Promise<void> {
    const target = this.target(file.path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, file.body);
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  /** "\n" when the records file ends mid-line (a torn append), so the next line starts clean. */
  private async separator(): Promise<string> {
    if (this.endChecked) return "";
    this.endChecked = true;
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.recordsPath, "r");
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
}
