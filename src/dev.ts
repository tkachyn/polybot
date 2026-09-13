import "dotenv/config";
import { buildApi } from "./api/server.js";
import { createProductionRaceCoordinator } from "./application/production-race-factory.js";
import { buildCourseApp } from "./course/course-server.js";
import { envApiOptions, envBoolean, envNumber } from "./env.js";
import { startMarketCrowd } from "./prediction/market-crowd.js";

// Live-mode API plus the local deterministic course, for development.
const api = buildApi({
  coordinatorFactory: createProductionRaceCoordinator,
  ...envApiOptions("live"),
  onRegistryReady: envBoolean("MARKET_CROWD", true)
    ? async (registry) => startMarketCrowd(registry, { size: envNumber("MARKET_CROWD_SIZE", 14) })
    : undefined,
});
const course = buildCourseApp();

await Promise.all([
  api.listen({
    port: envNumber("PORT", 3001),
    host: process.env.HOST ?? "127.0.0.1",
  }),
  course.listen({
    port: envNumber("COURSE_PORT", 4000),
    host: process.env.COURSE_HOST ?? "127.0.0.1",
  }),
]);
console.log(
  `Sabotage Markets API (live) on :${envNumber("PORT", 3001)}, course on :${envNumber("COURSE_PORT", 4000)}`,
);

async function shutdown(): Promise<void> {
  await Promise.allSettled([api.close(), course.close()]);
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
