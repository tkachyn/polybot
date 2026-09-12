import type { RaceEventStore } from "../application/contracts.js";
import type { RaceEvent } from "../domain/types.js";

export class InMemoryRaceEventStore implements RaceEventStore {
  private readonly events: RaceEvent[] = [];

  async append(event: RaceEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async list(raceId: string): Promise<RaceEvent[]> {
    return this.events
      .filter((event) => event.raceId === raceId)
      .map((event) => structuredClone(event));
  }
}
