import type { Page } from "playwright";
import type {
  CompetitorAgentRunner,
  CompetitorContext,
} from "../application/contracts.js";

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

export function parseAgentDecision(value: unknown): AgentDecision {
  if (!value || typeof value !== "object" || !("type" in value)) {
    throw new Error("Invalid competitor decision");
  }
  const input = value as Record<string, unknown>;
  switch (input.type) {
    case "inspect":
    case "finish":
      return { type: input.type };
    case "click":
      if (typeof input.targetRole !== "string") throw new Error("click requires targetRole");
      return { type: "click", targetRole: input.targetRole };
    case "type":
      if (typeof input.targetRole !== "string" || typeof input.text !== "string") {
        throw new Error("type requires targetRole and text");
      }
      return { type: "type", targetRole: input.targetRole, text: input.text };
    case "navigate":
      if (typeof input.url !== "string") throw new Error("navigate requires url");
      return { type: "navigate", url: input.url };
    case "wait":
      if (typeof input.durationMs !== "number") throw new Error("wait requires durationMs");
      return { type: "wait", durationMs: input.durationMs };
    case "checkpoint":
      if (typeof input.checkpoint !== "number") throw new Error("checkpoint requires a number");
      return { type: "checkpoint", checkpoint: input.checkpoint };
    default:
      throw new Error(`Unsupported competitor decision: ${String(input.type)}`);
  }
}

export type PlaywrightCompetitorRunnerOptions = {
  task: string;
  startUrl: string;
  model?: CompetitorDecisionModel;
  modelForRacer?: (racerId: string) => CompetitorDecisionModel;
  maxActions?: number;
};

export class PlaywrightCompetitorRunner implements CompetitorAgentRunner {
  private readonly prepared = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
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
    const controller = new AbortController();
    this.controllers.set(context.racerId, controller);
    const history: Array<{ decision: AgentDecision; error?: string }> = [];

    try {
      for (let action = 0; action < this.maxActions; action += 1) {
        if (controller.signal.aborted) return;
        const observation = await this.observe(page);
        const decision = await this.modelFor(context.racerId).decide({
          task: this.options.task,
          racerId: context.racerId,
          observation,
          history: history.slice(-10),
        });

        try {
          const finished = await this.execute(page, context, decision);
          history.push({ decision });
          if (finished) return;
        } catch (error) {
          history.push({
            decision,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      throw new Error(`${context.racerId} exceeded ${this.maxActions} actions`);
    } finally {
      this.controllers.delete(context.racerId);
    }
  }

  private modelFor(racerId: string): CompetitorDecisionModel {
    const model = this.options.modelForRacer?.(racerId) ?? this.options.model;
    if (!model) throw new Error(`No competitor model configured for ${racerId}`);
    return model;
  }

  async stop(racerId: string): Promise<void> {
    this.controllers.get(racerId)?.abort();
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
