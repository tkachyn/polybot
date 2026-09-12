/**
 * Steel evidence for live racer sessions, read with the API key that created
 * the session: Agent Traces (Steel's own record of each click, input and
 * navigation) and the HLS recording. Every failure resolves to null. Nothing
 * is logged, and the key only ever travels in the `steel-api-key` header.
 */
import type { SteelTraceEntry } from "../api/dto.js";

export const STEEL_API_BASE_URL = "https://api.steel.dev/v1";
/** At most this many trace events are kept per session, oldest first. */
export const STEEL_TRACE_LIMIT = 300;
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

/**
 * GET /v1/sessions/:id/agent-traces, paginated while `hasMore` with
 * `startTime` just after the last event. Oldest first, capped at 300. Null
 * when the first page cannot be read.
 */
export async function fetchSteelAgentTraces(
  credentials: SteelSessionCredentials,
  options: SteelRequestOptions = {},
): Promise<SteelTraceEntry[] | null> {
  const entries: SteelTraceEntry[] = [];
  let startTime: number | null = null;
  for (let page = 0; page < MAX_TRACE_PAGES && entries.length < STEEL_TRACE_LIMIT; page += 1) {
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
      const entry = normalizeSteelTraceEvent(raw);
      // Anything before the requested start is page overlap.
      if (!entry || (startTime !== null && entry.at < startTime)) continue;
      entries.push(entry);
      if (last === null || entry.at > last) last = entry.at;
    }
    if (body.hasMore !== true || last === null) break;
    startTime = last + 1;
  }
  return entries
    .sort((left, right) => left.at - right.at)
    .slice(0, STEEL_TRACE_LIMIT);
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

/** The first EXT-X-PROGRAM-DATE-TIME (nanoseconds trimmed to ms): the replay start. */
export function parseHlsReplayStart(playlist: string): number | null {
  const match = /#EXT-X-PROGRAM-DATE-TIME:\s*(\S+)/i.exec(playlist);
  return match ? parseSteelTimestamp(match[1]) : null;
}

export type SteelEvidenceOptions = SteelRequestOptions & {
  /** Attempts in total; later attempts fetch only what is still missing. Default 1. */
  attempts?: number;
  /** Wait between attempts. Default 1.5 s. */
  retryMs?: number;
  /** Receives the best evidence so far after every attempt. */
  onProgress?: (evidence: SteelEvidence) => void;
};

export const STEEL_EVIDENCE_RETRY_MS = 1_500;

/**
 * Traces and the replay start of one session, fetched in parallel. A session
 * released moments ago may still be publishing its recording, so later
 * attempts refetch whatever is missing. Never throws.
 */
export async function collectSteelEvidence(
  credentials: SteelSessionCredentials,
  options: SteelEvidenceOptions = {},
): Promise<SteelEvidence> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 1));
  let trace: SteelTraceEntry[] | null = null;
  let playlist: string | null = null;
  let evidence: SteelEvidence = { trace: null, replayAvailable: false, replayStart: null };
  try {
    for (let attempt = 1; ; attempt += 1) {
      [trace, playlist] = await Promise.all([
        trace ?? fetchSteelAgentTraces(credentials, options),
        playlist ?? fetchSteelHlsPlaylist(credentials, options),
      ]);
      evidence = {
        trace,
        replayAvailable: playlist !== null,
        replayStart: playlist === null ? null : parseHlsReplayStart(playlist),
      };
      options.onProgress?.(evidence);
      if ((trace !== null && playlist !== null) || attempt >= attempts) return evidence;
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
