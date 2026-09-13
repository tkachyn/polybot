/**
 * The signed-in (anonymous) user.
 *
 *   <SessionProvider> ... </SessionProvider>   mounted once in main.tsx
 *   const { userId, meta, account, portfolio, status, refresh, applyAccount } = useSession();
 *
 * Lifecycle:
 * 1. `userId` comes from localStorage "sm.userId" (created on first visit;
 *    in-memory fallback when storage is blocked). Stable for the session.
 * 2. `GET /api/meta` and `POST /api/users { userId }` run in parallel and
 *    retry with backoff until the server answers.
 * 3. Once the user exists, `GET /api/users/:id/stream` pushes `portfolio`
 *    events; each replaces `portfolio` and `account`.
 * 4. If the server forgot the user (restart with an in-memory store), the
 *    stream starts failing and REST returns 404: the provider re-creates the
 *    user with the same id and reopens the stream.
 * 5. While the stream is not delivering (down, or silent past its
 *    heartbeat), the portfolio is polled over REST.
 *
 * After an order or wallet transfer, call `applyAccount(response.account,
 * response.serverTime)` so the balance updates before the stream catches up.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Account, Portfolio, PortfolioResponse, ServerMeta, UserStreamEvents } from "@contract";
import {
  ApiFailure,
  ensureUser,
  getMeta,
  getPortfolio,
  getUser,
  isAbortError,
  isApiFailure,
  onUnconfirmedRequest,
  toApiFailure,
  userStreamUrl,
} from "../api/client";
import { useEventStream, type StreamStatus } from "../api/stream";
import { backoffMs } from "../lib/backoff";
import { needsFallbackPolling, useFallbackPolling } from "./polling";
import { getOrCreateUserId } from "./userId";

/**
 * - loading: the user has not been confirmed by the server yet.
 * - ready: `account` is known (it may be briefly stale while reconnecting).
 * - error: the user could not be created yet; `error` says why. Retries continue.
 */
export type SessionStatus = "loading" | "ready" | "error";

export type SessionValue = {
  userId: string;
  /** Null until GET /api/meta answers. */
  meta: ServerMeta | null;
  /** Null until the user is ensured. */
  account: Account | null;
  /** Null until the first portfolio event or REST fetch. */
  portfolio: Portfolio | null;
  status: SessionStatus;
  /** The most recent failure, cleared on the next success. */
  error: ApiFailure | null;
  /** The user stream's connection status (for the connection indicator). */
  streamStatus: StreamStatus;
  /** Re-fetches the portfolio (and account) over REST. Never rejects. */
  refresh: () => Promise<void>;
  /**
   * Applies an account from an order or transfer response. Pass the
   * response's `serverTime` so an older payload never overwrites a newer one.
   */
  applyAccount: (account: Account, serverTime?: number) => void;
  /** Sets the public judge name for standings. */
  updateDisplayName: (displayName: string) => Promise<boolean>;
};

const SessionContext = createContext<SessionValue | null>(null);

/** Minimum gap between "does the user still exist?" checks. */
const USER_CHECK_GAP_MS = 5_000;
/** REST portfolio polling while the stream is not open. */
const PORTFOLIO_POLL_MS = 10_000;
const PORTFOLIO_FIRST_POLL_MS = 1_500;
/** Portfolio reads after an unconfirmed write before leaving it to the stream and polling. */
const RECONCILE_ATTEMPTS = 6;

export type SessionProviderProps = {
  children: ReactNode;
  /** Override the stored id (tests, demos). */
  userId?: string;
};

