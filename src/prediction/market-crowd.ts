/**
 * The crowd: automated traders that keep a live market moving.
 *
 * Without them a live fight only reprices when a checkpoint lands, so the
 * chart is a flat line with a step in it and volume never moves. That is not
 * how a market looks, and it is not how one behaves.
 *
 * These traders are deliberately imperfect, because a crowd of perfect
 * forecasters would converge instantly and then sit still:
 *
 *   - they read the race late (`reactionMs`), so a checkpoint is mispriced for
 *     a moment before the crowd catches up;
 *   - they read it badly (`skill`), mixing the real signal with their own noise;
 *   - they hold priors about who is good (`BRAND_PRIOR`), so a well-regarded
 *     model keeps support even while it is losing;
 *   - some of them trade against their own read (`contrarian`);
 *   - they act on their own clocks (`cadenceMs`), not in lockstep.
 *
 * Every order goes through the real market, so prices, volume and the shared
 * ledger move exactly as they would for a human trader. Bots are flagged
 * `automated`, which keeps them out of judge standings.
 */
import type { RaceRegistry } from "../api/race-registry.js";
import type { RaceCoordinator } from "../application/race-coordinator.js";
import { Rng } from "../simulation/rng.js";

export const CROWD_SIZE = 14;
export const CROWD_FUNDING = 5_000;
const TOP_UP_BELOW = 400;

/**
 * Standing credibility per model vendor, independent of how the current fight
 * is going. A trader's read is multiplied by this, so a favoured model keeps a
 * floor of support on a bad run and a cheap one has to earn its price.
 */
export const BRAND_PRIOR: Readonly<Record<string, number>> = {
  claude: 1.4,
  gpt: 1.3,
  gemini: 1.1,
  grok: 0.95,
  deepseek: 0.85,
  qwen: 0.8,
  mistral: 0.8,
  meta: 0.8,
};

/**
 * Order sizes are tuned for a market depth of 250 shares. A deeper market
 * needs proportionally bigger orders to move its price as visibly.
 */
export function crowdLot(depth: number): number {
  return Math.max(1, Math.round(depth / 250));
}

/** Vendors outside the table get no lift and no penalty. */
export function brandPrior(agentKey: string | undefined): number {
  if (!agentKey) return 1;
  return BRAND_PRIOR[agentKey.toLowerCase()] ?? 1;
}

export type CrowdTrader = {
  userId: string;
  /** 0..1. How much of their read is the real race and how much is noise. */
  skill: number;
  /** How far behind the race they are, in ms. */
  reactionMs: number;
  /** Their own clock: ms between attempts to trade. */
  cadenceMs: number;
  /** Next time this trader is due, as a timestamp. */
  dueAt: number;
  /** Typical order size in shares. */
  size: number;
  /** Chance of trading against their own read. */
  contrarian: number;
  /** Personal lean per agent key, on top of the shared prior. */
  lean: Record<string, number>;
};

/** One sample of the race, kept so traders can read it late. */
type Snapshot = {
  at: number;
  checkpoints: Record<string, number>;
  weak: Record<string, boolean>;
};

export type MarketCrowdOptions = {
  seed?: string;
  size?: number;
  /** How often the crowd wakes up. Traders still act on their own cadence. */
  tickMs?: number;
};

