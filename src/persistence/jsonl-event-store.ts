import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RaceEventStore } from "../application/contracts.js";
import type { RaceEvent } from "../domain/types.js";

export class JsonlRaceEventStore implements RaceEventStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    if (!filePath) throw new Error("Event store file path is required");
  }

  append(event: RaceEvent): Promise<void> {
    const write = this.tail.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    });
    this.tail = write.catch(() => undefined);
    return write;
  }

  async list(raceId: string): Promise<RaceEvent[]> {
    await this.tail;
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    return contents
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RaceEvent)
      .filter((event) => event.raceId === raceId);
  }
}
