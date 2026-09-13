/**
 * The dataset bundle (docs/training-data.md, "Download"): manifest.json, the
 * four JSON Lines files, then every listed screenshot and raw Steel trace,
 * read back from the store. A listed file the store no longer has is left
 * out, the rows that named it point to null instead, and the manifest counts
 * and notes say so.
 */
import { strToU8, zipSync, type Zippable } from "fflate";
import type { DatasetManifest } from "../api/dto.js";
import { toJsonl, type DatasetRows } from "./build.js";
import type { DatasetStore } from "./store.js";

/** Formats that are already compressed are stored rather than deflated again. */
const STORED_CONTENT_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);
/** ZIP (DOS) timestamps cover 1980 to 2099. */
const ZIP_TIME_MIN = Date.UTC(1980, 0, 2);
const ZIP_TIME_MAX = Date.UTC(2099, 11, 30);

export async function buildDatasetZip(
  rows: DatasetRows,
  store: Pick<DatasetStore, "readFile">,
): Promise<Uint8Array> {
  const traces = new Set(rows.episodes
    .map((episode) => episode.steelTraceFile)
    .filter((path): path is string => path !== null));
  const bundled: Array<{ path: string; body: Uint8Array; level: 0 | 6 }> = [];
  const missing = new Set<string>();
  let screenshots = 0;
  let steelTraces = 0;
  for (const path of rows.files) {
    let file: Awaited<ReturnType<DatasetStore["readFile"]>> = null;
    try {
      file = await store.readFile(path);
    } catch {
      file = null;
    }
    if (!file) {
      missing.add(path);
      continue;
    }
    bundled.push({ path, body: file.body, level: STORED_CONTENT_TYPES.has(file.contentType) ? 0 : 6 });
    if (traces.has(path)) steelTraces += 1;
    else screenshots += 1;
  }

  const steps = missing.size === 0
    ? rows.steps
    : rows.steps.map((step) =>
      step.screenshot !== null && missing.has(step.screenshot) ? { ...step, screenshot: null } : step);
  const episodes = missing.size === 0
    ? rows.episodes
    : rows.episodes.map((episode) =>
      episode.steelTraceFile !== null && missing.has(episode.steelTraceFile)
        ? { ...episode, steelTraceFile: null }
        : episode);
  const manifest: DatasetManifest = {
    ...rows.manifest,
    counts: { ...rows.manifest.counts, screenshots, steelTraces },
    notes: missing.size === 0
      ? [...rows.manifest.notes]
      : [
          ...rows.manifest.notes,
          `${missing.size} listed ${missing.size === 1 ? "file was" : "files were"} missing from storage and left out; the rows that named ${missing.size === 1 ? "it" : "them"} point to null.`,
        ],
  };

  const zippable: Zippable = {
    "manifest.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
    "episodes.jsonl": strToU8(toJsonl(episodes)),
    "steps.jsonl": strToU8(toJsonl(steps)),
    "sft.jsonl": strToU8(toJsonl(rows.sft)),
    "preferences.jsonl": strToU8(toJsonl(rows.preferences)),
  };
  for (const { path, body, level } of bundled) {
    if (!Object.hasOwn(zippable, path)) zippable[path] = [body, { level }];
  }
  // A fixed modification time keeps the archive a function of its rows.
  const mtime = Math.min(ZIP_TIME_MAX, Math.max(ZIP_TIME_MIN, rows.manifest.generatedAt));
  return zipSync(zippable, { level: 6, mtime: Number.isFinite(mtime) ? mtime : ZIP_TIME_MIN });
}