export class MarketCrowd {
  readonly traders: CrowdTrader[] = [];
  private readonly rng: Rng;
  private readonly size: number;
  private readonly tickMs: number;
  private readonly history = new Map<string, Snapshot[]>();
  private readonly keysByRace = new Map<string, Record<string, string>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly registry: RaceRegistry,
    options: MarketCrowdOptions = {},
  ) {
    this.rng = new Rng(options.seed ?? `crowd-${Date.now().toString(36)}`);
    this.size = options.size ?? CROWD_SIZE;
    this.tickMs = options.tickMs ?? 900;
  }

  /**
   * Registers and funds the traders without starting the loop, so a caller
   * (or a test) can drive `tick` on its own clock.
   */
  prepare(now = Date.now()): void {
    this.createTraders(now);
  }

  /** Creates the traders and starts the loop. Returns a stop function. */
  start(now = Date.now()): () => void {
    this.prepare(now);
    const loop = () => {
      if (this.stopped) return;
      try {
        this.tick(Date.now());
      } catch {
        // One bad round must never take the loop down.
      }
      this.timer = setTimeout(loop, this.tickMs);
      this.timer.unref?.();
    };
    this.timer = setTimeout(loop, this.tickMs);
    this.timer.unref?.();
    return () => this.stop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private createTraders(now: number): void {
    while (this.traders.length < this.size) {
      const userId = `bot-${this.rng.hex(6)}`;
      if (this.traders.some((trader) => trader.userId === userId)) continue;
      const trader: CrowdTrader = {
        userId,
        // A wide spread: some traders are nearly noise, a few are sharp.
        skill: this.rng.range(0.15, 0.9),
        reactionMs: this.rng.range(400, 9_000),
        cadenceMs: this.rng.range(1_200, 7_000),
        dueAt: now + this.rng.range(0, 4_000),
        size: this.rng.int(1, 9),
        contrarian: this.rng.range(0.05, 0.35),
        lean: {},
      };
      this.traders.push(trader);
      this.registry.users.ensure(
        { userId, displayName: `Bot ${userId.slice(-4).toUpperCase()}` },
        now,
        { automated: true },
      );
      this.fundTo(userId, now);
    }
  }

  private fundTo(userId: string, at: number): void {
    const balance = this.registry.ledger.balance(userId);
    if (balance < CROWD_FUNDING) {
      this.registry.ledger.credit(userId, CROWD_FUNDING - balance, { type: "deposit", method: "virtual", at });
    }
  }

  /** One round: sample every open race, then let due traders act. */
  tick(now: number): void {
    const open = this.registry.list().filter((race) => race.market.status === "open");
    if (open.length === 0) return;

    for (const race of open) this.sample(race, now);

    for (const trader of this.traders) {
      if (trader.dueAt > now) continue;
      trader.dueAt = now + trader.cadenceMs * this.rng.range(0.6, 1.5);
      const race = open.length === 1 ? open[0] : this.rng.pick(open);
      if (this.registry.ledger.balance(trader.userId) < TOP_UP_BELOW) this.fundTo(trader.userId, now);
      this.trade(race, trader, now);
    }
  }

  /** Records the current race state, and drops samples nobody can still see. */
  private sample(race: RaceCoordinator, now: number): void {
    const checkpoints: Record<string, number> = {};
    const weak: Record<string, boolean> = {};
    for (const [racerId, racer] of race.engine.racers) {
      checkpoints[racerId] = racer.checkpoint;
      weak[racerId] = racer.status === "failed" || racer.status === "timed_out" || racer.status === "recovering";
    }
    const samples = this.history.get(race.raceId) ?? [];
    samples.push({ at: now, checkpoints, weak });
    const oldest = now - 15_000;
    while (samples.length > 2 && samples[0].at < oldest) samples.shift();
    this.history.set(race.raceId, samples);
  }

  /** The race as this trader sees it: as it was `reactionMs` ago. */
  private viewFor(race: RaceCoordinator, trader: CrowdTrader, now: number): Snapshot | null {
    const samples = this.history.get(race.raceId);
    if (!samples || samples.length === 0) return null;
    const at = now - trader.reactionMs;
    let seen = samples[0];
    for (const sample of samples) {
      if (sample.at > at) break;
      seen = sample;
    }
    return seen;
  }

  /**
   * One order. Rejections (closed market, price moved, no funds) are expected
   * and swallowed: a trader that cannot act simply does not.
   */
  private trade(race: RaceCoordinator, trader: CrowdTrader, now: number): void {
    if (race.market.status !== "open") return;
    const view = this.viewFor(race, trader, now);
    if (!view) return;

    const market = race.market;
    const prices = market.pricesSnapshot();
    const agentKeys = this.agentKeys(race);

    // Take profit sometimes, so positions turn over instead of only stacking.
    const positions = market.positionsFor(trader.userId);
    if (positions.length > 0 && this.rng.chance(0.2)) {
      const position = this.rng.pick(positions);
      try {
        race.placeOrder(
          {
            userId: trader.userId,
            racerId: position.racerId,
            side: position.side,
            action: "sell",
            quantity: this.rng.int(1, position.quantity),
          },
          now,
        );
      } catch {
        // Expected: the market may have closed between the check and the order.
      }
      return;
    }

    const value = (racerId: string): number => {
      // The real signal, as this trader saw it: progress, less any trouble.
      const checkpoint = view.checkpoints[racerId] ?? 0;
      const signal = (0.1 + checkpoint) * (view.weak[racerId] ? 0.35 : 1);
      // Their own noise, which a low-skill trader mostly trades on.
      const noise = this.rng.range(0.05, 1.6);
      const read = signal * trader.skill + noise * (1 - trader.skill);
      const key = agentKeys[racerId];
      const lean = trader.lean[key] ?? (trader.lean[key] = this.rng.range(0.75, 1.3));
      return Math.max(0.02, read * brandPrior(key) * lean);
    };

    const racerId = this.rng.weighted(market.racerIds, value);
    const price = prices[racerId] ?? 0.25;

    // Contrarians fade their own read; everyone else backs it, unless the
    // price already leaves nothing to win.
    let side: "yes" | "no" = this.rng.chance(trader.contrarian) ? "no" : "yes";
    if (price > 0.9) side = "no";
    else if (price < 0.04) side = "yes";

    try {
      race.placeOrder(
        {
          userId: trader.userId,
          racerId,
          side,
          action: "buy",
          quantity: Math.max(1, Math.round(trader.size * this.rng.range(0.4, 1.8))) * crowdLot(market.depth),
        },
        now,
      );
    } catch {
      // Expected: insufficient funds, a closed market, or a moved price.
    }
  }

  /** racerId → agent identity key, for the brand priors. Cached per race. */
  private agentKeys(race: RaceCoordinator): Record<string, string> {
    const cached = this.keysByRace.get(race.raceId);
    if (cached) return cached;
    const agents = race.fight.agents ?? [];
    const keys: Record<string, string> = {};
    race.market.racerIds.forEach((racerId, index) => {
      keys[racerId] = agents[index]?.key ?? racerId;
    });
    this.keysByRace.set(race.raceId, keys);
    return keys;
  }
}

/** Starts a crowd on every open market in the registry. */
export function startMarketCrowd(registry: RaceRegistry, options: MarketCrowdOptions = {}): () => void {
  return new MarketCrowd(registry, options).start();
}
