import { steelKeysFromEnv } from "../src/infra/steel-key-pool.js";
import { SteelSessionManager } from "../src/infra/steel-session-manager.js";

if (steelKeysFromEnv().length === 0) {
  throw new Error("STEEL_API_KEYS or STEEL_API_KEY is required for the Steel smoke test");
}

const manager = new SteelSessionManager({
  sessionTimeoutSeconds: 120,
});

try {
  const sessions = await Promise.all(
    [1, 2, 3, 4].map((index) => manager.create(`racer-${index}`)),
  );
  const targetUrl = process.env.STEEL_SMOKE_URL ?? "https://example.com";
  await Promise.all(
    sessions.map((session) =>
      session.page.goto(targetUrl, { waitUntil: "domcontentloaded" }),
    ),
  );
  const titles = await Promise.all(
    sessions.map((session) => session.page.title()),
  );
  if (titles.some((title) => title.length === 0)) {
    throw new Error("At least one Steel session returned an empty page title");
  }
  console.log(`Steel smoke test passed for ${sessions.length} racer sessions`);
} finally {
  await manager.releaseAll();
}
