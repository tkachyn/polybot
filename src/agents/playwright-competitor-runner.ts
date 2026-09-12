import type { Page } from "playwright";
import type {
  CompetitorAgentRunner,
  CompetitorContext,
} from "../application/contracts.js";
import { describeDecision } from "./competitor-decision.js";

export type BrowserObservation = {
  url: string;
  title: string;
  bodyText: string;
  controls: Array<{
    tag: string;
    role: string | null;
    arenaRole: string | null;
    text: string;
    disabled: boolean;
  }>;
};

export type AgentDecision =
  | { type: "inspect" }
  | { type: "click"; targetRole: string }
  | { type: "type"; targetRole: string; text: string }
  | { type: "navigate"; url: string }
  | { type: "wait"; durationMs: number }
  | { type: "checkpoint"; checkpoint: number }
  | { type: "finish" };

export interface CompetitorDecisionModel {
  decide(input: {
    task: string;
    racerId: string;
    observation: BrowserObservation;
    history: Array<{ decision: AgentDecision; error?: string }>;
  }): Promise<AgentDecision>;
}

/** Alias of `parseDecision`, the one shared competitor decision parser. */
export { parseDecision as parseAgentDecision } from "./competitor-decision.js";

export type PlaywrightCompetitorRunnerOptions = {
  task: string;
  startUrl: string;
  /** One model for every racer. Provide this or `modelForRacer`. */
  model?: CompetitorDecisionModel;
  /** Per-racer model. Wins over `model`. */
  modelForRacer?: (racerId: string) => CompetitorDecisionModel;
  maxActions?: number;
  /** Periodic capture interval while running. Default 1500 ms. */
  frameIntervalMs?: number;
  /** JPEG quality, 0-100. Default 55. */
  frameQuality?: number;
};

export const DEFAULT_FRAME_INTERVAL_MS = 1_500;
export const DEFAULT_FRAME_QUALITY = 55;

type FrameCapture = {
  timer?: ReturnType<typeof setInterval>;
  inFlight: boolean;
  stopped: boolean;
};

export class PlaywrightCompetitorRunner implements CompetitorAgentRunner {
  private readonly prepared = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly captures = new Map<string, FrameCapture>();
  private readonly maxActions: number;

  constructor(private readonly options: PlaywrightCompetitorRunnerOptions) {
    this.maxActions = options.maxActions ?? 60;
    if (!options.task) throw new Error("Competitor task is required");
    if (!options.startUrl) throw new Error("Competitor start URL is required");
    if (!options.model && !options.modelForRacer) {
      throw new Error("A competitor model or model resolver is required");
    }
  }

  async prepare(
    context: Omit<CompetitorContext, "reportCheckpoint" | "reportFinish">,
  ): Promise<void> {
    const page = this.pageFor(context);
    const url = new URL(this.options.startUrl);
    url.searchParams.set("raceId", context.raceId);
    url.searchParams.set("racerId", context.racerId);
    url.searchParams.set("seed", context.seed);
    url.searchParams.set("courseId", context.courseId);
    url.searchParams.set("checkpointCount", String(context.checkpointCount));
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    this.prepared.add(context.racerId);
  }

  async run(context: CompetitorContext): Promise<void> {
    if (!this.prepared.has(context.racerId)) {
      throw new Error(`${context.racerId} must be prepared before running`);
    }
    const page = this.pageFor(context);
    const model = this.modelFor(context.racerId);
    const controller = new AbortController();
    this.controllers.set(context.racerId, controller);
    const capture = this.startFrames(page, context);
    const history: Array<{ decision: AgentDecision; error?: string }> = [];

    try {
      for (let action = 0; action < this.maxActions; action += 1) {
        if (controller.signal.aborted) return;
        const observation = await this.observe(page);
        const decision = await model.decide({
          task: this.options.task,
          racerId: context.racerId,
          observation,
          history: history.slice(-10),
        });
        if (controller.signal.aborted) return;
        const step = action + 1;

        try {
          const finished = await this.execute(page, context, decision);
          history.push({ decision });
          this.report(context, page, decision, step);
          if (finished) return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          history.push({ decision, error: message });
          this.report(context, page, decision, step, message);
        }
        await this.captureFrame(page, context, capture);
      }
      throw new Error(`${context.racerId} exceeded ${this.maxActions} actions`);
    } finally {
      this.stopFrames(context.racerId);
      this.controllers.delete(context.racerId);
    }
  }

  async stop(racerId: string): Promise<void> {
    this.stopFrames(racerId);
    this.controllers.get(racerId)?.abort();
  }

