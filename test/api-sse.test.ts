import assert from "node:assert/strict";
import { get, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { buildApi } from "../src/api/server.js";
import { createFactory, raceInput } from "./api-fixtures.js";

type SseEvent = { event: string; data: any };

/** Minimal text/event-stream client for tests. */
class SseClient {
  raw = "";
  ended = false;
  private buffer = "";
  private readonly events: SseEvent[] = [];
  private readonly waiters = new Set<() => void>();

  private constructor(readonly response: IncomingMessage) {
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      this.raw += chunk;
      this.buffer += chunk;
      let boundary = this.buffer.indexOf("\n\n");
      while (boundary >= 0) {
        this.parse(this.buffer.slice(0, boundary));
        this.buffer = this.buffer.slice(boundary + 2);
        boundary = this.buffer.indexOf("\n\n");
      }
      this.notify();
    });
    response.on("end", () => {
      this.ended = true;
      this.notify();
    });
    response.on("close", () => {
      this.ended = true;
      this.notify();
    });
  }

  static connect(url: string): Promise<SseClient> {
    return new Promise((resolve, reject) => {
      get(url, { headers: { accept: "text/event-stream" } }, (response) =>
        resolve(new SseClient(response))).on("error", reject);
    });
  }

  /** Removes and returns the next event with this name. */
  async take(name: string, timeoutMs = 3_000): Promise<SseEvent> {
    const index = this.events.findIndex((event) => event.event === name);
    if (index >= 0) return this.events.splice(index, 1)[0];
    await this.waitFor(() => this.events.some((event) => event.event === name), timeoutMs, name);
    return this.take(name, timeoutMs);
  }

  count(name: string): number {
    return this.events.filter((event) => event.event === name).length;
  }

  waitForEnd(timeoutMs = 3_000): Promise<void> {
    return this.waitFor(() => this.ended, timeoutMs, "end");
  }

  close(): void {
    this.response.destroy();
  }

  private waitFor(done: () => boolean, timeoutMs: number, label: string): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      const check = () => {
        if (!done()) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      this.waiters.add(check);
    });
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private parse(block: string): void {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    if (data.length > 0) this.events.push({ event, data: JSON.parse(data.join("\n")) });
  }
}

async function listen() {
  const { factory } = createFactory();
  const app = buildApi({ coordinatorFactory: factory, enableTicker: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}` };
}

test("fight stream sends snapshot, then price and fight events after a trade", async () => {
  const { app, base } = await listen();
  try {
    await app.inject({ method: "POST", url: "/api/users", payload: { userId: "alice-01" } });
    await app.inject({ method: "POST", url: "/api/users", payload: { userId: "bob-0001" } });
    await app.inject({ method: "POST", url: "/races", payload: raceInput("race-sse") });

    const missing = await app.inject({ method: "GET", url: "/api/fights/missing/stream" });
    assert.deepEqual([missing.statusCode, missing.json().code], [404, "not_found"]);

    const fight = await SseClient.connect(`${base}/api/fights/race-sse/stream`);
    assert.match(String(fight.response.headers["content-type"]), /^text\/event-stream/);
    const snapshot = await fight.take("snapshot");
    assert.ok(fight.raw.startsWith("retry: 2000\n\n"));
    assert.equal(snapshot.data.fight.raceId, "race-sse");
    assert.ok(snapshot.data.priceHistory.length >= 2);
    assert.equal(typeof snapshot.data.serverTime, "number");

    const user = await SseClient.connect(`${base}/api/users/alice-01/stream`);
    const initial = await user.take("portfolio");
    assert.equal(initial.data.account.balance, 1_000);

    // Another user's wallet change is not sent to alice.
    await app.inject({
      method: "POST", url: "/api/users/bob-0001/deposit", payload: { amount: 5, method: "virtual" },
    });

    const order = await app.inject({
      method: "POST",
      url: "/api/fights/race-sse/orders",
      payload: { userId: "alice-01", racerId: "racer-1", side: "yes", action: "buy", quantity: 10 },
    });
    assert.equal(order.statusCode, 200);

    const price = await fight.take("price");
    assert.ok(price.data.point.prices["racer-1"] > 0.25);
    const update = await fight.take("fight");
    assert.equal(update.data.fight.volume, 2.5);
    assert.equal(update.data.priceHistory, undefined);

    const portfolio = await user.take("portfolio");
    assert.equal(portfolio.data.positions.length, 1);
    assert.equal(portfolio.data.account.balance, 997.5);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(user.count("portfolio"), 0);

    fight.close();
    user.close();
  } finally {
    await app.close();
  }
});

test("app.close ends open SSE streams instead of hanging", async () => {
  const { app, base } = await listen();
  const fights = await SseClient.connect(`${base}/api/fights/stream`);
  const first = await fights.take("fights");
  assert.deepEqual(first.data.fights, []);

  await app.inject({ method: "POST", url: "/races", payload: raceInput("race-new") });
  const next = await fights.take("fights");
  assert.equal(next.data.fights[0].raceId, "race-new");

  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    app.close(),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("app.close() hung")), 3_000);
    }),
  ]);
  clearTimeout(timer);
  await fights.waitForEnd();
  assert.equal(fights.ended, true);
});
