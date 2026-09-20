/**
 * The pool of recorded fights a replay cycle draws from.
 *
 * Every resolved live fight leaves a dataset record behind (src/dataset), and
 * a record holds everything a replay needs: each racer's steps with their
 * timings, the screenshots taken with them, and the engine events that say
 * when progress was verified. This picks the records that can be replayed in
 * full and hands them out in a shuffled cycle, so a 24/7 loop does not play
 * the library in the same order every time round.
 */
import type { DatasetStore } from "../dataset/store.js";
import type { FightDatasetRecord } from "../dataset/types.js";

/** A record that can be replayed: it has a winner and steps to replay. */
export type ReplayRecording = FightDatasetRecord & {
  evaluation: FightDatasetRecord["evaluation"] & { winnerRacerId: string };
};

export type ReplayLibraryOptions = {
  /** Only consider fights resolved within this many days. Default 365. */
  windowDays?: number;
  /** A fight needs at least this many steps across its agents. Default 8. */
  minSteps?: number;
  /** Shuffle seed; omit for a different order each process. */
  random?: () => number;
};

const DAY_MS = 86_400_000;

/**
 * Replayable means: a verified winner (a void fight has no result to settle
 * against), four agents, and enough steps to be worth watching.
 */
export function isReplayable(record: FightDatasetRecord, minSteps: number): record is ReplayRecording {
  const { evaluation } = record;
  if (!evaluation || evaluation.voided || !evaluation.winnerRacerId) return false;
  if (record.agents.length === 0) return false;
  const steps = record.agents.reduce((total, agent) => total + agent.steps.length, 0);
  return steps >= minSteps;
}

/** Fisher-Yates, so every cycle through the library is a fresh order. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class ReplayLibrary {
  private recordings: ReplayRecording[] = [];
  private order: ReplayRecording[] = [];
  private cursor = 0;
  private readonly windowDays: number;
  private readonly minSteps: number;
  private readonly random: () => number;

  constructor(private readonly store: DatasetStore, options: ReplayLibraryOptions = {}) {
    this.windowDays = Math.max(1, options.windowDays ?? 365);
    this.minSteps = Math.max(1, options.minSteps ?? 8);
    this.random = options.random ?? Math.random;
  }

  /** Reads the store and keeps the replayable records. Returns how many. */
  async load(now = Date.now()): Promise<number> {
    const records = await this.store.list({
      since: now - this.windowDays * DAY_MS,
      mode: "live",
    });
    this.recordings = records.filter((record) => isReplayable(record, this.minSteps));
    this.order = [];
    this.cursor = 0;
    return this.recordings.length;
  }

  get size(): number {
    return this.recordings.length;
  }

  /** Every replayable recording, in store order. */
  all(): readonly ReplayRecording[] {
    return this.recordings;
  }

  /** The recording behind a replay fight's course id, if it is still loaded. */
  find(sourceRaceId: string): ReplayRecording | null {
    return this.recordings.find((record) => record.raceId === sourceRaceId) ?? null;
  }

  /**
   * The next recording in the cycle. Reshuffles once the library is spent, so
   * the loop never repeats a fight until it has played all the others.
   */
  next(): ReplayRecording | null {
    if (this.recordings.length === 0) return null;
    if (this.cursor >= this.order.length) {
      this.order = shuffled(this.recordings, this.random);
      this.cursor = 0;
    }
    const recording = this.order[this.cursor];
    this.cursor += 1;
    return recording ?? null;
  }
}
