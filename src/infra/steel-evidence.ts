/**
 * Steel evidence for live racer sessions, read with the API key that created
 * the session: Agent Traces (Steel's own record of each click, input and
 * navigation) and the HLS recording. Every failure resolves to null. Nothing
 * is logged, and the key only ever travels in the `steel-api-key` header.
 */
import type { DatasetSteelEvent, SteelTraceEntry } from "../api/dto.js";
import type { ReplayArtifact, ReplayFile } from "../application/contracts.js";

export const STEEL_API_BASE_URL = "https://api.steel.dev/v1";
/** At most this many normalised trace events are kept per session, oldest first. */
export const STEEL_TRACE_LIMIT = 300;
/** At most this many raw Agent Traces events are kept per session, oldest first. */
export const STEEL_RAW_TRACE_LIMIT = 2_000;
export const STEEL_REQUEST_TIMEOUT_MS = 5_000;
/** Planted decoys carry `id="arena-decoy-…"` (see the insert_decoy hazard). */
export const DECOY_ID_PREFIX = "arena-decoy-";
const MAX_TRACE_PAGES = 20;
const LABEL_MAX = 160;

/** A Steel session and the API key that created it. */
export type SteelSessionCredentials = {
  steelSessionId: string;
  apiKey: string;
};

export type SteelRequestOptions = {
  /** Default: the global fetch. */
  fetch?: typeof fetch;
  /** Default: https://api.steel.dev/v1 */
  baseUrl?: string;
  /** Per request. Default 5 s. */
  timeoutMs?: number;
  /** Aborts every request, e.g. an overall deadline. */
  signal?: AbortSignal;
};

export type SteelEvidence = {
  /** Oldest first, at most 300 events; null when the traces could not be read. */
  trace: SteelTraceEntry[] | null;
  /**
   * The Agent Traces events exactly as Steel returned them, oldest first, at
   * most 2,000; null when the traces could not be read.
   */
  raw: unknown[] | null;
  /** The HLS playlist could be read. */
  replayAvailable: boolean;
  /** The recording's first EXT-X-PROGRAM-DATE-TIME, epoch ms. */
  replayStart: number | null;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, max = LABEL_MAX): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function isDecoyId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value.replace(/^#/, "").startsWith(DECOY_ID_PREFIX);
}

