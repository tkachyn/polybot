/**
 * Typed fetch wrappers for every endpoint in docs/frontend-contract.md.
 *
 * - Same origin (base URL ""): Vite proxies /api in dev; Fastify serves the
 *   build in production.
 * - Every response's `serverTime` updates the server clock (state/clock.ts).
 * - Failures throw {@link ApiFailure}. Aborts rethrow the original AbortError
 *   (check with {@link isAbortError}) so callers can ignore them.
 * - Every request gives up after DEFAULT_REQUEST_TIMEOUT_MS (per call:
 *   `{ timeoutMs }`) with an ApiFailure whose code is "timeout". A write that
 *   times out may still have been applied by the server, so it is also
 *   `unconfirmed`: never report it as failed (see ApiFailure.unconfirmed).
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
 * How long a request may take, response body included, before it is aborted
 * and fails with code "timeout". Without it a stalled connection (sleep,
 * roaming, a hung server) leaves the request, and any spinner on it, pending
 * forever while it holds one of the browser's few connections to the host.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** An order whose outcome is unknown (see ApiFailure.unconfirmed). */
export const ORDER_UNCONFIRMED_MESSAGE = "We couldn’t confirm your order; check Portfolio before placing it again.";
/** A deposit or withdrawal whose outcome is unknown. */
export const TRANSFER_UNCONFIRMED_MESSAGE = "We couldn’t confirm the transfer; check your balance before trying again.";
const WRITE_UNCONFIRMED_MESSAGE = "We couldn’t confirm that this went through; check before trying again.";
const TIMEOUT_MESSAGE = "The server took too long to respond.";

/**
 * Contract error codes plus three client-side codes:
 * - "network": the request never got a response (offline, server down, CORS).
 * - "timeout": no complete response in time (a stalled connection, a hung
 *   server, a gateway timeout). The request was aborted.
 * - "server": a response without a contract error body (5xx, proxy errors).
 */
export type ApiFailureCode = ApiErrorCode | "network" | "timeout" | "server";

export type ApiFailureOptions = {
  cause?: unknown;
  /** See {@link ApiFailure.unconfirmed}. Default false. */
  unconfirmed?: boolean;
};

export class ApiFailure extends Error {
  readonly code: ApiFailureCode;
  /** HTTP status; 0 for network failures and client-side timeouts. */
  readonly status: number;
  /**
   * The request was a write (an order, a transfer) that the server may or
   * may not have applied: it timed out, or the answer was lost on the way.
   * Never show it as failed. Say it could not be confirmed and point to where
   * the truth shows; `describeError` returns such a sentence, e.g.
   * ORDER_UNCONFIRMED_MESSAGE. The session re-reads balance and positions by
   * itself (`onUnconfirmedRequest`). Resending an order with the same
   * `clientOrderId` is safe: the server returns the original receipt if the
   * first attempt went through, and fills it now if it did not.
   */
  readonly unconfirmed: boolean;

  constructor(message: string, code: ApiFailureCode, status: number, options: ApiFailureOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiFailure";
    this.code = code;
    this.status = status;
    this.unconfirmed = options.unconfirmed ?? false;
  }

  get isNetwork(): boolean {
    return this.code === "network";
  }

