import { buildApi } from "./api/server.js";
import { createProductionRaceCoordinator } from "./application/production-race-factory.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
const app = buildApi({ coordinatorFactory: createProductionRaceCoordinator });

await app.listen({ port, host });
