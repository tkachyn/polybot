import type { FastifyInstance } from "fastify";
import { DomainError } from "../domain/errors.js";
import {
  MATRIX_DEFAULT_DAYS,
  MATRIX_MAX_DAYS,
  buildRobustnessMatrix,
  selectFinalEvaluations,
  toExportRows,
  type MatrixMode,
} from "../evaluation/matrix.js";
import type {
  AccountResponse,
  EnsureUserRequest,
  FightEvaluationResponse,
  FightStatus,
  OrderRequest,
  OrderResponse,
  PortfolioResponse,
  RobustnessMatrixResponse,
  ServerMode,
  TraderLeaderboardResponse,
  WalletTransferRequest,
  WalletTransferResponse,
} from "./dto.js";
import {
  leaderboardRecord,
  presentAccount,
  presentFightDetail,
  presentFightDetailResponse,
  presentFightList,
  presentLeaderboard,
  presentLedgerEntry,
  presentMeta,
  presentMyFight,
  presentPortfolio,
  presentTraderLeaderboard,
  type AccountSources,
  type LeaderboardRecord,
} from "./presenters.js";
import type { RaceRegistry } from "./race-registry.js";
import { trailingThrottle, type SseHub } from "./sse.js";

export type StreamThrottles = {
  /** GET /api/fights/stream. */
  fightsMs: number;
  /** `fight` events on GET /api/fights/:raceId/stream (trailing). */
  fightMs: number;
  /** GET /api/users/:userId/stream. */
  portfolioMs: number;
};

export const DEFAULT_STREAM_THROTTLES: StreamThrottles = {
  fightsMs: 500,
  fightMs: 250,
  portfolioMs: 500,
};

export type SpectatorContext = {
  registry: RaceRegistry;
  hub: SseHub;
  now: () => number;
  mode: ServerMode;
  demoMode: boolean;
  showSabotageUpfront: boolean;
  throttles: StreamThrottles;
};

const FIGHT_STATUSES: readonly FightStatus[] = ["upcoming", "live", "resolved"];
const EVALUATION_MODES: readonly MatrixMode[] = ["live", "simulated", "all"];
const DAY_MS = 86_400_000;
export const EVALUATION_EXPORT_FILENAME = "sabotage-markets-evaluations.jsonl";

type EvaluationQuery = { days?: string; mode?: string };

/** `days`: an integer from 1 to 365, default 30. */
function parseDays(value: unknown): number {
  if (value === undefined || value === "") return MATRIX_DEFAULT_DAYS;
  const days = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(days) || days < 1 || days > MATRIX_MAX_DAYS) {
    throw new DomainError("invalid", `days must be an integer from 1 to ${MATRIX_MAX_DAYS}`);
  }
  return days;
}

/** `mode`: live, simulated or all; default the server's mode. */
function parseEvaluationMode(value: unknown, fallback: ServerMode): MatrixMode {
  if (value === undefined || value === "") return fallback;
  if (typeof value === "string" && (EVALUATION_MODES as readonly string[]).includes(value)) {
    return value as MatrixMode;
  }
  throw new DomainError("invalid", "mode must be live, simulated or all");
}

function parseStatus(value: unknown): FightStatus | undefined {
  if (value === undefined || value === "" || value === "all") return undefined;
  if (typeof value === "string" && (FIGHT_STATUSES as readonly string[]).includes(value)) {
    return value as FightStatus;
  }
  throw new DomainError("invalid", "status must be upcoming, live, resolved or all");
}

function bodyObject<T>(body: unknown): Partial<T> {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new DomainError("invalid", "request body must be a JSON object");
  }
  return body as Partial<T>;
}

