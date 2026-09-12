import { chromium, type Browser, type Page } from "playwright";
import Steel from "steel-sdk";
import { SteelKeyPool, steelKeysFromEnv } from "./steel-key-pool.js";

export type SteelRacerSession = {
  racerId: string;
  steelSessionId: string;
  browser: Browser;
  page: Page;
  viewerUrl?: string;
};

/** A racer's Steel session and the API key that created it. */
export type SteelSessionEvidence = {
  steelSessionId: string;
  apiKey: string;
};

export type SteelSessionManagerOptions = {
  apiKey?: string;
  /** Keys tried in order; the next one is used once the current one runs out. */
  apiKeys?: string[];
  sessionTimeoutSeconds?: number;
  /** Builds the Steel client for one key. Default: the steel-sdk client. */
  createClient?: (apiKey: string) => Steel;
  /** Connects Playwright to a session. Default: chromium.connectOverCDP. */
  connectOverCDP?: (endpointUrl: string) => Promise<Browser>;
};

/**
 * Owns one Playwright/CDP connection per Steel browser session.
 * A manager instance should be used by the race orchestrator, not exposed to
 * the frontend or to the competitor model.
 */
export class SteelSessionManager {
  private readonly keys: SteelKeyPool<Steel>;
  private readonly sessionTimeoutSeconds: number;
  private readonly connect: (endpointUrl: string) => Promise<Browser>;
  private readonly active = new Map<string, SteelRacerSession>();
  // Sessions must be released with the client whose key created them.
  private readonly clients = new Map<string, Steel>();
  // Traces and recordings must be read with that key too, after release.
  private readonly evidenceByRacer = new Map<string, SteelSessionEvidence>();

  constructor(options: SteelSessionManagerOptions = {}) {
    const keys = [
      ...(options.apiKeys ?? []),
      ...(options.apiKey ? [options.apiKey] : []),
    ];
    this.keys = new SteelKeyPool({
      keys: keys.length > 0 ? keys : steelKeysFromEnv(),
      createClient: options.createClient ?? ((apiKey) => new Steel({ steelAPIKey: apiKey })),
      onRotate: ({ fromKeyIndex, reason }) =>
        console.warn(
          `Steel API key #${fromKeyIndex + 1} unavailable (${reason}); rotating to the next key`,
        ),
    });
    this.sessionTimeoutSeconds = options.sessionTimeoutSeconds ?? 240;
    this.connect = options.connectOverCDP ?? ((endpointUrl) => chromium.connectOverCDP(endpointUrl));
  }

  async create(racerId: string): Promise<SteelRacerSession> {
    if (this.active.has(racerId)) {
      throw new Error(`Steel session already exists for ${racerId}`);
    }

    const { result: session, lease } = await this.keys.run(({ client }) =>
      client.sessions.create({
        timeout: this.sessionTimeoutSeconds * 1000,
        debugConfig: {
          interactive: false,
          systemCursor: false,
        },
      }),
    );
    let browser: Browser;
    try {
      browser = await this.connect(
        `${session.websocketUrl}&apiKey=${lease.apiKey}`,
      );
    } catch (error) {
      await lease.client.sessions.release(session.id).catch(() => undefined);
      throw error;
    }
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    const racerSession: SteelRacerSession = {
      racerId,
      steelSessionId: session.id,
      browser,
      page,
      viewerUrl: buildSteelViewerUrl(session.debugUrl ?? session.sessionViewerUrl),
    };

    this.active.set(racerId, racerSession);
    this.clients.set(racerId, lease.client);
    this.evidenceByRacer.set(racerId, { steelSessionId: session.id, apiKey: lease.apiKey });
    return racerSession;
  }

  get(racerId: string): SteelRacerSession {
    const session = this.active.get(racerId);
    if (!session) {
      throw new Error(`No active Steel session for ${racerId}`);
    }
    return session;
  }

  /**
   * The racer's latest Steel session id and the key that created it. Kept
   * after release, because Agent Traces and the HLS recording must be read
   * with that key. Never log or expose the key.
   */
  evidence(racerId: string): SteelSessionEvidence | null {
    const evidence = this.evidenceByRacer.get(racerId);
    return evidence ? { ...evidence } : null;
  }

  async release(racerId: string): Promise<void> {
    const session = this.active.get(racerId);
    const client = this.clients.get(racerId);
    if (!session || !client) return;

    await session.browser.close().catch(() => undefined);
    await client.sessions.release(session.steelSessionId);
    this.active.delete(racerId);
    this.clients.delete(racerId);
  }

  async releaseAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.active.keys()].map((racerId) => this.release(racerId)),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }
}

export function buildSteelViewerUrl(value: string): string {
  const url = new URL(value);
  url.searchParams.set("interactive", "false");
  url.searchParams.set("showControls", "false");
  return url.toString();
}