  private modelFor(racerId: string): CompetitorDecisionModel {
    const model = this.options.modelForRacer?.(racerId) ?? this.options.model;
    if (!model) throw new Error(`No competitor model is configured for ${racerId}`);
    return model;
  }

  private report(
    context: CompetitorContext,
    page: Page,
    decision: AgentDecision,
    step: number,
    error?: string,
  ): void {
    if (!context.reportAction) return;
    let url: string | undefined;
    try {
      url = page.url();
    } catch {
      url = undefined;
    }
    try {
      context.reportAction({
        kind: error === undefined ? "action" : "error",
        text: describeDecision(decision),
        url,
        step,
        maxSteps: this.maxActions,
        signature: JSON.stringify(decision),
        ...(error === undefined ? {} : { error }),
      });
    } catch {
      // Telemetry must never break the competitor loop.
    }
  }

  private startFrames(page: Page, context: CompetitorContext): FrameCapture {
    this.stopFrames(context.racerId);
    const capture: FrameCapture = { inFlight: false, stopped: false };
    this.captures.set(context.racerId, capture);
    if (context.reportFrame) {
      const timer = setInterval(() => {
        void this.captureFrame(page, context, capture);
      }, this.options.frameIntervalMs ?? DEFAULT_FRAME_INTERVAL_MS);
      timer.unref?.();
      capture.timer = timer;
    }
    return capture;
  }

  private stopFrames(racerId: string): void {
    const capture = this.captures.get(racerId);
    if (!capture) return;
    capture.stopped = true;
    if (capture.timer) clearInterval(capture.timer);
    this.captures.delete(racerId);
  }

  /** One viewport JPEG. Skipped while another capture is in flight. */
  private async captureFrame(
    page: Page,
    context: CompetitorContext,
    capture: FrameCapture,
  ): Promise<void> {
    if (!context.reportFrame || capture.inFlight || capture.stopped) return;
    capture.inFlight = true;
    try {
      const body = await page.screenshot({
        type: "jpeg",
        quality: this.options.frameQuality ?? DEFAULT_FRAME_QUALITY,
        fullPage: false,
      });
      if (!capture.stopped) {
        context.reportFrame({ contentType: "image/jpeg", body, capturedAt: Date.now() });
      }
    } catch {
      // A failed capture only costs one frame.
    } finally {
      capture.inFlight = false;
    }
  }

  private async observe(page: Page): Promise<BrowserObservation> {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const controls = await page
      .locator("a, button, input, select, textarea, [role]")
      .evaluateAll((elements) =>
        elements.slice(0, 100).map((element) => {
          const html = element as HTMLElement;
          const control = element as HTMLInputElement;
          return {
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute("role"),
            arenaRole: element.getAttribute("data-arena-role"),
            text: (html.innerText || control.value || element.getAttribute("aria-label") || "")
              .trim()
              .slice(0, 300),
            disabled: "disabled" in control ? Boolean(control.disabled) : false,
          };
        }),
      )
      .catch(() => []);
    return {
      url: page.url(),
      title: await page.title(),
      bodyText: bodyText.slice(0, 8_000),
      controls,
    };
  }

  private async execute(
    page: Page,
    context: CompetitorContext,
    decision: AgentDecision,
  ): Promise<boolean> {
    switch (decision.type) {
      case "inspect":
        return false;
      case "click":
        await page.locator(this.roleSelector(decision.targetRole)).first().click();
        return false;
      case "type":
        if (decision.text.length > 2_000) throw new Error("Text input is too long");
        await page.locator(this.roleSelector(decision.targetRole)).first().fill(decision.text);
        return false;
      case "navigate": {
        const target = new URL(decision.url, this.options.startUrl);
        if (target.origin !== new URL(this.options.startUrl).origin) {
          throw new Error("Cross-origin navigation is not allowed");
        }
        await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
        return false;
      }
      case "wait":
        await page.waitForTimeout(Math.max(0, Math.min(decision.durationMs, 2_000)));
        return false;
      case "checkpoint":
        await context.reportCheckpoint(decision.checkpoint);
        return false;
      case "finish":
        await context.reportFinish();
        return true;
    }
  }

  private pageFor(
    context: Omit<CompetitorContext, "reportCheckpoint" | "reportFinish">,
  ): Page {
    if (!context.session.page) {
      throw new Error(`No Playwright page is available for ${context.racerId}`);
    }
    return context.session.page;
  }

  private roleSelector(targetRole: string): string {
    if (!targetRole || targetRole.length > 100) {
      throw new Error("targetRole must be between 1 and 100 characters");
    }
    const escaped = targetRole.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return `[data-arena-role="${escaped}"]`;
  }
}
