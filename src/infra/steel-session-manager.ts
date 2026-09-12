import { chromium, type Browser, type Page } from "playwright";
import Steel from "steel-sdk";

export type SteelRacerSession = {
  racerId: string;
  steelSessionId: string;
  browser: Browser;
  page: Page;
  viewerUrl?: string;
};

export type SteelSessionManagerOptions = {
  apiKey?: string;
  sessionTimeoutSeconds?: number;
};

/**
 * Owns one Playwright/CDP connection per Steel browser session.
 * A manager instance should be used by the race orchestrator, not exposed to
 * the frontend or to the competitor model.
 */
export class SteelSessionManager {
  private readonly client: Steel;
  private readonly apiKey: string;
  private readonly sessionTimeoutSeconds: number;
  private readonly active = new Map<string, SteelRacerSession>();

  constructor(options: SteelSessionManagerOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.STEEL_API_KEY ?? "";
    if (!this.apiKey) {
      throw new Error("STEEL_API_KEY is required to create Steel sessions");
    }
    this.sessionTimeoutSeconds = options.sessionTimeoutSeconds ?? 240;
    this.client = new Steel({ steelAPIKey: this.apiKey });
  }

  async create(racerId: string): Promise<SteelRacerSession> {
    if (this.active.has(racerId)) {
      throw new Error(`Steel session already exists for ${racerId}`);
    }

    const session = await this.client.sessions.create({
      timeout: this.sessionTimeoutSeconds * 1000,
    });
    const browser = await chromium.connectOverCDP(
      `${session.websocketUrl}&apiKey=${this.apiKey}`,
    );
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
    if (!session) return;

    this.active.delete(racerId);
    await session.browser.close().catch(() => undefined);
    await this.client.sessions.release(session.steelSessionId);
  }

  async releaseAll(): Promise<void> {
    await Promise.all(
      [...this.active.keys()].map((racerId) => this.release(racerId)),
    );
  }
}
