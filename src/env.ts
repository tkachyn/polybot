import { resolve } from "node:path";
import type { ServerMode } from "./api/dto.js";
import type { ApiServerOptions } from "./api/server.js";

export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

export function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

/** The env-driven buildApi options shared by server.ts and dev.ts. */
export function envApiOptions(
  mode: ServerMode,
): Pick<
  ApiServerOptions,
  "mode" | "showSabotageUpfront" | "startingBalance" | "fightNumberStart" | "webDist"
> {
  return {
    mode,
    showSabotageUpfront: envBoolean("SHOW_SABOTAGE_UPFRONT", true),
    startingBalance: envNumber("STARTING_BALANCE", 1_000),
    fightNumberStart: envNumber("FIGHT_NUMBER_START", mode === "simulated" ? 401 : 1),
    webDist: resolve(process.env.WEB_DIST ?? "web/dist"),
  };
}
