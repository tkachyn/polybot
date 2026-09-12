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

export type SteelSessionManagerOptions = {
  apiKey?: string;
  /** Keys tried in order; the next one is used once the current one runs out. */
  apiKeys?: string[];
  sessionTimeoutSeconds?: number;
};

/**
 * Owns one Playwright/CDP connection per Steel browser session.
 * A manager instance should be used by the race orchestrator, not exposed to
 * the frontend or to the competitor model.
 */
export class SteelSessionManager {
  private readonly keys: SteelKeyPool<Steel>;
  private readonly sessionTimeoutSeconds: number;
  private readonly active = new Map<string, SteelRacerSession>();
  // Sessions must be released with the client whose key created them.
  private readonly clients = new Map<string, Steel>();

  constructor(options: SteelSessionManagerOptions = {}) {
    const keys = [
      ...(options.apiKeys ?? []),
      ...(options.apiKey ? [options.apiKey] : []),
    ];
    this.keys = new SteelKeyPool({
      keys: keys.length > 0 ? keys : steelKeysFromEnv(),
      createClient: (apiKey) => new Steel({ steelAPIKey: apiKey }),
      onRotate: ({ fromKeyIndex, reason }) =>
        console.warn(
          `Steel API key #${fromKeyIndex + 1} unavailable (${reason}); rotating to the next key`,
        ),
    });
    this.sessionTimeoutSeconds = options.sessionTimeoutSeconds ?? 240;
  }

  async create(racerId: string): Promise<SteelRacerSession> {
    if (this.active.has(racerId)) {
      throw new Error(`Steel session already exists for ${racerId}`);
    }

    const { result: session, lease } = await this.keys.run(({ client }) =>
      client.sessions.create({
        timeout: this.sessionTimeoutSeconds * 1000,
      }),
    );
    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(
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
      viewerUrl: session.sessionViewerUrl,
    };

    this.active.set(racerId, racerSession);
    this.clients.set(racerId, lease.client);
    return racerSession;
  }

  get(racerId: string): SteelRacerSession {
    const session = this.active.get(racerId);
    if (!session) {
      throw new Error(`No active Steel session for ${racerId}`);
    }
    return session;
  }

  async release(racerId: string): Promise<void> {
    const session = this.active.get(racerId);
    const client = this.clients.get(racerId);
    if (!session || !client) return;

    this.active.delete(racerId);
    this.clients.delete(racerId);
    await session.browser.close().catch(() => undefined);
    await client.sessions.release(session.steelSessionId);
  }

  async releaseAll(): Promise<void> {
    await Promise.all(
      [...this.active.keys()].map((racerId) => this.release(racerId)),
    );
  }
}
