import "dotenv/config";
import type { CoordinatorFactory, RaceRegistry } from "./api/race-registry.js";
import type { DatasetStore } from "./dataset/store.js";
import { buildApi, defaultDatasetStore } from "./api/server.js";
import { createProductionRaceCoordinator } from "./application/production-race-factory.js";
import { envApiOptions, envBoolean, envNumber } from "./env.js";
import { startMarketCrowd } from "./prediction/market-crowd.js";

const mode = process.env.RACE_MODE?.trim() || "live";
if (mode !== "live" && mode !== "simulated") {
  throw new Error("RACE_MODE must be live or simulated");
}
const port = envNumber("PORT", 3001);
const host = process.env.HOST ?? "127.0.0.1";

let coordinatorFactory: CoordinatorFactory = createProductionRaceCoordinator;
let onRegistryReady: ((registry: RaceRegistry) => Promise<() => void>) | undefined;
/** Set only when the replay cycle needs the API to share its store. */
let datasetStore: DatasetStore | undefined;

if (mode === "live") {
  const crowd = envBoolean("MARKET_CROWD", true);
  const replayCycle = envBoolean("REPLAY_AUTOPILOT", false);
  const replayTimeScale = envNumber("REPLAY_TIME_SCALE", 1);

  // Recorded fights replayed around the clock. Only replay course ids take
  // this path, so POST /races still runs a real fight. The dispatch has to be
  // in place before buildApi reads the factory, and the autopilot shares this
  // library so the factory can find the recording behind each fight.
  const replay = replayCycle ? await import("./replay/index.js") : null;
  // One store, shared by the factory, the autopilot and the API, so all three
  // read the same recordings.
  datasetStore = replay ? defaultDatasetStore(mode) : undefined;
  const replayLibrary = replay && datasetStore ? new replay.ReplayLibrary(datasetStore) : null;
  if (replay && replayLibrary && datasetStore) {
    const replayFactory = replay.createReplayCoordinatorFactory({
      library: replayLibrary,
      store: datasetStore,
      timeScale: replayTimeScale,
    });
    const production = coordinatorFactory;
    coordinatorFactory = (input, context) =>
      (replay.isReplayInput(input) ? replayFactory : production)(input, context);
  }

  if (crowd || replay) {
    onRegistryReady = async (registry) => {
      const stops: Array<() => void> = [];
      // Live fights have no traders of their own, so the market would only
      // reprice on checkpoints. The crowd gives it continuous two-way flow.
      if (crowd) {
        stops.push(await startMarketCrowd(registry, {
          seed: process.env.MARKET_CROWD_SEED ?? undefined,
          size: envNumber("MARKET_CROWD_SIZE", 14),
        }));
      }
      if (replay && replayLibrary && datasetStore) {
        stops.push(await replay.startReplayAutopilot(registry, {
          store: datasetStore,
          library: replayLibrary,
          liveFights: envNumber("REPLAY_LIVE_FIGHTS", 3),
          upcomingFights: envNumber("REPLAY_UPCOMING_FIGHTS", 2),
          timeScale: replayTimeScale,
        }));
      }
      return () => {
        for (const stop of stops) stop();
      };
    };
  }
}
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
  ...(datasetStore ? { datasetStore } : {}),
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
