import assert from "node:assert/strict";
import test from "node:test";
import { SteelKeyPool, steelKeysFromEnv } from "../src/infra/steel-key-pool.js";

function apiError(status: number, message = `status ${status}`) {
  return Object.assign(new Error(message), { status });
}

function pool(keys: string[], now = () => 0) {
  return new SteelKeyPool({ keys, createClient: (apiKey) => ({ apiKey }), now });
}

test("parses STEEL_API_KEYS and STEEL_API_KEY without duplicates", () => {
  assert.deepEqual(
    steelKeysFromEnv({ STEEL_API_KEYS: "a, b\nc,,", STEEL_API_KEY: "b" }),
    ["a", "b", "c"],
  );
  assert.deepEqual(steelKeysFromEnv({ STEEL_API_KEY: "solo" }), ["solo"]);
  assert.deepEqual(steelKeysFromEnv({}), []);
});

test("keeps using the current key while it works", async () => {
  const keys = pool(["a", "b"]);
  const used: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    await keys.run(async ({ apiKey }) => used.push(apiKey));
  }
  assert.deepEqual(used, ["a", "a", "a"]);
});

test("rotates to the next key when one runs out and stays there", async () => {
  const keys = pool(["a", "b", "c"]);
  const used: string[] = [];
  const call = () =>
    keys.run(async ({ apiKey, client }) => {
      used.push(apiKey);
      assert.equal(client.apiKey, apiKey);
      if (apiKey === "a") throw apiError(402, "Insufficient credits");
      return apiKey;
    });

  assert.equal((await call()).lease.apiKey, "b");
  assert.equal((await call()).lease.apiKey, "b");
  assert.deepEqual(used, ["a", "b", "b"]);
});

test("rotates on exhaustion messages without a status code", async () => {
  const keys = pool(["a", "b"]);
  const { lease } = await keys.run(async ({ apiKey }) => {
    if (apiKey === "a") throw new Error("Monthly usage quota exceeded");
  });
  assert.equal(lease.apiKey, "b");
});

test("does not rotate on unrelated errors", async () => {
  const keys = pool(["a", "b"]);
  await assert.rejects(
    keys.run(async () => {
      throw apiError(500, "boom");
    }),
    /boom/,
  );
  const { lease } = await keys.run(async () => undefined);
  assert.equal(lease.apiKey, "a");
});

test("throws once every key is exhausted", async () => {
  const keys = pool(["a", "b"]);
  await assert.rejects(
    keys.run(async () => {
      throw apiError(401, "Invalid API key");
    }),
    /All 2 Steel API keys are exhausted: Invalid API key/,
  );
});

test("rate-limited keys come back after the cooldown", async () => {
  let clock = 0;
  const keys = pool(["a", "b"], () => clock);
  let bLimited = true;
  const call = () =>
    keys.run(async ({ apiKey }) => {
      if (apiKey === "a") throw apiError(429);
      if (bLimited) throw apiError(429);
    });

  await assert.rejects(call(), /exhausted/);
  clock = 60_000;
  bLimited = false;
  assert.equal((await call()).lease.apiKey, "b");
});

test("concurrent failures on one key advance the cursor only once", async () => {
  const keys = pool(["a", "b", "c"]);
  const results = await Promise.all(
    [1, 2, 3, 4].map(() =>
      keys.run(async ({ apiKey }) => {
        await Promise.resolve();
        if (apiKey === "a") throw apiError(402);
      }),
    ),
  );
  assert.deepEqual(
    results.map(({ lease }) => lease.apiKey),
    ["b", "b", "b", "b"],
  );
});
