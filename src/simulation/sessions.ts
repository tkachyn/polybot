import type {
  RacerSessionHandle,
  RacerSessionManager,
} from "../application/contracts.js";
import { hashString } from "./rng.js";

/** Browser sessions without a browser: stable ids, no page, no viewer. */
export class SimulatedSessionManager implements RacerSessionManager {
  private readonly sessions = new Map<string, RacerSessionHandle>();

  constructor(private readonly raceId: string) {}

  async create(racerId: string): Promise<RacerSessionHandle> {
    const suffix = hashString(`${this.raceId}:${racerId}`).toString(16).padStart(8, "0");
    const session: RacerSessionHandle = { racerId, steelSessionId: `sim-${suffix}` };
    this.sessions.set(racerId, session);
    return { ...session };
  }

  async release(racerId: string): Promise<void> {
    this.sessions.delete(racerId);
  }

  async releaseAll(): Promise<void> {
    this.sessions.clear();
  }

  activeCount(): number {
    return this.sessions.size;
  }
}
