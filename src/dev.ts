import "dotenv/config";
import { buildApi } from "./api/server.js";
import { createProductionRaceCoordinator } from "./application/production-race-factory.js";
import { buildCourseApp } from "./course/course-server.js";

const api = buildApi({ coordinatorFactory: createProductionRaceCoordinator });
const course = buildCourseApp();

await Promise.all([
  api.listen({
    port: Number(process.env.PORT ?? 3001),
    host: process.env.HOST ?? "127.0.0.1",
  }),
  course.listen({
    port: Number(process.env.COURSE_PORT ?? 4000),
    host: process.env.COURSE_HOST ?? "127.0.0.1",
  }),
]);

async function shutdown(): Promise<void> {
  await Promise.allSettled([api.close(), course.close()]);
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
