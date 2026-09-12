import type { Locator, Page } from "playwright";
import type { BlockedBy } from "../api/dto.js";
import type {
  ActionEvidence,
  CompetitorAgentRunner,
  CompetitorContext,
} from "../application/contracts.js";
import { describeDecision, normalizeLabel } from "./competitor-decision.js";

export type BrowserObservation = {
  url: string;
  title: string;
  bodyText: string;
  controls: Array<{
    tag: string;
    role: string | null;
    arenaRole: string | null;
    text: string;
    /** Native `disabled`, or `aria-disabled="true"`. */
    disabled: boolean;
    /** Rendered with a non-empty box and not `visibility: hidden`. */
    visible: boolean;
  }>;
};

export type AgentDecision =
  | { type: "inspect" }
  /** `label` picks, by visible text, among controls that share `targetRole`. */
  | { type: "click"; targetRole: string; label?: string }
  | { type: "type"; targetRole: string; text: string; label?: string }
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
    signal?: AbortSignal;
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
  /**
   * Timeout for each click and fill. Default 5000 ms, so a blocked control
   * fails fast instead of waiting out Playwright's 30 s auto-wait.
   */
  actionTimeoutMs?: number;
};

export const DEFAULT_FRAME_INTERVAL_MS = 1_500;
export const DEFAULT_FRAME_QUALITY = 55;
export const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
/** Reading ground-truth evidence must never hold up the racer. */
const EVIDENCE_TIMEOUT_MS = 1_000;
/** Longest wait for a navigation started by an action before syncing progress. */
const SETTLE_TIMEOUT_MS = 3_000;
const EVIDENCE_TEXT_MAX = 120;