/** Registers every /api route from docs/frontend-contract.md. */
export function registerSpectatorRoutes(app: FastifyInstance, context: SpectatorContext): void {
  const { registry, hub, now } = context;
  const users = registry.users;

  const present = (at: number) => ({ now: at, showSabotageUpfront: context.showSabotageUpfront });
  const sources = (): AccountSources => ({
    ledger: registry.ledger,
    coordinators: registry.list(),
    fightInfo: (raceId) => registry.fightInfo(raceId),
  });
  const accountResponse = (userId: string, at: number): AccountResponse => ({
    serverTime: at,
    account: presentAccount(users.get(userId), sources()),
  });
  const portfolioResponse = (userId: string, at: number): PortfolioResponse => ({
    serverTime: at,
    ...presentPortfolio(users.get(userId), sources()),
  });
  const leaderboardRecords = (): LeaderboardRecord[] => [
    ...registry.list()
      .map((race) => leaderboardRecord(race))
      .filter((record): record is LeaderboardRecord => record !== null),
    ...registry.archivedLeaderboard(),
  ];

  app.get("/api/meta", async () =>
    presentMeta(
      {
        mode: context.mode,
        demoMode: context.demoMode,
        showSabotageUpfront: context.showSabotageUpfront,
        startingBalance: users.startingBalance,
      },
      now(),
    ));

  // ------------------------------------------------------------------ fights

  app.get<{ Querystring: { status?: string } }>("/api/fights", async (request) => {
    const status = parseStatus(request.query.status);
    return presentFightList(registry.list(), { ...present(now()), status });
  });

  app.get<{ Querystring: { status?: string } }>("/api/fights/stream", (request, reply) => {
    const status = parseStatus(request.query.status);
    const stream = hub.open(request, reply);
    const send = () =>
      stream.send("fights", presentFightList(registry.list(), { ...present(now()), status }));
    send();
    const throttle = trailingThrottle(send, context.throttles.fightsMs);
    const unsubscribe = registry.subscribe((_raceId, change) => {
      if (change.kind === "fight" || change.kind === "created" || change.kind === "removed") {
        throttle.schedule();
      }
    });
    stream.onClose(() => {
      unsubscribe();
      throttle.cancel();
    });
  });

  app.get<{ Params: { raceId: string } }>("/api/fights/:raceId", async (request) =>
    presentFightDetailResponse(registry.get(request.params.raceId), present(now())));

  app.get<{ Params: { raceId: string } }>("/api/fights/:raceId/stream", (request, reply) => {
    const raceId = request.params.raceId;
    const race = registry.get(raceId);
    const stream = hub.open(request, reply);
    stream.send("snapshot", presentFightDetailResponse(race, present(now())));
    const throttle = trailingThrottle(() => {
      const at = now();
      stream.send("fight", { serverTime: at, fight: presentFightDetail(race, present(at)) });
    }, context.throttles.fightMs);
    const unsubscribe = registry.subscribe((changedRaceId, change) => {
      if (changedRaceId !== raceId) return;
      if (change.kind === "price") {
        stream.send("price", { serverTime: now(), point: change.point });
      } else if (change.kind === "fight" || change.kind === "frame") {
        throttle.schedule();
      } else if (change.kind === "removed") {
        stream.close();
      }
    });
    stream.onClose(() => {
      unsubscribe();
      throttle.cancel();
    });
  });

  app.get<{ Params: { raceId: string }; Querystring: { userId?: string } }>(
    "/api/fights/:raceId/me",
    async (request) => {
      const race = registry.get(request.params.raceId);
      const userId = request.query.userId;
      if (typeof userId !== "string" || userId.length === 0) {
        throw new DomainError("invalid", "userId is required");
      }
      users.get(userId);
      return presentMyFight(race, userId, registry.ledger, now());
    },
  );

  app.get<{ Params: { raceId: string } }>(
    "/api/fights/:raceId/traders",
    async (request): Promise<TraderLeaderboardResponse> => {
      const race = registry.get(request.params.raceId);
      return presentTraderLeaderboard(race, users.list(), registry.ledger, now());
    },
  );

  app.get<{ Params: { raceId: string } }>(
    "/api/fights/:raceId/traders/stream",
    (request, reply) => {
      const raceId = request.params.raceId;
      const race = registry.get(raceId);
      const stream = hub.open(request, reply);
      const send = () => stream.send(
        "standings",
        presentTraderLeaderboard(race, users.list(), registry.ledger, now()),
      );
      send();
      const throttle = trailingThrottle(send, context.throttles.portfolioMs);
      const unsubscribeRaces = registry.subscribe((changedRaceId, change) => {
        if (changedRaceId === raceId && (change.kind === "account" || change.kind === "price" || change.kind === "fight")) {
          throttle.schedule();
        }
      });
      const unsubscribeUsers = users.subscribe(() => throttle.schedule());
      stream.onClose(() => {
        unsubscribeRaces();
        unsubscribeUsers();
        throttle.cancel();
      });
    },
  );

  app.get<{ Params: { raceId: string; racerId: string }; Querystring: { seq?: string } }>(
    "/api/fights/:raceId/agents/:racerId/frame",
    async (request, reply) => {
      const race = registry.get(request.params.raceId);
      const frame = race.frame(request.params.racerId);
      if (!frame) throw new DomainError("not_found", "no frame captured yet");
      return reply
        .header("Content-Type", frame.contentType)
        .header("Cache-Control", "no-store")
        .header("X-Frame-Seq", String(frame.seq))
        .send(frame.body);
    },
  );

  app.post<{ Params: { raceId: string }; Body: OrderRequest }>(
    "/api/fights/:raceId/orders",
    async (request): Promise<OrderResponse> => {
      const race = registry.get(request.params.raceId);
      const body = bodyObject<OrderRequest>(request.body);
      if (typeof body.userId !== "string" || body.userId.length === 0) {
        throw new DomainError("invalid", "userId is required");
      }
      users.get(body.userId);
      const at = now();
      const receipt = race.placeOrder(
        {
          userId: body.userId,
          racerId: body.racerId as string,
          side: body.side as OrderRequest["side"],
          action: body.action as OrderRequest["action"],
          quantity: body.quantity as number,
          limitPrice: body.limitPrice,
          clientOrderId: body.clientOrderId,
        },
        at,
      );
      return {
        serverTime: at,
        receipt,
        account: presentAccount(users.get(body.userId), sources()),
        quotes: race.market.quotes(),
      };
    },
  );

  // ------------------------------------------------------------------- users

  app.post<{ Body: EnsureUserRequest }>("/api/users", async (request, reply) => {
    const body = bodyObject<EnsureUserRequest>(request.body);
    const at = now();
    const { user, created } = users.ensure(
      { userId: body.userId, displayName: body.displayName },
      at,
    );
    return reply.status(created ? 201 : 200).send(accountResponse(user.userId, at));
  });

  app.get<{ Params: { userId: string } }>("/api/users/:userId", async (request) =>
    accountResponse(request.params.userId, now()));

  app.get<{ Params: { userId: string } }>("/api/users/:userId/portfolio", async (request) =>
    portfolioResponse(request.params.userId, now()));

  for (const direction of ["deposit", "withdraw"] as const) {
    app.post<{ Params: { userId: string }; Body: WalletTransferRequest }>(
      `/api/users/:userId/${direction}`,
      async (request): Promise<WalletTransferResponse> => {
        if (context.demoMode) {
          throw new DomainError("invalid", "Wallet transfers are disabled in demo mode");
        }
        const userId = request.params.userId;
        const body = bodyObject<WalletTransferRequest>(request.body);
        const at = now();
        const amount = body.amount as number;
        const method = body.method as WalletTransferRequest["method"];
        const entry = direction === "deposit"
          ? users.deposit(userId, amount, method, at)
          : users.withdraw(userId, amount, method, at);
        return {
          serverTime: at,
          account: presentAccount(users.get(userId), sources()),
          entry: presentLedgerEntry(entry, (raceId) => registry.fightInfo(raceId)),
        };
      },
    );
  }

  app.get<{ Params: { userId: string } }>("/api/users/:userId/stream", (request, reply) => {
    const userId = request.params.userId;
    users.get(userId);
    const stream = hub.open(request, reply);
    const send = () => {
      try {
        stream.send("portfolio", portfolioResponse(userId, now()));
      } catch {
        stream.close();
      }
    };
    send();
    const throttle = trailingThrottle(send, context.throttles.portfolioMs);
    const unsubscribeRaces = registry.subscribe((_raceId, change) => {
      if (change.kind === "account" && change.userIds.includes(userId)) throttle.schedule();
    });
    const unsubscribeUsers = users.subscribe((userIds) => {
      if (userIds.includes(userId)) throttle.schedule();
    });
    stream.onClose(() => {
      unsubscribeRaces();
      unsubscribeUsers();
      throttle.cancel();
    });
  });

  // ------------------------------------------------------------- leaderboard

  app.get("/api/leaderboard", async () => presentLeaderboard(leaderboardRecords(), now()));

  // -------------------------------------------------------------- evaluation

  const evaluations = registry.evaluations;

  /** Final evaluations in the query's window and mode, newest fights first. */
  const windowed = async (query: EvaluationQuery, at: number) => {
    const days = parseDays(query.days);
    const mode = parseEvaluationMode(query.mode, context.mode);
    const since = at - days * DAY_MS;
    const stored = await evaluations.list({ since, mode: mode === "all" ? undefined : mode });
    return { days, mode, since, stored };
  };

  // A fight still in the registry answers itself (provisional while live);
  // a pruned one answers from the store.
  app.get<{ Params: { raceId: string } }>(
    "/api/fights/:raceId/evaluation",
    async (request): Promise<FightEvaluationResponse> => {
      const at = now();
      const raceId = request.params.raceId;
      const race = registry.find(raceId);
      const evaluation = race ? race.evaluation(at) : await evaluations.get(raceId);
      if (!evaluation) throw new DomainError("not_found", `Race ${raceId} was not found`);
      return { serverTime: at, evaluation };
    },
  );

  app.get<{ Params: { raceId: string; racerId: string; key: string } }>(
    "/api/fights/:raceId/agents/:racerId/evidence/:key",
    async (request, reply) => {
      const race = registry.get(request.params.raceId);
      const frame = race.evidenceFrame(request.params.racerId, request.params.key);
      if (!frame) throw new DomainError("not_found", "no such evidence frame");
      return reply
        .header("Content-Type", frame.contentType)
        .header("Cache-Control", "private, max-age=3600")
        .send(frame.body);
    },
  );

  app.get<{ Params: { raceId: string; racerId: string } }>(
    "/api/fights/:raceId/agents/:racerId/replay.m3u8",
    async (request, reply) => {
      const race = registry.get(request.params.raceId);
      const playlist = await race.replayPlaylist(request.params.racerId);
      if (playlist === null) throw new DomainError("not_found", "no replay for this agent");
      return reply
        .header("Content-Type", "application/vnd.apple.mpegurl")
        .header("Cache-Control", "no-store")
        .send(playlist);
    },
  );

  app.get<{ Querystring: EvaluationQuery }>(
    "/api/evaluations/matrix",
    async (request): Promise<RobustnessMatrixResponse> => {
      const at = now();
      const { days, mode, since, stored } = await windowed(request.query, at);
      return buildRobustnessMatrix(stored, { windowDays: days, since, mode, now: at });
    },
  );

  app.get<{ Querystring: EvaluationQuery }>("/api/evaluations/export.jsonl", async (request, reply) => {
    const { mode, since, stored } = await windowed(request.query, now());
    const rows = toExportRows(selectFinalEvaluations(stored, { since, mode }));
    const body = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
    return reply
      .header("Content-Type", "application/x-ndjson")
      .header("Content-Disposition", `attachment; filename="${EVALUATION_EXPORT_FILENAME}"`)
      .header("Cache-Control", "no-store")
      .send(body);
  });
}
