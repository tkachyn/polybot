import type {
  CreateRaceInput,
  RaceCoordinator,
  RaceSnapshot,
} from "../application/race-coordinator.js";

export type ApiCreateRaceInput = CreateRaceInput & {
  task: string;
  startUrl: string;
  obstaclesEnabled?: boolean;
};

export type CoordinatorFactory = (
  input: ApiCreateRaceInput,
) => Promise<RaceCoordinator> | RaceCoordinator;

export class RaceRegistry {
  private readonly races = new Map<string, RaceCoordinator>();

  constructor(private readonly factory: CoordinatorFactory) {}

  async create(input: ApiCreateRaceInput, now = Date.now()): Promise<RaceSnapshot> {
    if (this.races.has(input.raceId)) {
      throw new Error(`Race ${input.raceId} already exists`);
    }
    const coordinator = await this.factory(input);
    this.races.set(input.raceId, coordinator);
    try {
      return await coordinator.prepareAndStart(now);
    } catch (error) {
      this.races.delete(input.raceId);
      throw error;
    }
  }

  get(raceId: string): RaceCoordinator {
    const race = this.races.get(raceId);
    if (!race) throw new Error(`Race ${raceId} was not found`);
    return race;
  }

  async tickAll(now = Date.now()): Promise<void> {
    await Promise.all([...this.races.values()].map((race) => race.tick(now)));
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.races.values()].map((race) => race.shutdown()));
  }
}
