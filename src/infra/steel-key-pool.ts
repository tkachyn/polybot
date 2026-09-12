/**
 * Rotates through several Steel API keys. Calls go to the current key; when
 * Steel rejects it for auth, billing, or rate-limit reasons the key is benched
 * and the call is retried on the next available key.
 */

export type SteelKeyPoolOptions<TClient> = {
  keys: string[];
  createClient: (apiKey: string) => TClient;
  /** How long a rate-limited (429) key sits out before it is tried again. */
  rateLimitCooldownMs?: number;
  now?: () => number;
  onRotate?: (event: { fromKeyIndex: number; reason: string }) => void;
};

export type SteelKeyLease<TClient> = {
  apiKey: string;
  client: TClient;
};

const EXHAUSTION_MESSAGE =
  /credit|quota|exceed|insufficient|payment|billing|usage limit|plan limit|out of/i;

/** Parses `STEEL_API_KEYS` (comma/whitespace separated) plus `STEEL_API_KEY`. */
export function steelKeysFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys = [env.STEEL_API_KEYS ?? "", env.STEEL_API_KEY ?? ""]
    .flatMap((value) => value.split(/[\s,]+/))
    .map((key) => key.trim())
    .filter(Boolean);
  return [...new Set(keys)];
}

/**
 * Returns a bench duration in ms when the error means the key is unusable,
 * `Infinity` for permanent exhaustion, or `undefined` for unrelated errors.
 */
export function steelKeyFailure(
  error: unknown,
  rateLimitCooldownMs: number,
): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 429) return rateLimitCooldownMs;
  if (status === 401 || status === 402 || status === 403) return Infinity;
  if (EXHAUSTION_MESSAGE.test(message)) return Infinity;
  return undefined;
}

export class SteelKeyPool<TClient> {
  private readonly entries: { apiKey: string; client: TClient; benchedUntil: number }[];
  private readonly rateLimitCooldownMs: number;
  private readonly now: () => number;
  private readonly onRotate?: SteelKeyPoolOptions<TClient>["onRotate"];
  private cursor = 0;

  constructor(options: SteelKeyPoolOptions<TClient>) {
    const keys = [...new Set(options.keys.map((key) => key.trim()).filter(Boolean))];
    if (keys.length === 0) {
      throw new Error("At least one Steel API key is required (STEEL_API_KEYS or STEEL_API_KEY)");
    }
    this.entries = keys.map((apiKey) => ({
      apiKey,
      client: options.createClient(apiKey),
      benchedUntil: 0,
    }));
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.onRotate = options.onRotate;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Runs `fn` with the current key, rotating to the next key on exhaustion. */
  async run<T>(
    fn: (lease: SteelKeyLease<TClient>) => Promise<T>,
  ): Promise<{ result: T; lease: SteelKeyLease<TClient> }> {
    const tried = new Set<number>();
    let lastError: unknown;

    for (;;) {
      const index = this.pick(tried);
      if (index === undefined) break;
      tried.add(index);

      const entry = this.entries[index];
      const lease = { apiKey: entry.apiKey, client: entry.client };
      try {
        return { result: await fn(lease), lease };
      } catch (error) {
        const benchMs = steelKeyFailure(error, this.rateLimitCooldownMs);
        if (benchMs === undefined) throw error;
        lastError = error;
        this.bench(index, benchMs, error);
      }
    }

    const reason = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new Error(`All ${this.entries.length} Steel API keys are exhausted${reason}`, {
      cause: lastError,
    });
  }

  private pick(tried: Set<number>): number | undefined {
    const now = this.now();
    for (let offset = 0; offset < this.entries.length; offset += 1) {
      const index = (this.cursor + offset) % this.entries.length;
      if (!tried.has(index) && this.entries[index].benchedUntil <= now) {
        return index;
      }
    }
    return undefined;
  }

  private bench(index: number, benchMs: number, error: unknown): void {
    const entry = this.entries[index];
    entry.benchedUntil = Math.max(entry.benchedUntil, this.now() + benchMs);
    // Concurrent calls may fail on the same key; only the first one moves the cursor.
    if (this.cursor === index) {
      this.cursor = (index + 1) % this.entries.length;
      this.onRotate?.({
        fromKeyIndex: index,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
