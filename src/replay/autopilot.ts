/**
 * Keeps recorded fights cycling on the server, around the clock.
 *
 * It holds a few replays live at once and a few more queued as upcoming,
 * staggered so they do not all start together, and tops the lobby up as each
 * one resolves. Every replay is a new fight with its own market, so two
 * viewers of the same recording trade independent books.
 *
 * Resolved fights are capped: a perpetual loop would otherwise hold every
 * fight it has ever played in memory.
 */
import type { ApiCreateRaceInput, RaceRegistry } from "../api/race-registry.js";
import type { DatasetStore } from "../dataset/store.js";
import { replayCourseId } from "./course-id.js";
import { ReplayLibrary, type ReplayLibraryOptions, type ReplayRecording } from "./library.js";

/** Resolved replays kept in the lobby; older ones stay in their stored reports. */
export const MAX_RESOLVED_REPLAYS = 60;
/** How often the cycle checks whether it needs to top up. */
const TICK_MS = 5_000;
/** Gap between queued starts, so upcoming fights open one after another. */
const MIN_STAGGER_MS = 45_000;
const MAX_STAGGER_MS = 120_000;
/** A queued fight this close to starting already counts towards the live target. */
const SOON_MS = 15_000;

export type ReplayAutopilotOptions = ReplayLibraryOptions & {
  store: DatasetStore;
  /**
   * The library the coordinator factory reads from. Pass the same instance, or
   * the factory looks up recordings this never loaded. Omit to own one.
   */
  library?: ReplayLibrary;
  /** Replays running at once. Default 3. */
  liveFights?: number;
  /** Replays queued as upcoming. Default 2. */
  upcomingFights?: number;
  /** 1 is the original pace. Default 1. */
  timeScale?: number;
  /** Injected in tests. */
  now?: () => number;
};

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export class ReplayAutopilot {
  private readonly library: ReplayLibrary;
  private readonly liveTarget: number;
  private readonly upcomingTarget: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refilling = false;
  private stopped = false;
  private sequence = 0;

  constructor(
    private readonly registry: RaceRegistry,
    private readonly options: ReplayAutopilotOptions,
  ) {
    this.library = options.library ?? new ReplayLibrary(options.store, options);
    this.liveTarget = Math.max(1, Math.floor(options.liveFights ?? 3));
    this.upcomingTarget = Math.max(0, Math.floor(options.upcomingFights ?? 2));
    this.now = options.now ?? (() => Date.now());
  }

  /** Loads the library and starts cycling. Returns how many recordings it found. */
  async start(): Promise<number> {
    const found = await this.library.load(this.now());
    if (found === 0) return 0;
    await this.refill();
    this.timer = setInterval(() => void this.refill(), TICK_MS);
    this.timer.unref?.();
    return found;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get size(): number {
    return this.library.size;
  }

  /** Tops the lobby back up to the live and upcoming targets. */
  private async refill(): Promise<void> {
    if (this.refilling || this.stopped) return;
    this.refilling = true;
    try {
      const now = this.now();
      let live = 0;
      const scheduled: number[] = [];
      for (const race of this.registry.list()) {
        const status = race.engine.race.status;
        if (status === "finished" || status === "timed_out") continue;
        const startsAt = this.registry.scheduledStart(race.raceId);
        if (startsAt === null) live += 1;
        else scheduled.push(startsAt);
      }

      const startingSoon = scheduled.filter((startsAt) => startsAt <= now + SOON_MS).length;
      const immediate = Math.max(0, this.liveTarget - live - startingSoon);
      for (let index = 0; index < immediate && !this.stopped; index += 1) {
        await this.createReplay(now, undefined);
      }

      let latest = Math.max(now, ...scheduled);
      for (let count = scheduled.length; count < this.upcomingTarget && !this.stopped; count += 1) {
        latest += MIN_STAGGER_MS + Math.random() * (MAX_STAGGER_MS - MIN_STAGGER_MS);
        await this.createReplay(now, Math.round(latest));
      }

      this.registry.prune(MAX_RESOLVED_REPLAYS);
    } finally {
      this.refilling = false;
    }
  }

  private async createReplay(now: number, startsAt: number | undefined): Promise<void> {
    const recording = this.library.next();
    if (!recording) return;
    try {
      await this.registry.create(this.inputFor(recording, startsAt), now);
    } catch {
      // A rejected or failed start is voided by the coordinator; the next
      // tick tries again with another recording.
    }
  }

  /** The recorded fight as a new one: same task and roster, fresh market. */
  private inputFor(recording: ReplayRecording, startsAt: number | undefined): ApiCreateRaceInput {
    this.sequence += 1;
    const suffix = `${Date.now().toString(36)}-${this.sequence.toString(36)}`;
    const { task, evaluation } = recording;
    const sabotage = evaluation.sabotageSteps[0];
    return {
      raceId: `replay-${suffix}`,
      courseId: replayCourseId(recording.raceId),
      seed: task.seed,
      checkpointCount: task.checkpointCount,
      task: task.text,
      startUrl: recording.agents[0]?.steps[0]?.url ?? "https://example.com",
      title: clamp(recording.title, 90),
      checkpointLabels: task.checkpointLabels,
      agents: evaluation.agents.map((agent) => ({ ...agent.agent })),
      obstaclesEnabled: sabotage !== undefined,
      ...(sabotage
        ? {
            sabotage: {
              checkpoint: Math.min(Math.max(1, sabotage.checkpoint), task.checkpointCount),
              summary: clamp(sabotage.label, 70),
            },
          }
        : {}),
      ...(startsAt === undefined ? {} : { startsAt }),
    };
  }
}

/** Starts the cycle; the returned function stops it. */
export async function startReplayAutopilot(
  registry: RaceRegistry,
  options: ReplayAutopilotOptions,
): Promise<() => void> {
  const autopilot = new ReplayAutopilot(registry, options);
  await autopilot.start();
  return () => autopilot.stop();
}
