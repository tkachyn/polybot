/**
 * `?slip=racer-1:yes` on /fights/:raceId opens the order form with that
 * outcome preselected. The lobby's featured card links here from its Yes /
 * No buttons; the fight screen reads it once, then drops it from the URL.
 */
import type { FightDetail, Side } from "@contract";
import type { Slip } from "./types";

export const SLIP_PARAM = "slip";

export function formatSlipParam(racerId: string, side: Side): string {
  return `${racerId}:${side}`;
}

/** The slip to preselect, or null when the value is invalid or trading is closed. */
export function slipFromParam(fight: Pick<FightDetail, "agents" | "marketStatus">, value: string | null): Slip | null {
  if (!value || fight.marketStatus !== "open") return null;
  const separator = value.lastIndexOf(":");
  if (separator < 1) return null;
  const racerId = value.slice(0, separator);
  const side = value.slice(separator + 1);
  if (side !== "yes" && side !== "no") return null;
  const agent = fight.agents.find((a) => a.racerId === racerId);
  if (!agent) return null;
  return { racerId: agent.racerId, side, price: side === "yes" ? agent.yes : agent.no };
}