  /** No complete response in time; the request was aborted. */
  get isTimeout(): boolean {
    return this.code === "timeout";
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

/** A write whose outcome is unknown (see ApiFailure.unconfirmed). */
export function isUnconfirmed(error: unknown): error is ApiFailure {
  return error instanceof ApiFailure && error.unconfirmed;
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
  // A gateway gave up waiting for the server, which may still finish the request.
  if (status === 504) return new ApiFailure(message || TIMEOUT_MESSAGE, "timeout", status);
  if (status >= 400 && status < 500) return new ApiFailure(message || "The request was rejected.", "invalid", status);
  return new ApiFailure(message || `The server could not complete the request (HTTP ${status}).`, "server", status);
}

// ---------------------------------------------------------------------------
// Unconfirmed writes
// ---------------------------------------------------------------------------

type UnconfirmedListener = (failure: ApiFailure) => void;

const unconfirmedListeners = new Set<UnconfirmedListener>();

/**
 * Calls `listener` with every unconfirmed write (see ApiFailure.unconfirmed),
 * so state the write may have changed can be re-read. Returns unsubscribe.
 */
export function onUnconfirmedRequest(listener: UnconfirmedListener): () => void {
  unconfirmedListeners.add(listener);
  return () => {
    unconfirmedListeners.delete(listener);
  };
}

function announce(failure: ApiFailure): ApiFailure {
  if (failure.unconfirmed) {
    for (const listener of [...unconfirmedListeners]) {
      try {
        listener(failure);
      } catch (error) {
        console.error(error);
      }
    }
  }
  return failure;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type Query = Record<string, string | number | boolean | null | undefined>;

export type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
  /**
   * Abort and fail with code "timeout" when the whole response (body
   * included) has not arrived after this many ms. Default
   * DEFAULT_REQUEST_TIMEOUT_MS; 0 disables.
   */
  timeoutMs?: number;
  /** Repeating this write is harmless (POST /api/users), so a lost answer is not "unconfirmed". */
  idempotent?: boolean;
  /** The message of an unconfirmed failure of this write: what the user should check. */
  unconfirmedMessage?: string;
};

/** Per-call options for the typed wrappers. A bare AbortSignal is short for `{ signal }`. */
export type CallOptions = {
  signal?: AbortSignal;
  /** Overrides DEFAULT_REQUEST_TIMEOUT_MS for this call; 0 disables. */
  timeoutMs?: number;
};

type Call = AbortSignal | CallOptions;

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    isRecord(value) &&
    typeof (value as { aborted?: unknown }).aborted === "boolean" &&
    typeof (value as { addEventListener?: unknown }).addEventListener === "function"
  );
}

