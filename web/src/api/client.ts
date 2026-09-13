/**
 * Typed fetch wrappers for every endpoint in docs/frontend-contract.md.
 *
 * - Same origin (base URL ""): Vite proxies /api in dev; Fastify serves the
 *   build in production.
 * - Every response's `serverTime` updates the server clock (state/clock.ts).
 * - Failures throw {@link ApiFailure}. Aborts rethrow the original AbortError
 *   (check with {@link isAbortError}) so callers can ignore them.
 */
import type {
  AccountResponse,
  ApiErrorCode,
  DatasetFile,
  EnsureUserRequest,
  FightDetailResponse,
  FightEvaluationResponse,
  FightListResponse,
  FightStatus,
  LeaderboardResponse,
  MyFightResponse,
  OrderRequest,
  OrderResponse,
  PortfolioResponse,
  RobustnessMatrixResponse,
  ServerMeta,
  ServerMode,
  TraderLeaderboardResponse,
  WalletTransferRequest,
  WalletTransferResponse,
} from "@contract";
import { noteServerTime } from "../state/clock";

/**
 * Where the API lives. Empty means same origin, which is how the dev server
 * (which proxies /api) and a single-host deploy both work. A split deploy —
 * SPA on a CDN, API on its own host — sets VITE_API_BASE at build time, and
 * every REST call, SSE stream, frame and replay URL below follows it.
 *
 * No trailing slash: paths are concatenated directly.
 */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");

/**
 * Contract error codes plus two client-side codes:
 * - "network": the request never got a response (offline, server down, CORS).
 * - "server": a response without a contract error body (5xx, proxy errors).
 */
export type ApiFailureCode = ApiErrorCode | "network" | "server";

export class ApiFailure extends Error {
  readonly code: ApiFailureCode;
  /** HTTP status; 0 for network failures. */
  readonly status: number;

  constructor(message: string, code: ApiFailureCode, status: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApiFailure";
    this.code = code;
    this.status = status;
  }

  get isNetwork(): boolean {
    return this.code === "network";
  }
}

const API_ERROR_CODES: Readonly<Record<ApiErrorCode, true>> = {
  invalid: true,
  not_found: true,
  conflict: true,
  market_closed: true,
  price_moved: true,
  insufficient_balance: true,
  insufficient_position: true,
};

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(API_ERROR_CODES, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isApiFailure(error: unknown, code?: ApiFailureCode): error is ApiFailure {
  return error instanceof ApiFailure && (code === undefined || error.code === code);
}

/** Wraps any thrown value as an ApiFailure (non-API errors become "server"). */
export function toApiFailure(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;
  const message = error instanceof Error && error.message ? error.message : "Something went wrong.";
  return new ApiFailure(message, "server", 0, { cause: error });
}

export function isAbortError(error: unknown): boolean {
  return isRecord(error) && (error as { name?: unknown }).name === "AbortError";
}

/** Maps a non-2xx response to an ApiFailure, preferring the ApiError body. */
export function failureFromResponse(status: number, body: unknown, statusText = ""): ApiFailure {
  if (isRecord(body) && isApiErrorCode(body.code)) {
    const message = typeof body.error === "string" && body.error ? body.error : statusText || `HTTP ${status}`;
    return new ApiFailure(message, body.code, status);
  }
  const message = isRecord(body) && typeof body.error === "string" && body.error ? body.error : "";
  if (status === 404) return new ApiFailure(message || "Not found.", "not_found", status);
  if (status === 409) return new ApiFailure(message || "Conflict.", "conflict", status);
  if (status >= 400 && status < 500) return new ApiFailure(message || "The request was rejected.", "invalid", status);
  return new ApiFailure(message || `The server could not complete the request (HTTP ${status}).`, "server", status);
}

type Query = Record<string, string | number | boolean | null | undefined>;

export type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
};

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

const seg = encodeURIComponent;

/** Low-level JSON request. Prefer the typed wrappers below. */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = `${API_BASE}${withQuery(path, options.query)}`;
  const hasBody = options.body !== undefined;
  const sentAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? (hasBody ? "POST" : "GET"),
      headers: hasBody ? { accept: "application/json", "content-type": "application/json" } : { accept: "application/json" },
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiFailure("Can’t reach the PolyBot server.", "network", 0, { cause: error });
  }
  const receivedAt = Date.now();

  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiFailure("The connection dropped while reading the response.", "network", response.status, { cause: error });
  }
  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!response.ok) throw failureFromResponse(response.status, data, response.statusText);
  if (data === undefined) {
    throw new ApiFailure("The server sent a response the app could not read.", "server", response.status);
  }
  if (isRecord(data) && typeof data.serverTime === "number") noteServerTime(data.serverTime, sentAt, receivedAt);
  return data as T;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** GET /api/meta */
