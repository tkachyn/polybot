import Fastify, { type FastifyInstance } from "fastify";
import type { ApiCreateRaceInput, CoordinatorFactory } from "./race-registry.js";
import { RaceRegistry } from "./race-registry.js";

type ServerOptions = {
  coordinatorFactory: CoordinatorFactory;
  enableTicker?: boolean;
  tickIntervalMs?: number;
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

export function buildApi(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const registry = new RaceRegistry(options.coordinatorFactory);
  let ticker: ReturnType<typeof setInterval> | undefined;

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/.test(message)
      ? 404
      : /already exists/.test(message)
        ? 409
        : 400;
    void reply.status(status).send({ error: message });
  });

  app.post<{ Body: Partial<ApiCreateRaceInput> & { now?: number } }>(
    "/races",
    async (request, reply) => {
      const body = request.body ?? {};
      const input: ApiCreateRaceInput = {
        raceId: requireString(body.raceId, "raceId"),
        courseId: requireString(body.courseId, "courseId"),
        seed: requireString(body.seed, "seed"),
        checkpointCount: requirePositiveInteger(body.checkpointCount, "checkpointCount"),
        task: requireString(body.task, "task"),
        startUrl: requireString(body.startUrl, "startUrl"),
        obstaclesEnabled: body.obstaclesEnabled ?? false,
        targetDurationMs: body.targetDurationMs,
        absoluteDurationMs: body.absoluteDurationMs,
      };
      const snapshot = await registry.create(input, body.now ?? Date.now());
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
    await race.recordCheckpoint(racerId, checkpoint, request.body?.now ?? Date.now());
    return race.snapshot();
  });

  app.post<{
    Params: { raceId: string };
    Body: { racerId?: string; now?: number };
  }>("/races/:raceId/finish", async (request) => {
    const racerId = requireString(request.body?.racerId, "racerId");
    const race = registry.get(request.params.raceId);
    await race.recordFinish(racerId, request.body?.now ?? Date.now());
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

  app.addHook("onReady", async () => {
    if (options.enableTicker === false) return;
    ticker = setInterval(() => {
      void registry.tickAll().catch((error) => app.log.error(error));
    }, options.tickIntervalMs ?? 1_000);
    ticker.unref();
  });

  app.addHook("onClose", async () => {
    if (ticker) clearInterval(ticker);
    await registry.shutdown();
  });

  return app;
}