function callOptions(call: Call | undefined): CallOptions {
  if (!call) return {};
  return isAbortSignal(call) ? { signal: call } : call;
}

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
  const method = options.method ?? (hasBody ? "POST" : "GET");
  // A write the server may apply even though its answer never reaches us.
  const mayApply = method !== "GET" && !options.idempotent;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const outer = options.signal;

  /** The outcome of this write is unknown: announce it so state is re-read. */
  const unconfirmed = (code: ApiFailureCode, status: number, cause?: unknown) =>
    announce(new ApiFailure(options.unconfirmedMessage ?? WRITE_UNCONFIRMED_MESSAGE, code, status, { cause, unconfirmed: true }));
  const timedOutFailure = (status: number, cause: unknown) =>
    mayApply ? unconfirmed("timeout", status, cause) : new ApiFailure(TIMEOUT_MESSAGE, "timeout", status, { cause });

  // One controller aborts the fetch for either reason: the caller's signal or the timeout.
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(outer?.reason);
  if (outer?.aborted) controller.abort(outer.reason);
  else outer?.addEventListener("abort", onOuterAbort, { once: true });
  let timedOut = false;
  const timer =
    timeoutMs > 0 && Number.isFinite(timeoutMs)
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;

  try {
    const sentAt = Date.now();
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: hasBody ? { accept: "application/json", "content-type": "application/json" } : { accept: "application/json" },
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch (error) {
      if (outer?.aborted) throw error;
      if (timedOut) throw timedOutFailure(0, error);
      if (isAbortError(error)) throw error;
      throw new ApiFailure("Can’t reach the PolyBot server.", "network", 0, { cause: error });
    }
    const receivedAt = Date.now();

    let text = "";
    try {
      text = await response.text();
    } catch (error) {
      if (outer?.aborted) throw error;
      if (timedOut) throw timedOutFailure(response.status, error);
      if (isAbortError(error)) throw error;
      // The server answered, so a write may well have gone through.
      if (mayApply) throw unconfirmed("network", response.status, error);
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

    if (!response.ok) {
      const failure = failureFromResponse(response.status, data, response.statusText);
      if (mayApply && failure.code === "timeout") throw unconfirmed("timeout", response.status);
      throw failure;
    }
    if (data === undefined) {
      // A 2xx write was applied; only its receipt is unreadable.
      if (mayApply) throw unconfirmed("server", response.status);
      throw new ApiFailure("The server sent a response the app could not read.", "server", response.status);
    }
    if (isRecord(data) && typeof data.serverTime === "number") noteServerTime(data.serverTime, sentAt, receivedAt);
    return data as T;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

// ---------------------------------------------------------------------------
// Endpoints
//
// Every wrapper takes an optional trailing AbortSignal, or `{ signal?,
// timeoutMs? }` to override the request timeout.
// ---------------------------------------------------------------------------

/** GET /api/meta */
export function getMeta(call?: Call): Promise<ServerMeta> {
  return request<ServerMeta>("/api/meta", callOptions(call));
}

/** GET /api/fights?status= */
export function listFights(params: { status?: FightStatus } = {}, call?: Call): Promise<FightListResponse> {
  return request<FightListResponse>("/api/fights", { query: { status: params.status }, ...callOptions(call) });
}

/** GET /api/fights/:raceId */
export function getFight(raceId: string, call?: Call): Promise<FightDetailResponse> {
  return request<FightDetailResponse>(`/api/fights/${seg(raceId)}`, callOptions(call));
}

/** GET /api/fights/:raceId/me?userId= */
export function getMyFight(raceId: string, userId: string, call?: Call): Promise<MyFightResponse> {
  return request<MyFightResponse>(`/api/fights/${seg(raceId)}/me`, { query: { userId }, ...callOptions(call) });
}

/** GET /api/fights/:raceId/traders */
export function getFightTraders(raceId: string, call?: Call): Promise<TraderLeaderboardResponse> {
  return request<TraderLeaderboardResponse>(`/api/fights/${seg(raceId)}/traders`, callOptions(call));
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

/**
 * POST /api/fights/:raceId/orders. A failure with `unconfirmed` set (the
 * order timed out) reads ORDER_UNCONFIRMED_MESSAGE: the order may have filled.
 */
export function placeOrder(raceId: string, order: OrderRequest, call?: Call): Promise<OrderResponse> {
  return request<OrderResponse>(`/api/fights/${seg(raceId)}/orders`, {
    method: "POST",
    body: order,
    unconfirmedMessage: ORDER_UNCONFIRMED_MESSAGE,
    ...callOptions(call),
  });
}

/** POST /api/users — 201 created or 200 existing; both resolve. Safe to repeat. */
export function ensureUser(body: EnsureUserRequest, call?: Call): Promise<AccountResponse> {
  return request<AccountResponse>("/api/users", { method: "POST", body, idempotent: true, ...callOptions(call) });
}

/** GET /api/users/:userId */
export function getUser(userId: string, call?: Call): Promise<AccountResponse> {
  return request<AccountResponse>(`/api/users/${seg(userId)}`, callOptions(call));
}

/** GET /api/users/:userId/portfolio */
export function getPortfolio(userId: string, call?: Call): Promise<PortfolioResponse> {
  return request<PortfolioResponse>(`/api/users/${seg(userId)}/portfolio`, callOptions(call));
}

/** POST /api/users/:userId/deposit */
export function deposit(userId: string, body: WalletTransferRequest, call?: Call): Promise<WalletTransferResponse> {
  return request<WalletTransferResponse>(`/api/users/${seg(userId)}/deposit`, {
    method: "POST",
    body,
    unconfirmedMessage: TRANSFER_UNCONFIRMED_MESSAGE,
    ...callOptions(call),
  });
}

/** POST /api/users/:userId/withdraw */
export function withdraw(userId: string, body: WalletTransferRequest, call?: Call): Promise<WalletTransferResponse> {
  return request<WalletTransferResponse>(`/api/users/${seg(userId)}/withdraw`, {
    method: "POST",
    body,
    unconfirmedMessage: TRANSFER_UNCONFIRMED_MESSAGE,
    ...callOptions(call),
  });
}

/** GET /api/leaderboard (30-day window) */
export function getLeaderboard(call?: Call): Promise<LeaderboardResponse> {
  return request<LeaderboardResponse>("/api/leaderboard", callOptions(call));
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
export function getFightEvaluation(raceId: string, call?: Call): Promise<FightEvaluationResponse> {
  return request<FightEvaluationResponse>(`/api/fights/${seg(raceId)}/evaluation`, callOptions(call));
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
export function getRobustnessMatrix(params: EvaluationQuery = {}, call?: Call): Promise<RobustnessMatrixResponse> {
  return request<RobustnessMatrixResponse>("/api/evaluations/matrix", {
    query: { days: params.days, mode: params.mode },
    ...callOptions(call),
  });
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
    // What to check, never "failed": the write may have gone through.
    if (error.unconfirmed) return error.message;
    switch (error.code) {
      case "network":
        return "Can’t reach the server. Check your connection; the app keeps retrying.";
      case "timeout":
        return "The server is taking too long to respond. Check your connection and try again.";
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
