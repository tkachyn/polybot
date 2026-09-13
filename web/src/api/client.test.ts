import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderRequest } from "@contract";
import {
  ApiFailure,
  DEFAULT_REQUEST_TIMEOUT_MS,
  ORDER_UNCONFIRMED_MESSAGE,
  TRANSFER_UNCONFIRMED_MESSAGE,
  deposit,
  describeError,
  ensureUser,
  getFight,
  isAbortError,
  isApiFailure,
  isUnconfirmed,
  onUnconfirmedRequest,
  placeOrder,
} from "./client";

type FetchInit = RequestInit & { signal: AbortSignal };

/** A fetch that never answers. Like the real one, it rejects when its signal aborts. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init: FetchInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      }),
  );
}

/** The headers arrive, then the body stalls. */
function stalledBodyFetch() {
  return vi.fn(
    async (_url: string, init: FetchInit) =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () =>
          new Promise<string>((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason));
          }),
      }) as unknown as Response,
  );
}

function reply(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

const order: OrderRequest = {
  userId: "user-0001",
  racerId: "racer-1",
  side: "yes",
  action: "buy",
  quantity: 10,
  limitPrice: 0.25,
  clientOrderId: "order-1",
};

describe("request timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("gives up on a hung GET after 15 s with a distinguishable timeout failure", async () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(15_000);
    const fetch = hangingFetch();
    vi.stubGlobal("fetch", fetch);
    let settled = false;
    const outcome = getFight("race-1")
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(ApiFailure);
    expect(error).toMatchObject({ code: "timeout", status: 0, unconfirmed: false });
    expect((error as ApiFailure).isTimeout).toBe(true);
    // The hung request was aborted, which frees its connection.
    expect(fetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(describeError(error)).toBe("The server is taking too long to respond. Check your connection and try again.");
  });

  it("reports a timed-out order as unconfirmed, never as failed, and announces it", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const heard: ApiFailure[] = [];
    const unsubscribe = onUnconfirmedRequest((failure) => heard.push(failure));
    const outcome = placeOrder("race-1", order).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
    const error = await outcome;
    unsubscribe();
    expect(isApiFailure(error, "timeout")).toBe(true);
    expect(isUnconfirmed(error)).toBe(true);
    expect(describeError(error)).toBe(ORDER_UNCONFIRMED_MESSAGE);
    expect(describeError(error)).not.toMatch(/fail/i);
    // The session re-reads balance and positions on this signal.
    expect(heard).toEqual([error]);
  });

  it("takes a per-call timeout", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    let settled = false;
    const outcome = placeOrder("race-1", order, { timeoutMs: 2_000 })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ code: "timeout", unconfirmed: true });
  });

  it("times out a response whose body stalls", async () => {
    vi.stubGlobal("fetch", stalledBodyFetch());
    const outcome = deposit("user-0001", { amount: 5, method: "virtual" }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
    const error = await outcome;
    expect(error).toMatchObject({ code: "timeout", status: 200, unconfirmed: true });
    expect(describeError(error)).toBe(TRANSFER_UNCONFIRMED_MESSAGE);
  });

  it("treats a timed-out idempotent write as a plain timeout", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const heard = vi.fn();
    const unsubscribe = onUnconfirmedRequest(heard);
    const outcome = ensureUser({ userId: "user-0001" }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(await outcome).toMatchObject({ code: "timeout", unconfirmed: false });
    expect(heard).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("rethrows the caller's own abort instead of a timeout", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const controller = new AbortController();
    const outcome = getFight("race-1", controller.signal).catch((error: unknown) => error);
    controller.abort();
    const error = await outcome;
    expect(isAbortError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ApiFailure);
  });

  it("clears its timer when the answer arrives in time", async () => {
    vi.stubGlobal("fetch", reply({ serverTime: Date.now(), fight: null, priceHistory: [] }));
    await expect(getFight("race-1")).resolves.toMatchObject({ priceHistory: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts a gateway timeout on an order as unconfirmed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 504 })));
    const error = await placeOrder("race-1", order).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "timeout", status: 504, unconfirmed: true });
  });

  it("keeps definite answers definite", async () => {
    vi.stubGlobal("fetch", reply({ error: "Price moved", code: "price_moved" }, 400));
    expect(await placeOrder("race-1", order).catch((e: unknown) => e)).toMatchObject({ code: "price_moved", unconfirmed: false });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(await placeOrder("race-1", order).catch((e: unknown) => e)).toMatchObject({ code: "network", unconfirmed: false });
  });
});
