import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import { InMemoryDatasetStore, JsonlDatasetStore, type DatasetStore } from "../dataset/store.js";
import { DomainError, isDomainError } from "../domain/errors.js";
import {
  InMemoryEvaluationStore,
  JsonlEvaluationStore,
  type EvaluationStore,
} from "../evaluation/index.js";
import { registerDatasetRoutes } from "./dataset-routes.js";
import type { ApiErrorCode, ServerMode } from "./dto.js";
import type { ApiCreateRaceInput, CoordinatorFactory } from "./race-registry.js";
import { RaceRegistry } from "./race-registry.js";
import {
  DefaultSteelBrowserSessionService,
  type SteelBrowserSessionService,
} from "../infra/steel-browser-session-service.js";
import {
  DEFAULT_STREAM_THROTTLES,
  registerSpectatorRoutes,
  type StreamThrottles,
} from "./spectator-routes.js";
import { SseHub, SSE_PING_MS } from "./sse.js";

declare module "fastify" {
  interface FastifyInstance {
    registry: RaceRegistry;
  }
}

export type ApiServerOptions = {
  coordinatorFactory: CoordinatorFactory;
  enableTicker?: boolean;
  tickIntervalMs?: number;
  mode?: ServerMode;
  /** Locks wallet transfers and enables the judge onboarding flow. */
  demoMode?: boolean;
  /** Reveal sabotage text before fights open. Default true. */
  showSabotageUpfront?: boolean;
  /** Credits granted to new users. Default 1000. */
  startingBalance?: number;
  /** First fight number. Default 1. */
  fightNumberStart?: number;
  /** Built SPA directory. Served with an SPA fallback when it exists. */
  webDist?: string;
  /**
   * Browser origins allowed to call this API and open its streams. Needed when
   * the SPA is served from somewhere else (a Vercel deploy, a Vite dev server);
   * same-origin deploys need none. Exact origins only, no wildcard: the API
   * carries a user's balance, so it must not answer to any page that asks.
   */
  corsOrigins?: readonly string[];
  /**
   * Awaited once on ready, before the ticker starts (e.g. to seed history).
   * A returned function is called when the server closes.
   */
  onRegistryReady?: (registry: RaceRegistry) => Promise<(() => void) | void>;
  /** Clock for API responses. Default Date.now. */
  now?: () => number;
  streamThrottles?: Partial<StreamThrottles>;
  ssePingMs?: number;
  /** Server-side browser lifecycle for an authenticated operator/frontend. */
  browserSessionService?: SteelBrowserSessionService;
  /** Where final evaluations are kept. Default: `defaultEvaluationStore(mode)`. */
  evaluationStore?: EvaluationStore;
  /** Where fight dataset records and their files are kept. Default: `defaultDatasetStore(mode)`. */
  datasetStore?: DatasetStore;
};

export const DEFAULT_EVALUATION_FILE = "data/evaluations.jsonl";
export const DEFAULT_DATASET_DIR = "data/dataset";

/**
 * Live mode appends final evaluations to EVALUATION_FILE (default
 * data/evaluations.jsonl). Simulated mode keeps them in memory unless
 * EVALUATION_FILE is set. The file is only touched when first used.
 */
export function defaultEvaluationStore(
  mode: ServerMode,
  env: NodeJS.ProcessEnv = process.env,
): EvaluationStore {
  const file = env.EVALUATION_FILE?.trim();
  if (mode === "simulated" && !file) return new InMemoryEvaluationStore();
  return new JsonlEvaluationStore(resolve(file || DEFAULT_EVALUATION_FILE));
}

/**
 * Live mode keeps fight dataset records, step screenshots and raw Steel
 * traces under DATASET_DIR (default data/dataset). Simulated mode keeps them
 * in memory unless DATASET_DIR is set. The directory is only touched when
 * first used.
 */
export function defaultDatasetStore(
  mode: ServerMode,
  env: NodeJS.ProcessEnv = process.env,
): DatasetStore {
  const dir = env.DATASET_DIR?.trim();
  if (mode === "simulated" && !dir) return new InMemoryDatasetStore();
  return new JsonlDatasetStore(resolve(dir || DEFAULT_DATASET_DIR));
}

const ERROR_STATUS: Record<ApiErrorCode, number> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  market_closed: 400,
  price_moved: 400,
  insufficient_balance: 400,
  insufficient_position: 400,
};

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