/** One executed decision, as the runner reports and remembers it. */
type StepOutcome = {
  finished: boolean;
  evidence: ActionEvidence;
  /** Page URL after the step, when known. */
  url?: string;
  /** Full error text, for telemetry only. */
  error?: string;
  /** The same failure as the model may see it: no call log, nothing hidden. */
  modelError?: string;
};

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
  private readonly actionTimeoutMs: number;

  constructor(private readonly options: PlaywrightCompetitorRunnerOptions) {
    this.maxActions = options.maxActions ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(this.maxActions) && this.maxActions !== Number.POSITIVE_INFINITY) {
      throw new Error("maxActions must be a positive number");
    }
    if (this.maxActions !== Number.POSITIVE_INFINITY &&
      (!Number.isInteger(this.maxActions) || this.maxActions <= 0)) {
      throw new Error("maxActions must be a positive integer");
    }
    this.actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    if (!Number.isFinite(this.actionTimeoutMs) || this.actionTimeoutMs <= 0) {
      throw new Error("actionTimeoutMs must be a positive number");
    }
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
    url.searchParams.set("steelSessionId", context.session.steelSessionId);
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
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const step = action + 1;

        const outcome = await this.attempt(page, context, decision);
        history.push(
          outcome.error === undefined
            ? { decision }
            : { decision, error: outcome.modelError ?? outcome.error },
        );
        this.report(context, decision, step, outcome);
        // Let a navigation the action started commit first, so a sabotage
        // fired by the resulting checkpoint lands on the new page instead of
        // one that is being torn down.
        await this.settle(page);
        // Progress comes from the course's ground truth after every action,
        // successful or not. Explicit checkpoint decisions remain a fallback.
        await this.syncProgress(context);
        if (outcome.finished) return;
        // A site adapter can prove completion after any action. Keep the
        // explicit finish tool as a fallback, but do not require the model
        // to notice a success page and emit a second decision.
        if (await this.verifiedFinish(context)) return;
        await this.captureFrame(page, context, capture);
      }
      if (this.maxActions !== Number.POSITIVE_INFINITY) {
        throw new Error(`${context.racerId} exceeded ${this.maxActions} actions`);
      }
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
    decision: AgentDecision,
    step: number,
    outcome: StepOutcome,
  ): void {
    if (!context.reportAction) return;
    try {
      context.reportAction({
        kind: outcome.error === undefined ? "action" : "error",
        text: describeDecision(decision),
        url: outcome.url,
        step,
        maxSteps: Number.isFinite(this.maxActions) ? this.maxActions : 0,
        signature: JSON.stringify(decision),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(Object.keys(outcome.evidence).length === 0 ? {} : { evidence: outcome.evidence }),
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
      // Hidden inputs carry form plumbing (run ids, counts), not controls a
      // user could act on, so they stay out of the model's view.
      .locator('a, button, input:not([type="hidden"]), select, textarea, [role]')
      .evaluateAll((elements) =>
        elements.slice(0, 100).map((element) => {
          const html = element as HTMLElement;
          const control = element as HTMLInputElement;
          const box = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute("role"),
            arenaRole: element.getAttribute("data-arena-role"),
            text: (html.innerText || control.value || element.getAttribute("aria-label") || "")
              .trim()
              .slice(0, 300),
            disabled: ("disabled" in control && Boolean(control.disabled)) ||
              element.getAttribute("aria-disabled") === "true",
            // What a user could see; a covered but rendered control is visible.
            visible: box.width > 0 && box.height > 0 &&
              window.getComputedStyle(element).visibility !== "hidden",
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
    evidence: ActionEvidence,
  ): Promise<boolean> {
    switch (decision.type) {
      case "inspect":
        return false;
      case "click": {
        const target = await this.resolveTarget(page, decision.targetRole, decision.label);
        const read = await readTarget(target);
        if (read) evidence.target = read;
        await target.click({ timeout: this.actionTimeoutMs });
        return false;
      }
      case "type": {
        if (decision.text.length > 2_000) throw new Error("Text input is too long");
        const target = await this.resolveTarget(page, decision.targetRole, decision.label);
        const read = await readTarget(target);
        if (read) evidence.target = read;
        await target.fill(decision.text, { timeout: this.actionTimeoutMs });
        return false;
      }
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

  /** Executes one decision and collects browser evidence around it. */
  private async attempt(
    page: Page,
    context: CompetitorContext,
    decision: AgentDecision,
  ): Promise<StepOutcome> {
    const evidence: ActionEvidence = {};
    const before = currentUrl(page);
    let finished = false;
    let failed = false;
    let failure: unknown;
    try {
      finished = await this.execute(page, context, decision, evidence);
    } catch (error) {
      failed = true;
      failure = error;
    }
    const url = currentUrl(page);
    if (before !== undefined && url !== undefined) evidence.navigated = url !== before;
    if (!failed) return { finished, evidence, url };
    const error = failure instanceof Error ? failure.message : String(failure);
    const blockedBy = classifyBlockedBy(failure);
    if (blockedBy) evidence.blockedBy = blockedBy;
    return {
      finished: false,
      evidence,
      url,
      error,
      modelError: modelFacingError(failure, error, blockedBy),
    };
  }

  /**
   * The first control with `targetRole`, narrowed by visible label (a
   * case-insensitive substring) when one is given. Fails fast when nothing
   * matches instead of waiting for a timeout.
   */
  private async resolveTarget(
    page: Page,
    targetRole: string,
    label: string | undefined,
  ): Promise<Locator> {
    const wanted = normalizeLabel(label);
    const all = page.locator(this.roleSelector(targetRole));
    const matches = wanted === undefined ? all : all.filter({ hasText: wanted });
    if (await matches.count() === 0) {
      throw new ActionBlockedError(
        "missing",
        wanted === undefined
          ? `No control has data-arena-role "${targetRole}"`
          : `No control with data-arena-role "${targetRole}" shows the label "${wanted}"`,
      );
    }
    return matches.first();
  }

  /** Waits (bounded) for the current document to be interactive. */
  private async settle(page: Page): Promise<void> {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: SETTLE_TIMEOUT_MS });
    } catch {
      // A slow or failed load is the next action's problem, not the sync's.
    }
  }

  private async syncProgress(context: CompetitorContext): Promise<void> {
    if (!context.syncProgress) return;
    try {
      await context.syncProgress();
    } catch {
      // Contractually never throws; a failed sync must not end the run.
    }
  }

  private async verifiedFinish(context: CompetitorContext): Promise<boolean> {
    if (!context.checkFinish) return false;
    try {
      return await context.checkFinish();
    } catch {
      return false;
    }
  }
}

/** A browser action that could not start, with its classification. */
export class ActionBlockedError extends Error {
  constructor(readonly blockedBy: BlockedBy, message: string) {
    super(message);
    this.name = "ActionBlockedError";
  }
}

// Playwright's call log is chronological, so the latest reason wins.
const BLOCKED_PATTERNS: ReadonlyArray<readonly [BlockedBy, RegExp]> = [
  ["modal", /intercepts pointer events/gi],
  ["disabled", /element is (?:not enabled|not editable|disabled)/gi],
  ["hidden", /element is not visible/gi],
];

/**
 * Classifies a failed action from the browser error: `modal` (another element
 * intercepts pointer events), `disabled`, `hidden`, `missing` (no element), or
 * `timeout` for any other Playwright TimeoutError. Undefined otherwise.
 */
export function classifyBlockedBy(error: unknown): BlockedBy | undefined {
  if (error instanceof ActionBlockedError) return error.blockedBy;
  const message = error instanceof Error ? error.message : String(error ?? "");
  let latest: { blockedBy: BlockedBy; index: number } | undefined;
  for (const [blockedBy, pattern] of BLOCKED_PATTERNS) {
    for (const match of message.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (!latest || index > latest.index) latest = { blockedBy, index };
    }
  }
  if (latest) return latest.blockedBy;
  if (!(error instanceof Error) || error.name !== "TimeoutError") return undefined;
  // The locator never resolved: the element disappeared before the action.
  if (message.includes("waiting for locator(") && !message.includes("locator resolved to")) {
    return "missing";
  }
  return "timeout";
}

const PERCEIVABLE_REASONS: Partial<Record<BlockedBy, string>> = {
  modal: "Another element is covering the control.",
  disabled: "The control is disabled.",
  hidden: "The control is not visible.",
  missing: "No matching control is on the page.",
};

/**
 * What the model may learn from a failure: the error's headline plus a reason
 * a user could perceive. Playwright's call log is dropped because it quotes
 * element markup, which can carry hidden attributes such as the decoy flag.
 */
function modelFacingError(
  failure: unknown,
  message: string,
  blockedBy: BlockedBy | undefined,
): string {
  if (failure instanceof ActionBlockedError) return message;
  const headline = (message.split("\n", 1)[0] ?? "")
    .replace(/\[[0-9;]*m/g, "")
    .replace(/<[^>]*\b(?:data-arena-decoy|data-arena-disruption-id|arena-decoy-)[^>]*>/g, "<element>")
    .replace(/\s*\bdata-arena-(?:decoy|disruption-id)(?:="[^"]*")?/g, "")
    .trim();
  const reason = blockedBy ? PERCEIVABLE_REASONS[blockedBy] : undefined;
  return reason ? `${headline} ${reason}`.trim() : headline;
}

function currentUrl(page: Page): string | undefined {
  try {
    return page.url();
  } catch {
    return undefined;
  }
}

/** Ground truth about the resolved element; undefined when it can't be read. */
async function readTarget(target: Locator): Promise<ActionEvidence["target"] | undefined> {
  try {
    return await target.evaluate(
      (element, max) => {
        const html = element as HTMLElement;
        const label = String(
          html.innerText ||
            (element as HTMLInputElement).value ||
            element.getAttribute("aria-label") ||
            element.textContent ||
            "",
        ).replace(/\s+/g, " ").trim().slice(0, max).trim();
        return {
          role: element.getAttribute("data-arena-role"),
          text: label.length > 0 ? label : null,
          decoy: element.getAttribute("data-arena-decoy") === "true",
        };
      },
      EVIDENCE_TEXT_MAX,
      { timeout: EVIDENCE_TIMEOUT_MS },
    );
  } catch {
    return undefined;
  }
}
