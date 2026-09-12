import "dotenv/config";
import type { CoordinatorFactory, RaceRegistry } from "./api/race-registry.js";
import { buildApi } from "./api/server.js";
import { createProductionRaceCoordinator } from "./application/production-race-factory.js";
import { envApiOptions, envNumber } from "./env.js";

const mode = process.env.RACE_MODE?.trim() || "live";
if (mode !== "live" && mode !== "simulated") {
  throw new Error("RACE_MODE must be live or simulated");
}
const port = envNumber("PORT", 3001);
const host = process.env.HOST ?? "127.0.0.1";

let coordinatorFactory: CoordinatorFactory = createProductionRaceCoordinator;
let onRegistryReady: ((registry: RaceRegistry) => Promise<() => void>) | undefined;
if (mode === "simulated") {
  const sim = await import("./simulation/index.js");
  const simOptions = {
    seed: process.env.SIM_SEED ?? "sabotage-markets",
    timeScale: envNumber("SIM_TIME_SCALE", 1),
  };
  coordinatorFactory = sim.createSimulatedCoordinatorFactory(simOptions);
  onRegistryReady = (registry) => sim.startSimulationAutopilot(registry, simOptions);
}

const app = buildApi({
  coordinatorFactory,
  ...envApiOptions(mode),
  onRegistryReady,
});

let closing = false;
function shutdown(signal: NodeJS.Signals): void {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, closing`);
  app.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await app.listen({ port, host });
console.log(`Sabotage Markets API (${mode}) listening on http://${host}:${port}`);