export function getMeta(signal?: AbortSignal): Promise<ServerMeta> {
  return request<ServerMeta>("/api/meta", { signal });
}

/** GET /api/fights?status= */
export function listFights(params: { status?: FightStatus } = {}, signal?: AbortSignal): Promise<FightListResponse> {
  return request<FightListResponse>("/api/fights", { query: { status: params.status }, signal });
}

/** GET /api/fights/:raceId */
export function getFight(raceId: string, signal?: AbortSignal): Promise<FightDetailResponse> {
  return request<FightDetailResponse>(`/api/fights/${seg(raceId)}`, { signal });
}

/** GET /api/fights/:raceId/me?userId= */
export function getMyFight(raceId: string, userId: string, signal?: AbortSignal): Promise<MyFightResponse> {
  return request<MyFightResponse>(`/api/fights/${seg(raceId)}/me`, { query: { userId }, signal });
}

/** GET /api/fights/:raceId/traders */
export function getFightTraders(raceId: string, signal?: AbortSignal): Promise<TraderLeaderboardResponse> {
  return request<TraderLeaderboardResponse>(`/api/fights/${seg(raceId)}/traders`, { signal });
}

export function traderStreamUrl(raceId: string): string {
  return `${API_BASE}/api/fights/${seg(raceId)}/traders/stream`;
}

/**
 * GET /api/fights/:raceId/agents/:racerId/frame?seq= — use as an <img src>.
 * `seq` comes from `agent.frame.seq`; a new seq means a new capture.
 */
export function fightFrameUrl(raceId: string, racerId: string, seq: number): string {
  return `${API_BASE}/api/fights/${seg(raceId)}/agents/${seg(racerId)}/frame?seq=${encodeURIComponent(String(seq))}`;
}

/** POST /api/fights/:raceId/orders */
export function placeOrder(raceId: string, order: OrderRequest, signal?: AbortSignal): Promise<OrderResponse> {
  return request<OrderResponse>(`/api/fights/${seg(raceId)}/orders`, { method: "POST", body: order, signal });
}

/** POST /api/users — 201 created or 200 existing; both resolve. */
export function ensureUser(body: EnsureUserRequest, signal?: AbortSignal): Promise<AccountResponse> {
  return request<AccountResponse>("/api/users", { method: "POST", body, signal });
}

/** GET /api/users/:userId */
export function getUser(userId: string, signal?: AbortSignal): Promise<AccountResponse> {
  return request<AccountResponse>(`/api/users/${seg(userId)}`, { signal });
}

/** GET /api/users/:userId/portfolio */
export function getPortfolio(userId: string, signal?: AbortSignal): Promise<PortfolioResponse> {
  return request<PortfolioResponse>(`/api/users/${seg(userId)}/portfolio`, { signal });
}

/** POST /api/users/:userId/deposit */
export function deposit(userId: string, body: WalletTransferRequest, signal?: AbortSignal): Promise<WalletTransferResponse> {
  return request<WalletTransferResponse>(`/api/users/${seg(userId)}/deposit`, { method: "POST", body, signal });
}

/** POST /api/users/:userId/withdraw */
export function withdraw(userId: string, body: WalletTransferRequest, signal?: AbortSignal): Promise<WalletTransferResponse> {
  return request<WalletTransferResponse>(`/api/users/${seg(userId)}/withdraw`, { method: "POST", body, signal });
}