const ISO_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:[.,](\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Epoch ms of a Steel timestamp. Fractions beyond milliseconds (HLS program
 * dates carry nanoseconds) are trimmed before parsing; no zone means UTC.
 */
export function parseSteelTimestamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = ISO_TIMESTAMP.exec(value.trim());
  if (!match) return null;
  const [, base, fraction, zone] = match;
  const millis = fraction ? `.${fraction.slice(0, 3).padEnd(3, "0")}` : "";
  let offset = "Z";
  if (zone && zone.toUpperCase() !== "Z") {
    const digits = zone.replace(":", "");
    offset = digits.length === 3 ? `${digits}:00` : `${digits.slice(0, 3)}:${digits.slice(3)}`;
  }
  const parsed = Date.parse(`${base}${millis}${offset}`);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One Agent Traces event → SteelTraceEntry. label = accessibleName ?? text,
 * selector = selector.css, url = page.url ?? navigation.url. A target whose
 * `id` starts with "arena-decoy-" is a planted decoy. Null when malformed.
 */
export function normalizeSteelTraceEvent(event: unknown): SteelTraceEntry | null {
  if (!isRecord(event)) return null;
  const at = parseSteelTimestamp(event.timestamp);
  const type = cleanText(event.type, 40);
  if (at === null || type === null) return null;
  const target = isRecord(event.target) ? event.target : null;
  const selector = target && isRecord(target.selector) ? target.selector : null;
  const attributes = target && isRecord(target.attributes) ? target.attributes : null;
  const page = isRecord(event.page) ? event.page : null;
  const navigation = isRecord(event.navigation) ? event.navigation : null;
  return {
    at,
    type,
    label: cleanText(target?.accessibleName) ?? cleanText(target?.text),
    role: cleanText(target?.role, 80),
    selector: cleanText(selector?.css, 400),
    url: cleanText(page?.url, 2_000) ?? cleanText(navigation?.url, 2_000),
    decoy: isDecoyId(attributes?.id) || isDecoyId(selector?.id),
  };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `boundingBox: { x, y, width, height }` → [x, y, width, height] in CSS pixels. */
function boundingBoxOf(value: unknown): [number, number, number, number] | null {
  if (!isRecord(value)) return null;
  const x = finite(value.x);
  const y = finite(value.y);
  const width = finite(value.width);
  const height = finite(value.height);
  return x === null || y === null || width === null || height === null ? null : [x, y, width, height];
}

/** DOM MouseEvent.button codes, for traces that report the button as a number. */
const POINTER_BUTTONS: readonly string[] = ["left", "middle", "right"];

/** `pointer: { x, y, button, clickCount }` → { x, y, button }. */
function pointerOf(value: unknown): DatasetSteelEvent["pointer"] {
  if (!isRecord(value)) return null;
  const x = finite(value.x);
  const y = finite(value.y);
  if (x === null || y === null) return null;
  const code = finite(value.button);
  const button = code === null ? cleanText(value.button, 20) : POINTER_BUTTONS[code] ?? String(code);
  return { x, y, button };
}

/** `value: { inputType, valueLength, redacted? }`: a typing episode, never its characters. */
function typingOf(value: unknown): DatasetSteelEvent["input"] {
  if (!isRecord(value) || !("inputType" in value || "valueLength" in value || "redacted" in value)) {
    return null;
  }
  return {
    inputType: cleanText(value.inputType, 40),
    length: finite(value.valueLength),
    redacted: value.redacted === true,
  };
}

/**
 * `keyboard: { key, code }` for special keys. A single-character key would be
 * a typed character, so it is never kept.
 */
function keyOf(value: unknown): DatasetSteelEvent["key"] {
  if (!isRecord(value) || typeof value.key !== "string") return null;
  const key = value.key.trim();
  if (key.length <= 1 || key.length > 40) return null;
  return { key, code: cleanText(value.code, 40) };
}

/**
 * One Agent Traces event in full, for the dataset: the target's label, role,
 * tag, selector and box, the pointer, the typing episode (input type and
 * length only) and special keys. `endAt` comes from `endTimestamp`, and a
 * navigation's own URL wins over the page's. Null when malformed.
 */
export function normalizeSteelDatasetEvent(raw: unknown): DatasetSteelEvent | null {
  if (!isRecord(raw)) return null;
  const at = parseSteelTimestamp(raw.timestamp);
  const type = cleanText(raw.type, 40);
  if (at === null || type === null) return null;
  const target = isRecord(raw.target) ? raw.target : null;
  const selector = target && isRecord(target.selector) ? target.selector : null;
  const attributes = target && isRecord(target.attributes) ? target.attributes : null;
  const page = isRecord(raw.page) ? raw.page : null;
  const navigation = isRecord(raw.navigation) ? raw.navigation : null;
  return {
    at,
    endAt: parseSteelTimestamp(raw.endTimestamp),
    type,
    label: cleanText(target?.accessibleName) ?? cleanText(target?.text),
    role: cleanText(target?.role, 80),
    tag: cleanText(target?.tagName, 40)?.toLowerCase() ?? null,
    selector: cleanText(selector?.css, 400),
    url: cleanText(navigation?.url, 2_000) ?? cleanText(page?.url, 2_000),
    bbox: boundingBoxOf(target?.boundingBox),
    pointer: pointerOf(raw.pointer),
    input: typingOf(raw.value),
    key: keyOf(raw.keyboard),
    decoy: isDecoyId(attributes?.id) || isDecoyId(selector?.id),
  };
}

function requestSignal(options: SteelRequestOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? STEEL_REQUEST_TIMEOUT_MS);
  return options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
}

async function steelGet(
  credentials: SteelSessionCredentials,
  path: string,
  options: SteelRequestOptions,
  query: Record<string, string> = {},
): Promise<Response | null> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;
  if (!credentials?.steelSessionId || !credentials.apiKey) return null;
  try {
    const base = (options.baseUrl ?? STEEL_API_BASE_URL).replace(/\/+$/, "");
    const url = new URL(`${base}/sessions/${encodeURIComponent(credentials.steelSessionId)}${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { "steel-api-key": credentials.apiKey },
      signal: requestSignal(options),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return response;
  } catch {
    return null;
  }
}

/** One session's Agent Traces. */
export type SteelAgentTraces = {
  /** Normalised for the evaluation: oldest first, at most 300 events. */
  trace: SteelTraceEntry[];
  /** The events exactly as Steel returned them: oldest first, at most 2,000. */
  raw: unknown[];
};

/**
 * GET /v1/sessions/:id/agent-traces, paginated while `hasMore` with
 * `startTime` just after the last event, until 2,000 raw events. An event
 * without a readable timestamp can be neither ordered nor paged past, so it
 * is left out. Null when the first page cannot be read.
 */
export async function fetchSteelAgentTraces(
  credentials: SteelSessionCredentials,
  options: SteelRequestOptions = {},
): Promise<SteelAgentTraces | null> {
  const events: Array<{ at: number; raw: unknown }> = [];
  let startTime: number | null = null;
  for (let page = 0; page < MAX_TRACE_PAGES && events.length < STEEL_RAW_TRACE_LIMIT; page += 1) {
    const response = await steelGet(
      credentials,
      "/agent-traces",
      options,
      startTime === null ? {} : { startTime: new Date(startTime).toISOString() },
    );
    let body: unknown = null;
    try {
      body = response ? await response.json() : null;
    } catch {
      body = null;
    }
    if (!isRecord(body) || !Array.isArray(body.events)) {
      if (page === 0) return null;
      break;
    }
    let last: number | null = null;
    for (const raw of body.events) {
      const at = isRecord(raw) ? parseSteelTimestamp(raw.timestamp) : null;
      // Anything before the requested start is page overlap.
      if (at === null || (startTime !== null && at < startTime)) continue;
      events.push({ at, raw });
      if (last === null || at > last) last = at;
    }
    if (body.hasMore !== true || last === null) break;
    startTime = last + 1;
  }
  const raw = events
    .sort((left, right) => left.at - right.at)
    .slice(0, STEEL_RAW_TRACE_LIMIT)
    .map((event) => event.raw);
  const trace: SteelTraceEntry[] = [];
  for (const event of raw) {
    if (trace.length >= STEEL_TRACE_LIMIT) break;
    const entry = normalizeSteelTraceEvent(event);
    if (entry) trace.push(entry);
  }
  return { trace, raw };
}

/** GET /v1/sessions/:id/hls: the recording's playlist text, or null. */
export async function fetchSteelHlsPlaylist(
  credentials: SteelSessionCredentials,
  options: SteelRequestOptions = {},
): Promise<string | null> {
  const response = await steelGet(credentials, "/hls", options);
  if (!response) return null;
  try {
    const text = await response.text();
    return text.trimStart().startsWith("#EXTM3U") ? text : null;
  } catch {
    return null;
  }
}

const MAX_REPLAY_FILES = 512;
const MAX_REPLAY_BYTES = 256 * 1024 * 1024;

type ReplayResource = {
  body: Buffer;
  contentType: string;
};

function replayContentType(url: URL, response: Response): string {
  const header = response.headers.get("content-type")?.split(";")[0]?.trim();
  if (header) return header;
  const lower = url.pathname.toLowerCase();
  if (lower.endsWith(".m4s")) return "video/iso.segment";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".ts")) return "video/mp2t";
  return "application/octet-stream";
}

function isAllowedReplayHost(url: URL, options: SteelRequestOptions): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const baseHost = new URL(options.baseUrl ?? STEEL_API_BASE_URL).hostname;
  return url.hostname === baseHost || url.hostname === "steel.dev" || url.hostname.endsWith(".steel.dev");
}

async function fetchReplayResource(
  credentials: SteelSessionCredentials,
  url: URL,
  options: SteelRequestOptions,
): Promise<ReplayResource | null> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function" || !isAllowedReplayHost(url, options)) return null;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { "steel-api-key": credentials.apiKey },
      signal: requestSignal(options),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = Buffer.from(await response.arrayBuffer());
    return { body, contentType: replayContentType(url, response) };
  } catch {
    return null;
  }
}

function replayFileName(index: number, url: URL, contentType: string): string {
  const suffix = url.pathname.toLowerCase().match(/\.(m4s|mp4|ts|aac|m3u8)$/)?.[0] ??
    (contentType.includes("mpeg") ? ".ts" : ".bin");
  return `segment-${String(index).padStart(5, "0")}${suffix}`;
}

/**
 * Copies a Steel HLS recording into application-owned files. Steel's manifest
 * and segment URLs are short-lived/provider-owned, so retaining only the
 * playlist is not enough for a replay that survives session release.
 */
export async function downloadSteelReplay(
  credentials: SteelSessionCredentials,
  options: SteelRequestOptions = {},
): Promise<ReplayArtifact | null> {
  const response = await steelGet(credentials, "/hls", options);
  if (!response) return null;
  let playlist: string;
  try {
    playlist = await response.text();
  } catch {
    return null;
  }
  if (!playlist.trimStart().startsWith("#EXTM3U")) return null;

  const fallbackUrl = new URL(
    `${(options.baseUrl ?? STEEL_API_BASE_URL).replace(/\/+$/, "")}/sessions/${encodeURIComponent(credentials.steelSessionId)}/hls`,
  );
  const playlistUrl = response.url ? new URL(response.url) : fallbackUrl;
  // Steel may return a master playlist. Select its first media rendition,
  // keeping the stored artifact a single playable VOD playlist.
  if (playlist.includes("#EXT-X-STREAM-INF")) {
    const rendition = playlist
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#"));
    if (!rendition) return null;
    const renditionUrl = new URL(rendition, playlistUrl);
    const resource = await fetchReplayResource(credentials, renditionUrl, options);
    if (!resource) return null;
    const text = resource.body.toString("utf8");
    if (!text.trimStart().startsWith("#EXTM3U")) return null;
    playlist = text;
    playlistUrl.href = renditionUrl.href;
  }

  const files: ReplayFile[] = [];
  const byUrl = new Map<string, string>();
  let totalBytes = 0;
  let nextFile = 0;

  const saveUri = async (rawUri: string): Promise<string> => {
    const uri = new URL(rawUri, playlistUrl).toString();
    const existing = byUrl.get(uri);
    if (existing) return existing;
    if (files.length >= MAX_REPLAY_FILES) throw new Error("replay has too many media files");
    const resource = await fetchReplayResource(credentials, new URL(uri), options);
    if (!resource) throw new Error("replay media file could not be fetched");
    totalBytes += resource.body.byteLength;
    if (totalBytes > MAX_REPLAY_BYTES) throw new Error("replay exceeds storage limit");
    const path = replayFileName(nextFile++, new URL(uri), resource.contentType);
    byUrl.set(uri, `replay/${path}`);
    files.push({ path, contentType: resource.contentType, body: resource.body });
    return `replay/${path}`;
  };

  const lines = playlist.split(/\r?\n/);
  const rewritten: string[] = [];
  for (const line of lines) {
    const uriAttributes = [...line.matchAll(/URI="([^"]+)"/g)];
    let nextLine = line;
    for (const match of uriAttributes) {
      const replacement = await saveUri(match[1]!);
      nextLine = nextLine.replace(`URI="${match[1]}"`, `URI="${replacement}"`);
    }
    if (nextLine.trim() && !nextLine.trimStart().startsWith("#")) {
      nextLine = await saveUri(nextLine.trim());
    }
    rewritten.push(nextLine);
  }

  return { playlist: rewritten.join("\n"), files };
}

/** The first EXT-X-PROGRAM-DATE-TIME (nanoseconds trimmed to ms): the replay start. */
export function parseHlsReplayStart(playlist: string): number | null {
  const match = /#EXT-X-PROGRAM-DATE-TIME:\s*(\S+)/i.exec(playlist);
  return match ? parseSteelTimestamp(match[1]) : null;
}

/**
 * Steel had published events for the session. A released session's traces
 * read as empty until Steel publishes them, seconds to minutes later.
 */
export function hasSteelTraceEvents(
  traces: { raw: readonly unknown[] | null } | null | undefined,
): boolean {
  return (traces?.raw?.length ?? 0) > 0;
}

/** Nothing left to read again: the trace has events and the recording was read. */
export function steelEvidenceComplete(evidence: SteelEvidence | null | undefined): boolean {
  return hasSteelTraceEvents(evidence) && evidence?.replayAvailable === true;
}

/** -1 without a readable trace, else its raw event count. */
function traceRank(evidence: SteelEvidence | undefined): number {
  return evidence?.raw ? evidence.raw.length : -1;
}

/** 0 without a recording, 1 without its start, 2 with it. */
function replayRank(evidence: SteelEvidence | undefined): number {
  if (!evidence?.replayAvailable) return 0;
  return evidence.replayStart === null ? 1 : 2;
}

/**
 * The better of two reads of one session, field by field: the trace with
 * more events (an empty read beats a failed one) and a readable recording.
 * Returns `previous` itself when `next` adds nothing.
 */
export function mergeSteelEvidence(
  previous: SteelEvidence | undefined,
  next: SteelEvidence | undefined,
): SteelEvidence | undefined {
  const trace = traceRank(next) > traceRank(previous) ? next : previous;
  const replay = replayRank(next) > replayRank(previous) ? next : previous;
  if (trace === previous && replay === previous) return previous;
  return {
    trace: trace?.trace ?? null,
    raw: trace?.raw ?? null,
    replayAvailable: replay?.replayAvailable ?? false,
    replayStart: replay?.replayStart ?? null,
  };
}

export type SteelEvidenceOptions = SteelRequestOptions & {
  /**
   * Attempts in total; later attempts fetch only what is still missing, and a
   * trace with no events counts as missing. Default 1.
   */
  attempts?: number;
  /** Wait between attempts. Default 1.5 s. */
  retryMs?: number;
  /** Receives the best evidence so far after every attempt. */
  onProgress?: (evidence: SteelEvidence) => void;
};

export const STEEL_EVIDENCE_RETRY_MS = 1_500;

/**
 * Traces and the replay start of one session, fetched in parallel. A session
 * released moments ago may still be publishing its traces and recording, so
 * later attempts refetch whatever is missing, a trace with no events
 * included. The best read so far is kept. Never throws.
 */
export async function collectSteelEvidence(
  credentials: SteelSessionCredentials,
  options: SteelEvidenceOptions = {},
): Promise<SteelEvidence> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 1));
  let traces: SteelAgentTraces | null = null;
  let playlist: string | null = null;
  let evidence: SteelEvidence = { trace: null, raw: null, replayAvailable: false, replayStart: null };
  try {
    for (let attempt = 1; ; attempt += 1) {
      const [nextTraces, nextPlaylist]: [SteelAgentTraces | null, string | null] = await Promise.all([
        hasSteelTraceEvents(traces) ? traces : fetchSteelAgentTraces(credentials, options),
        playlist ?? fetchSteelHlsPlaylist(credentials, options),
      ]);
      // A failed read never replaces an empty one.
      traces = nextTraces ?? traces;
      playlist = nextPlaylist;
      evidence = {
        trace: traces?.trace ?? null,
        raw: traces?.raw ?? null,
        replayAvailable: playlist !== null,
        replayStart: playlist === null ? null : parseHlsReplayStart(playlist),
      };
      options.onProgress?.(evidence);
      if ((hasSteelTraceEvents(traces) && playlist !== null) || attempt >= attempts) return evidence;
      if (!(await pause(options.retryMs ?? STEEL_EVIDENCE_RETRY_MS, options.signal))) return evidence;
    }
  } catch {
    return evidence;
  }
}

/** Resolves true after `ms`, or false as soon as the signal aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const finish = (completed: boolean): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), Math.max(10, ms));
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