export function SessionProvider({ children, userId: userIdOverride }: SessionProviderProps) {
  const [userId] = useState(() => userIdOverride ?? getOrCreateUserId());
  const [meta, setMeta] = useState<ServerMeta | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [ensured, setEnsured] = useState(false);
  const [streamEpoch, setStreamEpoch] = useState(0);

  const alive = useRef(true);
  const accountTime = useRef(-Infinity);
  const portfolioTime = useRef(-Infinity);
  const ensuring = useRef<Promise<boolean> | null>(null);
  const lastUserCheck = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const applyAccount = useCallback((next: Account, serverTime?: number) => {
    if (serverTime !== undefined) {
      if (serverTime < accountTime.current) return;
      accountTime.current = serverTime;
    }
    setAccount(next);
    setPortfolio((prev) => (prev ? { ...prev, account: next } : prev));
  }, []);

  const applyPortfolio = useCallback(
    (data: PortfolioResponse) => {
      if (data.serverTime < portfolioTime.current) return;
      portfolioTime.current = data.serverTime;
      setPortfolio({ account: data.account, positions: data.positions, history: data.history });
      applyAccount(data.account, data.serverTime);
      setError(null);
    },
    [applyAccount],
  );

  /** POST /api/users. Concurrent calls share one request. Resolves true on success. */
  const ensure = useCallback((): Promise<boolean> => {
    if (ensuring.current) return ensuring.current;
    const run = ensureUser({ userId })
      .then((res) => {
        if (!alive.current) return false;
        applyAccount(res.account, res.serverTime);
        setEnsured(true);
        setError(null);
        return true;
      })
      .catch((err: unknown) => {
        if (alive.current && !isAbortError(err)) setError(toApiFailure(err));
        return false;
      })
      .finally(() => {
        ensuring.current = null;
      });
    ensuring.current = run;
    return run;
  }, [userId, applyAccount]);

  /** Re-creates a user the server forgot, then reopens the stream at once. */
  const reensure = useCallback(async () => {
    if (await ensure()) setStreamEpoch((n) => n + 1);
  }, [ensure]);

  // Meta: once, retrying until the server answers.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const load = () => {
      getMeta(controller.signal)
        .then((m) => setMeta(m))
        .catch((err: unknown) => {
          if (isAbortError(err)) return;
          timer = setTimeout(load, backoffMs(attempt));
          attempt += 1;
        });
    };
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  // Ensure the user, retrying until it succeeds.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let attempt = 0;
    const run = async () => {
      const ok = await ensure();
      if (cancelled || ok) return;
      timer = setTimeout(run, backoffMs(attempt));
      attempt += 1;
    };
    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ensure]);

  /** GETs the portfolio, re-creating a user the server forgot. True on success; never rejects. */
  const loadPortfolio = useCallback(
    async (signal?: AbortSignal): Promise<boolean> => {
      try {
        applyPortfolio(await getPortfolio(userId, signal));
        return true;
      } catch (err) {
        // An aborted poll (the stream came back) is not a failure.
        if (isAbortError(err) || signal?.aborted || !alive.current) return false;
        if (isApiFailure(err, "not_found")) {
          await reensure();
          try {
            applyPortfolio(await getPortfolio(userId, signal));
            return true;
          } catch (retryErr) {
            if (alive.current && !isAbortError(retryErr) && !signal?.aborted) setError(toApiFailure(retryErr));
            return false;
          }
        }
        setError(toApiFailure(err));
        return false;
      }
    },
    [userId, applyPortfolio, reensure],
  );

  const refresh = useCallback(async () => {
    await loadPortfolio();
  }, [loadPortfolio]);

  const streamStatus = useEventStream<UserStreamEvents>(
    ensured ? userStreamUrl(userId) : null,
    { portfolio: applyPortfolio },
    { reconnectKey: streamEpoch },
  );

  // A failing stream may mean the server forgot the user: check and re-ensure.
  useEffect(() => {
    if (!ensured || streamStatus !== "reconnecting") return;
    const now = Date.now();
    if (now - lastUserCheck.current < USER_CHECK_GAP_MS) return;
    lastUserCheck.current = now;
    getUser(userId)
      .then((res) => applyAccount(res.account, res.serverTime))
      .catch((err: unknown) => {
        if (isApiFailure(err, "not_found")) void reensure();
      });
  }, [ensured, streamStatus, userId, applyAccount, reensure]);

  // REST fallback while the stream is not delivering.
  useFallbackPolling(ensured && needsFallbackPolling(streamStatus), loadPortfolio, {
    intervalMs: PORTFOLIO_POLL_MS,
    firstDelayMs: PORTFOLIO_FIRST_POLL_MS,
  });

  // A write that timed out (an order, a transfer) may still have gone
  // through. Re-read balance and positions until a read succeeds, so the
  // screen shows what actually happened.
  useEffect(() => {
    let cancelled = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async (n: number) => {
      timer = undefined;
      const ok = await loadPortfolio();
      if (cancelled) return;
      if (ok || n + 1 >= RECONCILE_ATTEMPTS) {
        running = false;
        return;
      }
      timer = setTimeout(() => void attempt(n + 1), backoffMs(n));
    };
    const unsubscribe = onUnconfirmedRequest(() => {
      if (running) return;
      running = true;
      void attempt(0);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      clearTimeout(timer);
    };
  }, [loadPortfolio]);

  const status: SessionStatus = account ? "ready" : error ? "error" : "loading";

  const updateDisplayName = useCallback(async (displayName: string): Promise<boolean> => {
    try {
      const response = await ensureUser({ userId, displayName });
      applyAccount(response.account, response.serverTime);
      setError(null);
      return true;
    } catch (err) {
      if (!isAbortError(err)) setError(toApiFailure(err));
      return false;
    }
  }, [userId, applyAccount]);

  const value = useMemo<SessionValue>(
    () => ({ userId, meta, account, portfolio, status, error, streamStatus, refresh, applyAccount, updateDisplayName }),
    [userId, meta, account, portfolio, status, error, streamStatus, refresh, applyAccount, updateDisplayName],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The session. Must be inside <SessionProvider>. */
export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession() must be used inside <SessionProvider>.");
  return value;
}