/** GET /api/leaderboard (30-day window) */
export function getLeaderboard(signal?: AbortSignal): Promise<LeaderboardResponse> {
  return request<LeaderboardResponse>("/api/leaderboard", { signal });
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Which evaluations to aggregate. The server defaults to its own mode. */
export type EvaluationMode = ServerMode | "all";

export type EvaluationQuery = {
  /** Window in days (the server default is 30). */
  days?: number;
  /** Omit for the server's own mode. */
  mode?: EvaluationMode;
};

/** GET /api/fights/:raceId/evaluation (404 for an unknown fight) */
export function getFightEvaluation(raceId: string, signal?: AbortSignal): Promise<FightEvaluationResponse> {
  return request<FightEvaluationResponse>(`/api/fights/${seg(raceId)}/evaluation`, { signal });
}

/** GET /api/fights/:raceId/agents/:racerId/evidence/:key — a keyframe, use as an <img src>. */
export function evidenceFrameUrl(raceId: string, racerId: string, key: string): string {
  return `${API_BASE}/api/fights/${seg(raceId)}/agents/${seg(racerId)}/evidence/${seg(key)}`;
}

/**
 * GET /api/fights/:raceId/agents/:racerId/replay.m3u8 — the Steel session's
 * HLS playlist. Live Steel sessions only; 404 when there is no replay.
 */
export function replayUrl(raceId: string, racerId: string): string {
  return `${API_BASE}/api/fights/${seg(raceId)}/agents/${seg(racerId)}/replay.m3u8`;
}

/** GET /api/evaluations/matrix?days=&mode= */
export function getRobustnessMatrix(params: EvaluationQuery = {}, signal?: AbortSignal): Promise<RobustnessMatrixResponse> {
  return request<RobustnessMatrixResponse>("/api/evaluations/matrix", { query: { days: params.days, mode: params.mode }, signal });
}

// ---------------------------------------------------------------------------
// Training dataset (docs/training-data.md): download links, not fetches
// ---------------------------------------------------------------------------

/**
 * Which fights the dataset covers. `days` is 1–365 (the server default is
 * 30); omit `mode` for the server's own mode.
 */
export type DatasetQuery = EvaluationQuery;

function datasetPath(name: string, params: DatasetQuery): string {
  return `${API_BASE}${withQuery(`/api/datasets/${name}`, { days: params.days, mode: params.mode })}`;
}

/**
 * GET /api/datasets/export.zip?days=&mode= — the whole dataset as a zip
 * attachment: manifest.json, the four JSON Lines files, screenshots and raw
 * Steel traces.
 */
export function datasetExportUrl(params: DatasetQuery = {}): string {
  return datasetPath("export.zip", params);
}

/**
 * GET /api/datasets/manifest.json or /api/datasets/{file}.jsonl?days=&mode= —
 * one file of the dataset, for the same window and mode as the zip.
 */
export function datasetFileUrl(file: DatasetFile | "manifest", params: DatasetQuery = {}): string {
  return datasetPath(file === "manifest" ? "manifest.json" : `${file}.jsonl`, params);
}

// ---------------------------------------------------------------------------
// SSE stream URLs (consume with useEventStream from ./stream)
// ---------------------------------------------------------------------------

/** GET /api/fights/stream — events: FightListStreamEvents */
export function fightsStreamUrl(): string {
  return `${API_BASE}/api/fights/stream`;
}

/** GET /api/fights/:raceId/stream — events: FightStreamEvents */
export function fightStreamUrl(raceId: string): string {
  return `${API_BASE}/api/fights/${seg(raceId)}/stream`;
}

/** GET /api/users/:userId/stream — events: UserStreamEvents */
export function userStreamUrl(userId: string): string {
  return `${API_BASE}/api/users/${seg(userId)}/stream`;
}

/** All wrappers as one object, convenient for injection and mocking. */
export const api = {
  getMeta,
  listFights,
  getFight,
  getMyFight,
  fightFrameUrl,
  placeOrder,
  ensureUser,
  getUser,
  getPortfolio,
  deposit,
  withdraw,
  getLeaderboard,
  getFightEvaluation,
  evidenceFrameUrl,
  replayUrl,
  getRobustnessMatrix,
  datasetExportUrl,
  datasetFileUrl,
  fightsStreamUrl,
  fightStreamUrl,
  userStreamUrl,
} as const;

// ---------------------------------------------------------------------------
// User-facing messages
// ---------------------------------------------------------------------------

/** A short, user-facing sentence for any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof ApiFailure) {
    switch (error.code) {
      case "network":
        return "Can’t reach the server. Check your connection; the app keeps retrying.";
      case "price_moved":
        return "The price moved before your order filled. Check the new price and try again.";
      case "market_closed":
        return "This market is closed to new orders.";
      case "insufficient_balance":
        return "Not enough balance for this order.";
      case "insufficient_position":
        return "You don’t hold enough shares to sell that many.";
      case "server":
        return "Something went wrong on the server. Try again in a moment.";
      case "not_found":
      case "invalid":
      case "conflict":
        return error.message;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}