function pathOf(request: FastifyRequest): string {
  return request.url.split("?")[0] ?? "/";
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

function isRacesPath(path: string): boolean {
  return path === "/races" || path.startsWith("/races/");
}

function isDirectory(path: string | undefined): path is string {
  try {
    return path !== undefined && existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function buildApi(options: ApiServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const mode = options.mode ?? "live";
  const registry = new RaceRegistry(options.coordinatorFactory, {
    fightNumberStart: options.fightNumberStart,
    startingBalance: options.startingBalance,
    evaluationStore: options.evaluationStore ?? defaultEvaluationStore(mode),
    datasetStore: options.datasetStore ?? defaultDatasetStore(mode),
  });
  const hub = new SseHub(options.ssePingMs ?? SSE_PING_MS);
  const now = options.now ?? (() => Date.now());
  const webDist = isDirectory(options.webDist) ? options.webDist : undefined;
  const browserSessions = options.browserSessionService ??
    new DefaultSteelBrowserSessionService();
  let ticker: ReturnType<typeof setInterval> | undefined;
  let stopRegistryHook: (() => void) | undefined;

  // Registered before any route so preflights and error responses carry the
  // headers too. SSE is a simple GET, but EventSource still enforces CORS.
  const corsOrigins = options.corsOrigins?.filter((origin) => origin.length > 0) ?? [];
  if (corsOrigins.length > 0) {
    void app.register(fastifyCors, {
      origin: corsOrigins as string[],
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      credentials: true,
      maxAge: 86_400,
    });
  }

  app.decorate("registry", registry);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isDomainError(error)) {
      return reply.status(ERROR_STATUS[error.code] ?? 400).send({ error: message, code: error.code });
    }
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : undefined;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      // Body parsing, content-type and schema validation failures.
      const code: ApiErrorCode = statusCode === 404 ? "not_found" : "invalid";
      return reply.status(statusCode).send({ error: message, code });
    }
    // Legacy message mapping for plain errors (the /races operator routes).
    if (/not found/i.test(message)) {
      return reply.status(404).send({ error: message, code: "not_found" });
    }
    if (/already exists/i.test(message)) {
      return reply.status(409).send({ error: message, code: "conflict" });
    }
    if (isApiPath(pathOf(request))) {
      return reply.status(500).send({ error: "internal server error", code: "invalid" });
    }
    return reply.status(400).send({ error: message, code: "invalid" });
  });

  app.get("/api/health", async () => ({
    ok: true,
    mode,
    demoMode: options.demoMode ?? false,
    serverTime: now(),
  }));

  if (webDist) {
    void app.register(fastifyStatic, { root: webDist, prefix: "/", wildcard: true });
  }

  app.setNotFoundHandler((request, reply) => {
    const path = pathOf(request);
    const acceptsHtml = String(request.headers.accept ?? "").includes("text/html");
    if (
      webDist && (request.method === "GET" || request.method === "HEAD") &&
      !isApiPath(path) && !isRacesPath(path) && acceptsHtml
    ) {
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    }
    return reply
      .status(404)
      .send({ error: `Route ${request.method} ${path} not found`, code: "not_found" });
  });

  registerSpectatorRoutes(app, {
    registry,
    hub,
    now,
    mode,
    demoMode: options.demoMode ?? false,
    showSabotageUpfront: options.showSabotageUpfront ?? true,
    throttles: { ...DEFAULT_STREAM_THROTTLES, ...options.streamThrottles },
  });
  registerDatasetRoutes(app, { store: registry.datasets, now, mode });

  // -------------------------------------------------------- browser sessions

  app.post<{ Body: { url?: string } }>("/api/browser-sessions", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body !== "object" || Array.isArray(body)) {
      throw new DomainError("invalid", "request body must be a JSON object");
    }
    return reply.status(201).send(
      await browserSessions.create(requireString(body.url, "url")),
    );
  });

  app.get<{ Params: { sessionId: string } }>(
    "/api/browser-sessions/:sessionId",
    async (request) => browserSessions.get(request.params.sessionId),
  );

  app.post<{
    Params: { sessionId: string };
    Body: { url?: string };
  }>("/api/browser-sessions/:sessionId/navigate", async (request) => {
    const body = request.body ?? {};
    if (typeof body !== "object" || Array.isArray(body)) {
      throw new DomainError("invalid", "request body must be a JSON object");
    }
    return browserSessions.navigate(
      request.params.sessionId,
      requireString(body.url, "url"),
    );
  });

  app.delete<{ Params: { sessionId: string } }>(
    "/api/browser-sessions/:sessionId",
    async (request) => browserSessions.release(request.params.sessionId),
  );

  // ------------------------------------------------------ operator routes

  app.post<{ Body: Partial<ApiCreateRaceInput> & { now?: number } }>(
    "/races",
    async (request, reply) => {
      const body = request.body ?? {};
      if (typeof body !== "object" || Array.isArray(body)) {
        throw new DomainError("invalid", "request body must be a JSON object");
      }
      const input: ApiCreateRaceInput = {
        raceId: requireString(body.raceId, "raceId"),
        courseId: requireString(body.courseId, "courseId"),
        seed: requireString(body.seed, "seed"),
        checkpointCount: requirePositiveInteger(body.checkpointCount, "checkpointCount"),
        task: requireString(body.task, "task"),
        startUrl: requireString(body.startUrl, "startUrl"),
        obstaclesEnabled: body.obstaclesEnabled ?? true,
        targetDurationMs: body.targetDurationMs,
        absoluteDurationMs: body.absoluteDurationMs,
        title: body.title,
        taskDetail: body.taskDetail,
        successCondition: body.successCondition,
        checkpointLabels: body.checkpointLabels,
        sabotage: body.sabotage,
        agents: body.agents,
        startsAt: body.startsAt,
      };
      const snapshot = await registry.create(input, body.now ?? now());
      return reply.status(201).send(snapshot);
    },
  );

  app.get<{ Params: { raceId: string } }>(
    "/races/:raceId",
    async (request) => registry.get(request.params.raceId).snapshot(),
  );

  app.get<{ Params: { raceId: string } }>(
    "/races/:raceId/events",
    async (request) => registry.get(request.params.raceId).events(),
  );

  app.post<{
    Params: { raceId: string };
    Body: { racerId?: string; checkpoint?: number; now?: number };
  }>("/races/:raceId/checkpoints", async (request) => {
    const racerId = requireString(request.body?.racerId, "racerId");
    const checkpoint = requirePositiveInteger(request.body?.checkpoint, "checkpoint");
    const race = registry.get(request.params.raceId);
    await race.recordCheckpoint(racerId, checkpoint, request.body?.now ?? now());
    return race.snapshot();
  });

  app.post<{
    Params: { raceId: string };
    Body: { racerId?: string; now?: number };
  }>("/races/:raceId/finish", async (request) => {
    const racerId = requireString(request.body?.racerId, "racerId");
    const race = registry.get(request.params.raceId);
    await race.recordFinish(racerId, request.body?.now ?? now());
    return race.snapshot();
  });

  app.post<{
    Params: { raceId: string };
    Body: { userId?: string; credits?: number };
  }>("/races/:raceId/market/fund", async (request) => {
    const userId = requireString(request.body?.userId, "userId");
    const credits = Number(request.body?.credits);
    if (!Number.isFinite(credits) || credits < 0) {
      throw new Error("credits must be a non-negative number");
    }
    const race = registry.get(request.params.raceId);
    race.fundSpectator(userId, credits);
    return { userId, balance: race.spectatorBalance(userId) };
  });

  app.post<{
    Params: { raceId: string };
    Body: { userId?: string; racerId?: string; quantity?: number };
  }>("/races/:raceId/market/buy", async (request) => {
    const userId = requireString(request.body?.userId, "userId");
    const racerId = requireString(request.body?.racerId, "racerId");
    const quantity = requirePositiveInteger(request.body?.quantity, "quantity");
    const race = registry.get(request.params.raceId);
    return {
      receipt: race.buyShares(userId, racerId, quantity),
      balance: race.spectatorBalance(userId),
      prices: race.market.pricesSnapshot(),
    };
  });

  app.post<{
    Params: { raceId: string };
    Body: { userId?: string; racerId?: string; quantity?: number };
  }>("/races/:raceId/market/sell", async (request) => {
    const userId = requireString(request.body?.userId, "userId");
    const racerId = requireString(request.body?.racerId, "racerId");
    const quantity = requirePositiveInteger(request.body?.quantity, "quantity");
    const race = registry.get(request.params.raceId);
    return {
      receipt: race.sellShares(userId, racerId, quantity),
      balance: race.spectatorBalance(userId),
      prices: race.market.pricesSnapshot(),
    };
  });

  // ------------------------------------------------------------ lifecycle

  app.addHook("onReady", async () => {
    if (options.onRegistryReady) {
      const stop = await options.onRegistryReady(registry);
      if (typeof stop === "function") stopRegistryHook = stop;
    }
    if (options.enableTicker === false) return;
    ticker = setInterval(() => {
      void registry.tickAll(now()).catch((error) => app.log.error(error));
    }, options.tickIntervalMs ?? 1_000);
    ticker.unref();
  });

  // End SSE streams before the HTTP server closes, or close() would wait
  // for those long-lived connections forever.
  app.addHook("preClose", async () => {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    hub.closeAll();
  });

  app.addHook("onClose", async () => {
    if (ticker) clearInterval(ticker);
    hub.closeAll();
    const stop = stopRegistryHook;
    stopRegistryHook = undefined;
    try {
      stop?.();
    } catch (error) {
      app.log.error(error);
    }
    await browserSessions.releaseAll();
    await registry.shutdown();
  });

  return app;
}
