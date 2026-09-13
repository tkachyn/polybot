/**
 * Bundle paths for dataset files. A path is relative, "/"-separated and made
 * of sanitised segments, so a raceId or racerId can never escape the bundle
 * or the store's directory.
 */

/** The records file at the root of a JSONL dataset store; no bundle file may shadow it. */
export const DATASET_RECORDS_FILE = "fights.jsonl";

const SEGMENT_MAX = 128;
const PATH_MAX = 1_024;

const FRAME_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/svg+xml", "svg"],
  ["image/webp", "webp"],
]);

const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
  ["webp", "image/webp"],
  ["json", "application/json"],
  ["jsonl", "application/x-ndjson"],
]);

/** One path segment reduced to `[A-Za-z0-9._-]`: never empty, and never starting with a dot. */
export function sanitizePathSegment(value: string): string {
  const cleaned = String(value)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\./, "_")
    .slice(0, SEGMENT_MAX);
  return cleaned.length > 0 ? cleaned : "_";
}

/**
 * Validates a bundle path and returns it with every segment sanitised.
 * Rejects absolute paths, backslashes, drive letters, empty, "." and ".."
 * segments, files at the root, and anything under the records file.
 */
export function normalizeDatasetPath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || path.length > PATH_MAX) {
    throw new Error("dataset path must be a non-empty relative path");
  }
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`dataset path must be relative: ${path}`);
  }
  const segments = path.split("/");
  if (segments.length < 2) {
    throw new Error(`dataset path must be inside a directory: ${path}`);
  }
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`dataset path must not contain empty, "." or ".." segments: ${path}`);
  }
  const clean = segments.map(sanitizePathSegment);
  if (clean[0].toLowerCase() === DATASET_RECORDS_FILE) {
    throw new Error(`dataset path must not shadow ${DATASET_RECORDS_FILE}: ${path}`);
  }
  return clean.join("/");
}

/** `assets/<raceId>/<racerId>/step-0007.<ext>`; null for a content type that is not a frame image. */
export function screenshotPath(
  raceId: string,
  racerId: string,
  step: number,
  contentType: string,
): string | null {
  const extension = FRAME_EXTENSIONS.get(contentType);
  if (!extension || !Number.isSafeInteger(step) || step < 0) return null;
  const file = `step-${String(step).padStart(4, "0")}.${extension}`;
  return `assets/${sanitizePathSegment(raceId)}/${sanitizePathSegment(racerId)}/${file}`;
}

/** `steel/<raceId>/<racerId>.trace.json`. */
export function steelTracePath(raceId: string, racerId: string): string {
  return `steel/${sanitizePathSegment(raceId)}/${sanitizePathSegment(racerId)}.trace.json`;
}

/** A bundle file's content type, from its extension. */
export function contentTypeForPath(path: string): string {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return (extension && CONTENT_TYPES.get(extension)) || "application/octet-stream";
}
