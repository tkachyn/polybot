import { randomUUID } from "node:crypto";
import { SteelSessionManager, type SteelRacerSession } from "./steel-session-manager.js";

export type BrowserSessionStatus = "live" | "released";

export type BrowserSessionSnapshot = {
  sessionId: string;
  status: BrowserSessionStatus;
  viewerUrl: string | null;
  pageUrl: string | null;
  pageTitle: string | null;
  createdAt: number;
  updatedAt: number;
};

export interface SteelBrowserSessionService {
  create(url: string): Promise<BrowserSessionSnapshot>;
  get(sessionId: string): Promise<BrowserSessionSnapshot>;
  navigate(sessionId: string, url: string): Promise<BrowserSessionSnapshot>;
  release(sessionId: string): Promise<BrowserSessionSnapshot>;
  releaseAll(): Promise<void>;
}

type ActiveBrowserSession = {
  sessionId: string;
  racerId: string;
  steel: SteelRacerSession;
  url: string;
  createdAt: number;
  updatedAt: number;
};

export class DefaultSteelBrowserSessionService implements SteelBrowserSessionService {
  private manager?: SteelSessionManager;
  private readonly sessions = new Map<string, ActiveBrowserSession>();

  constructor(manager?: SteelSessionManager) {
    this.manager = manager;
  }

  async create(url: string): Promise<BrowserSessionSnapshot> {
    validateBrowserUrl(url);
    const sessionId = randomUUID();
    const racerId = `browser-session-${sessionId}`;
    const manager = this.getManager();
    const steel = await manager.create(racerId);
    try {
      await steel.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (error) {
      await manager.release(racerId).catch(() => undefined);
      throw error;
    }
    const now = Date.now();
    const active: ActiveBrowserSession = {
      sessionId,
      racerId,
      steel,
      url,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, active);
    return this.snapshot(active);
  }

  async get(sessionId: string): Promise<BrowserSessionSnapshot> {
    return this.snapshot(this.requireSession(sessionId));
  }

  async navigate(sessionId: string, url: string): Promise<BrowserSessionSnapshot> {
    validateBrowserUrl(url);
    const active = this.requireSession(sessionId);
    await active.steel.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    active.url = url;
    active.updatedAt = Date.now();
    return this.snapshot(active);
  }

  async release(sessionId: string): Promise<BrowserSessionSnapshot> {
    const active = this.requireSession(sessionId);
    await this.getManager().release(active.racerId);
    this.sessions.delete(sessionId);
    return {
      sessionId,
      status: "released",
      viewerUrl: null,
      pageUrl: active.url,
      pageTitle: null,
      createdAt: active.createdAt,
      updatedAt: Date.now(),
    };
  }

  async releaseAll(): Promise<void> {
    await this.getManagerIfCreated()?.releaseAll();
    this.sessions.clear();
  }

  private async snapshot(active: ActiveBrowserSession): Promise<BrowserSessionSnapshot> {
    let pageUrl: string | null = active.url;
    let pageTitle: string | null = null;
    try {
      pageUrl = active.steel.page.url();
      pageTitle = await active.steel.page.title();
    } catch {
      // The browser may close between a status request and the page read.
    }
    return {
      sessionId: active.sessionId,
      status: "live",
      viewerUrl: active.steel.viewerUrl ?? null,
      pageUrl,
      pageTitle,
      createdAt: active.createdAt,
      updatedAt: active.updatedAt,
    };
  }

  private requireSession(sessionId: string): ActiveBrowserSession {
    const active = this.sessions.get(sessionId);
    if (!active) throw new Error(`Browser session not found: ${sessionId}`);
    return active;
  }

  private getManager(): SteelSessionManager {
    this.manager ??= new SteelSessionManager();
    return this.manager;
  }

  private getManagerIfCreated(): SteelSessionManager | undefined {
    return this.manager;
  }
}

export function validateBrowserUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("browser URL must be a valid http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("browser URL must use http or https");
  }
}
