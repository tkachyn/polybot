import type { Locator, Page } from "playwright";
import type {
  BlockedBy,
  CursorPosition,
  DatasetAction,
  DecisionIssue,
  StepObservation,
} from "../api/dto.js";
import type {
  ActionEvidence,
  AgentActionReport,
  CompetitorAgentRunner,
  CompetitorContext,
  WorkerStateObservation,
} from "../application/contracts.js";
import {
  datasetAction,
  describeDecision,
  EVALUATE_SCRIPT_MAX_LENGTH,
  normalizeLabel,
  normalizeReasoning,
  REDACTED_TEXT,
  withoutReasoning,
} from "./competitor-decision.js";

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

/**
 * One model decision. Any decision may carry the model's one-sentence
 * `reasoning`: it is reported with the step, never sent back in history.
 */
export type AgentDecision =
  | { type: "inspect"; reasoning?: string }
  /** `label` picks, by visible text, among controls that share `targetRole`. */
  | { type: "click"; targetRole: string; label?: string; reasoning?: string }
  | { type: "type"; targetRole: string; text: string; label?: string; reasoning?: string }
  | { type: "evaluate"; script: string; reasoning?: string }
  | { type: "navigate"; url: string; reasoning?: string }
  | { type: "wait"; durationMs: number; reasoning?: string }
  | { type: "checkpoint"; checkpoint: number; reasoning?: string }
  | { type: "finish"; reasoning?: string };

export interface CompetitorDecisionModel {
  /** Optional provider pacing hook; returns after the next call is allowed. */
  prepareForCall?(signal?: AbortSignal): Promise<{
    waitedMs: number;
    maxCalls?: number;
    windowMs?: number;
  }>;
  decide(input: {
    task: string;
    racerId: string;
    observation: BrowserObservation;
    history: Array<{ decision: AgentDecision; error?: string }>;
    signal?: AbortSignal;
  }): Promise<AgentDecision>;
  /**
   * Optional: how the latest decision arrived when it was not one valid tool
   * call (malformed payloads the provider redid, or a substitute action when
   * it never gave a usable one). Cleared on read.
   */
  takeDecisionIssue?(): DecisionIssue | null;
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
/** The observation keeps at most this much page text and this many controls. */
const OBSERVATION_TEXT_MAX = 8_000;
const OBSERVATION_CONTROLS_MAX = 100;
/**
 * Typing into a control whose role or label names a secret is redacted even
 * when the target never resolved to a password input.
 */
const SECRET_FIELD_PATTERN = /pass(?:word|code|phrase)|\bpin\b|secret/i;
/** Shorter secrets are not scrubbed from free text, which they would garble. */
const SECRET_SCRUB_MIN_LENGTH = 3;
const CURSOR_INITIAL_X = 24;
const CURSOR_INITIAL_Y = 24;
const CURSOR_FRAME_MS = 16;
const CURSOR_MIN_MOVE_MS = 220;
const CURSOR_MAX_MOVE_MS = 750;
const CURSOR_PIXELS_PER_MS = 2.4;
/** Gives the recorded page time to render the pointer arriving at a target. */
const CURSOR_SETTLE_MS = 100;
const EVALUATE_TIMEOUT_MS = 1_000;
const MAX_CONSECUTIVE_DECISION_FAILURES = 3;
const MAX_TOTAL_DECISION_FAILURES = 6;
const UNSAFE_EVALUATE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bfetch\s*\(/i,
  /\bXMLHttpRequest\b/i,
  /\bWebSocket\b/i,
  /\bEventSource\b/i,
  /\bsendBeacon\s*\(/i,
  /\bdocument\s*\.\s*cookie\b/i,
  /\b(?:localStorage|sessionStorage|indexedDB)\b/i,
  /\b(?:window\s*\.\s*)?location\b/i,
  /\bwindow\s*\.\s*open\s*\(/i,
  /\b(?:eval|Function)\s*\(/i,
  /\bimport\s*\(/i,
  /(?:\.|["'])\s*(?:click|submit|requestSubmit)\s*\(/i,
  /\[\s*["'](?:click|submit|requestSubmit)["']\s*\]\s*\(/i,
  /\b(?:setTimeout|setInterval|queueMicrotask)\s*\(/i,
];

type CursorPoint = { x: number; y: number };
type PageCursorApi = {
  ensure(x: number, y: number): void;
  move(x: number, y: number, action: "click" | "type", pulse: boolean): void;
};

const CURSOR_BOOTSTRAP_SCRIPT = `
(() => {
  const cursorId = "arena-agent-cursor";
  const styleId = "arena-agent-cursor-style";
  const install = () => {
    const root = document.documentElement;
    if (!root) return;

    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = [
        "#" + cursorId + "{position:fixed;left:0;top:0;width:22px;height:28px;z-index:2147483647;pointer-events:none;user-select:none;will-change:transform;transition:transform 16ms linear;}",
        "#" + cursorId + " .arena-agent-cursor-shape{position:absolute;left:1px;top:1px;width:18px;height:24px;background:#000;clip-path:polygon(0 0,0 100%,29% 72%,45% 100%,61% 93%,44% 65%,94% 65%);filter:drop-shadow(0 0 1.5px #fff) drop-shadow(0 1px 1px rgb(0 0 0 / 80%));}",
        "#" + cursorId + " .arena-agent-cursor-pulse{position:absolute;left:-10px;top:-8px;width:38px;height:38px;border:2px solid #ff5364;border-radius:50%;opacity:0;}",
        "#" + cursorId + ".arena-agent-cursor-pulsing .arena-agent-cursor-pulse{animation:arena-agent-cursor-pulse 650ms ease-out both;}",
        "@keyframes arena-agent-cursor-pulse{0%{opacity:.9;transform:scale(.35)}100%{opacity:0;transform:scale(1.2)}}",
        "@media (prefers-reduced-motion: reduce){#" + cursorId + "{transition:none}#" + cursorId + ".arena-agent-cursor-pulsing .arena-agent-cursor-pulse{animation:none;opacity:.75}}",
      ].join("");
      (document.head || root).appendChild(style);
    }

    let cursor = document.getElementById(cursorId);
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.id = cursorId;
      cursor.setAttribute("aria-hidden", "true");
      cursor.setAttribute("data-arena-agent-cursor", "true");
      cursor.innerHTML = '<span class="arena-agent-cursor-pulse"></span><span class="arena-agent-cursor-shape"></span>';
      root.appendChild(cursor);
    }

    const api = {
      ensure(x, y) {
        cursor.style.transform = "translate3d(" + x + "px," + y + "px,0)";
      },
      move(x, y, action, pulse) {
        cursor.style.transform = "translate3d(" + x + "px," + y + "px,0)";
        cursor.dataset.action = action;
        if (pulse) {
          cursor.classList.remove("arena-agent-cursor-pulsing");
          void cursor.offsetWidth;
          cursor.classList.add("arena-agent-cursor-pulsing");
        }
      },
    };
    window.__arenaAgentCursor = api;
    api.ensure(window.__arenaAgentCursorPosition?.x ?? ${CURSOR_INITIAL_X}, window.__arenaAgentCursorPosition?.y ?? ${CURSOR_INITIAL_Y});
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
`;

export function validateEvaluateScript(script: string): string {
  const source = script.trim();
  if (source.length === 0) throw new Error("evaluate script cannot be empty");
  if (source.length > EVALUATE_SCRIPT_MAX_LENGTH) {
    throw new Error(`evaluate script cannot exceed ${EVALUATE_SCRIPT_MAX_LENGTH} characters`);
  }
  const unsafe = UNSAFE_EVALUATE_PATTERNS.find((pattern) => pattern.test(source));
  if (unsafe) throw new Error(`evaluate script uses a forbidden capability: ${unsafe.source}`);
  try {
    // Parse only; the script is still executed in the page context below.
    new Function(`return (${source});`);
  } catch {
    throw new Error("invalid JavaScript syntax");
  }
  return source;
}

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
  /** Text typed into a password field (or one named like it): never reported. */
  secret?: string;
};

/** What the model was shown for one step. */
type Observed = {
  observation: BrowserObservation;
  /** Per control: its label is a password field's value, redacted when recorded. */
  masked: boolean[];
};

type FrameCapture = {
  timer?: ReturnType<typeof setInterval>;
  /** Settles when the screenshot in flight settles; captures never overlap. */
  inFlight: Promise<void> | null;
  stopped: boolean;
};

export class PlaywrightCompetitorRunner implements CompetitorAgentRunner {
  private readonly prepared = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly captures = new Map<string, FrameCapture>();
  private readonly cursorPositions = new Map<string, CursorPoint>();
  private readonly cursorBootstrapped = new WeakSet<Page>();
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
    this.cursorPositions.set(context.racerId, initialCursorPoint(page));
    await this.bootstrapCursor(page);
    const url = new URL(this.options.startUrl);
    url.searchParams.set("raceId", context.raceId);
    url.searchParams.set("racerId", context.racerId);
    url.searchParams.set("seed", context.seed);
    url.searchParams.set("courseId", context.courseId);
    url.searchParams.set("steelSessionId", context.session.steelSessionId);
    url.searchParams.set("checkpointCount", String(context.checkpointCount));
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await this.restoreCursor(page, context.racerId);
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
    const secrets = new SecretScrubber();
    let totalDecisionFailures = 0;
    let consecutiveDecisionFailures = 0;
    let initialStateReported = false;

    try {
      for (let action = 0; action < this.maxActions; action += 1) {
        if (controller.signal.aborted) return;
        const step = action + 1;
        const observed = await this.observe(page);
        const observedAt = Date.now();
        if (!initialStateReported) {
          this.reportState(context, observed.observation, 0, observedAt);
          initialStateReported = true;
        }
        // The screenshot this step's observation was taken with.
        await this.captureStepFrame(page, context, capture, step);
        let decision: AgentDecision;
        let promptedAt = Date.now();
        let decidedAt = promptedAt;
        let rateLimitWaitMs = 0;
        let decisionIssue: DecisionIssue | null = null;
        for (;;) {
          const wait = await model.prepareForCall?.(controller.signal);
          rateLimitWaitMs = wait && wait.waitedMs > 0 ? wait.waitedMs : 0;
          if (rateLimitWaitMs > 0) {
            this.reportNote(context, step, {
              text: `Rate limit pause complete; resumed after ${Math.ceil(rateLimitWaitMs / 1_000)}s`,
              signature: `rate-limit:${Math.ceil(rateLimitWaitMs / 1_000)}`,
            });
          }
          promptedAt = Date.now();
          try {
            decision = await model.decide({
              task: this.options.task,
              racerId: context.racerId,
              observation: observed.observation,
              history: history.slice(-10),
              signal: controller.signal,
            });
            decidedAt = Date.now();
            decisionIssue = model.takeDecisionIssue?.() ?? null;
            consecutiveDecisionFailures = 0;
            break;
          } catch (error) {
            if (controller.signal.aborted) return;
            totalDecisionFailures += 1;
            consecutiveDecisionFailures += 1;
            const reason = error instanceof Error ? error.message : String(error);
            this.reportNote(context, step, {
              text: `Model provider pause (${consecutiveDecisionFailures}/${MAX_CONSECUTIVE_DECISION_FAILURES}, ${totalDecisionFailures}/${MAX_TOTAL_DECISION_FAILURES} total); no browser action used. Retrying: ${reason}`,
              signature: `model-provider-retry:${totalDecisionFailures}`,
            });
            if (
              consecutiveDecisionFailures >= MAX_CONSECUTIVE_DECISION_FAILURES ||
              totalDecisionFailures >= MAX_TOTAL_DECISION_FAILURES
            ) {
              throw new Error(
                `${context.racerId} model decision failed after ${totalDecisionFailures} provider/protocol retries: ${reason}`,
              );
            }
          }
        }
        if (controller.signal.aborted) return;

        const outcome = await this.attempt(page, context, decision);
        if (outcome.secret !== undefined) secrets.add(outcome.secret);
        // The model's own history never carries its reasoning.
        const remembered = withoutReasoning(decision);
        history.push(
          outcome.error === undefined
            ? { decision: remembered }
            : { decision: remembered, error: outcome.modelError ?? outcome.error },
        );
        this.report(context, decision, step, outcome, {
          observed, observedAt, promptedAt, decidedAt, rateLimitWaitMs, decisionIssue,
        }, secrets);
        // Let a navigation the action started commit first, so a sabotage
        // fired by the resulting checkpoint lands on the new page instead of
        // one that is being torn down.
        await this.settle(page);
        // Progress comes from the course's ground truth after every action,
        // successful or not. Explicit checkpoint decisions remain a fallback.
        await this.syncProgress(context);
        const after = await this.observe(page);
        this.reportState(
          context,
          after.observation,
          step,
          Date.now(),
          candidateMilestone(decision),
          outcome.evidence.navigated,
        );
        if (context.reviewProgress) {
          try {
            if (await context.reviewProgress({
              ...after.observation,
              at: Date.now(),
              step,
              maxSteps: Number.isFinite(this.maxActions) ? this.maxActions : 0,
              ...(candidateMilestone(decision) === undefined
                ? {}
                : { candidateMilestone: candidateMilestone(decision) }),
              ...(outcome.evidence.navigated === undefined
                ? {}
                : { navigated: outcome.evidence.navigated }),
            })) {
              return;
            }
          } catch {
            // A semantic review is advisory and must not end the run.
          }
        }
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
      this.cursorPositions.delete(context.racerId);
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

  /**
   * Reports one step: what the model saw, the exact tool call, its reason and
   * timing, and the browser evidence. Text typed into a password field is
   * replaced by "[redacted]" in every field, and removed from later steps.
   */
  private report(
    context: CompetitorContext,
    decision: AgentDecision,
    step: number,
    outcome: StepOutcome,
    seen: {
      observed: Observed;
      observedAt: number;
      promptedAt: number;
      decidedAt: number;
      rateLimitWaitMs: number;
      decisionIssue: DecisionIssue | null;
    },
    secrets: SecretScrubber,
  ): void {
    if (!context.reportAction) return;
    try {
      const redact = outcome.secret !== undefined;
      // Human text and the loop signature: secrets redacted, reasoning left out.
      const shown = withoutReasoning(
        redact && decision.type === "type" ? { ...decision, text: REDACTED_TEXT } : decision,
      );
      const reasoning = normalizeReasoning(decision.reasoning);
      const evidence = secrets.scrubEvidence(outcome.evidence);
      context.reportAction({
        kind: outcome.error === undefined ? "action" : "error",
        text: secrets.scrub(describeDecision(shown)),
        url: outcome.url === undefined ? undefined : secrets.scrub(outcome.url),
        step,
        maxSteps: Number.isFinite(this.maxActions) ? this.maxActions : 0,
        signature: secrets.scrub(JSON.stringify(shown)),
        ...(outcome.error === undefined
          ? {}
          : {
            error: secrets.scrubError(outcome.error, outcome.secret),
            // What the model's history holds for this step (secrets redacted).
            modelError: secrets.scrubError(outcome.modelError ?? outcome.error, outcome.secret),
          }),
        ...(Object.keys(evidence).length === 0 ? {} : { evidence }),
        observation: secrets.scrubObservation(
          stepObservation(seen.observed.observation, seen.observed.masked),
        ),
        action: secrets.scrubAction(datasetAction(decision, { redactText: redact })),
        ...(reasoning === undefined ? {} : { reasoning: secrets.scrub(reasoning) }),
        observedAt: seen.observedAt,
        promptedAt: seen.promptedAt,
        decidedAt: seen.decidedAt,
        ...(seen.rateLimitWaitMs > 0 ? { rateLimitWaitMs: seen.rateLimitWaitMs } : {}),
        ...(seen.decisionIssue === null ? {} : { decisionIssue: { ...seen.decisionIssue } }),
      });
    } catch {
      // Telemetry must never break the competitor loop.
    }
  }

  private reportNote(
    context: CompetitorContext,
    step: number,
    report: Pick<AgentActionReport, "text" | "signature">,
  ): void {
    try {
      context.reportAction?.({
        kind: "note",
        text: report.text,
        step,
        maxSteps: Number.isFinite(this.maxActions) ? this.maxActions : 0,
        signature: report.signature,
      });
    } catch {
      // Telemetry must never break the competitor loop.
    }
  }

  private reportState(
    context: CompetitorContext,
    observation: BrowserObservation,
    step: number,
    at: number,
    milestone?: string,
    navigated?: boolean,
  ): void {
    try {
      const state: WorkerStateObservation = {
        ...observation,
        at,
        step,
        maxSteps: Number.isFinite(this.maxActions) ? this.maxActions : 0,
        ...(milestone === undefined ? {} : { candidateMilestone: milestone }),
        ...(navigated === undefined ? {} : { navigated }),
      };
      context.reportState?.(state);
    } catch {
      // State telemetry must never break the competitor loop.
    }
  }

  private startFrames(page: Page, context: CompetitorContext): FrameCapture {
    this.stopFrames(context.racerId);
    const capture: FrameCapture = { inFlight: null, stopped: false };
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
    await this.screenshot(page, context, capture);
  }

  /**
   * The screenshot a step's observation was taken with, tagged with the
   * step. It waits for a periodic capture in flight instead of being
   * skipped; a failed screenshot only loses this frame.
   */
  private async captureStepFrame(
    page: Page,
    context: CompetitorContext,
    capture: FrameCapture,
    step: number,
  ): Promise<void> {
    if (!context.reportFrame) return;
    while (capture.inFlight && !capture.stopped) await capture.inFlight;
    if (capture.stopped) return;
    await this.screenshot(page, context, capture, step);
  }

  private async screenshot(
    page: Page,
    context: CompetitorContext,
    capture: FrameCapture,
    step?: number,
  ): Promise<void> {
    let settle: () => void = () => undefined;
    capture.inFlight = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      const body = await page.screenshot({
        type: "jpeg",
        quality: this.options.frameQuality ?? DEFAULT_FRAME_QUALITY,
        fullPage: false,
      });
      if (!capture.stopped) {
        context.reportFrame?.({
          contentType: "image/jpeg",
          body,
          capturedAt: Date.now(),
          ...(step === undefined ? {} : { step }),
        });
      }
    } catch {
      // A failed capture only costs one frame.
    } finally {
      capture.inFlight = null;
      settle();
    }
  }

  private async observe(page: Page): Promise<Observed> {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const found = await page
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
            // The label is a password field's value: the model sees it as
            // before, but it is redacted wherever the step is recorded.
            masked: control.type === "password" && !html.innerText && Boolean(control.value),
          };
        }),
      )
      .catch(() => []);
    const controls: BrowserObservation["controls"] = [];
    const masked: boolean[] = [];
    for (const { masked: isMasked, ...control } of found) {
      controls.push(control);
      masked.push(isMasked === true);
    }
    return {
      observation: {
        url: page.url(),
        title: await page.title(),
        bodyText: bodyText.slice(0, OBSERVATION_TEXT_MAX),
        controls,
      },
      masked,
    };
  }

  private async execute(
    page: Page,
    context: CompetitorContext,
    decision: AgentDecision,
    evidence: ActionEvidence,
    facts: { password: boolean },
  ): Promise<boolean> {
    switch (decision.type) {
      case "inspect":
        return false;
      case "click": {
        const target = await this.resolveTarget(page, decision.targetRole, decision.label);
        const read = await readTarget(target);
        if (read) evidence.target = read.target;
        const cursor = await this.moveCursorToTarget(page, context.racerId, target, "click");
        if (cursor) evidence.cursor = cursor;
        await target.click({ timeout: this.actionTimeoutMs });
        return false;
      }
      case "type": {
        if (decision.text.length > 2_000) throw new Error("Text input is too long");
        const target = await this.resolveTarget(page, decision.targetRole, decision.label);
        const read = await readTarget(target);
        if (read) evidence.target = read.target;
        // Typed text is only recorded from a field known not to be a password.
        facts.password = read ? read.password : true;
        const cursor = await this.moveCursorToTarget(page, context.racerId, target, "type");
        if (cursor) evidence.cursor = cursor;
        await target.fill(decision.text, { timeout: this.actionTimeoutMs });
        return false;
      }
      case "evaluate":
        if (!(await this.hasActiveDisruption(page))) {
          throw new Error("evaluate is only available while an arena disruption is active");
        }
        await this.evaluateDom(page, decision.script);
        return false;
      case "navigate": {
        const current = new URL(currentUrl(page) ?? this.options.startUrl, this.options.startUrl);
        const target = new URL(decision.url, this.options.startUrl);
        if (target.origin !== new URL(this.options.startUrl).origin) {
          throw new Error("Cross-origin navigation is not allowed");
        }
        preserveRunProof(target, current);
        await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
        await this.restoreCursor(page, context.racerId);
        return false;
      }
      case "wait":
        if (await this.hasActiveDisruption(page)) {
          throw new ActionBlockedError(
            "modal",
            "Waiting cannot clear an active disruption; use a bounded same-page DOM recovery action",
          );
        }
        await page.waitForTimeout(Math.max(0, Math.min(decision.durationMs, 2_000)));
        return false;
      case "checkpoint":
        if (await context.reportCheckpoint(decision.checkpoint) !== false) return false;
        if (context.completionJudge) {
          try {
            const judged = await context.completionJudge.judgeCheckpoint({
              task: this.options.task,
              racerId: context.racerId,
              checkpoint: decision.checkpoint,
              observation: await this.observe(page).then((result) => result.observation),
              candidateMilestone: candidateMilestone(decision),
            });
            if (judged) {
              return await context.reportCheckpoint(decision.checkpoint, "master") !== false;
            }
          } catch {
            // Fall through to a visible, recoverable progress error.
          }
        }
        throw new Error(`Checkpoint ${decision.checkpoint} was not verified; continue from the current page state`);
      case "finish":
        if (await context.reportFinish() !== false) return true;
        if (!context.completionJudge) return false;
        try {
          const judged = await context.completionJudge.judgeCompletion({
            task: this.options.task,
            racerId: context.racerId,
            observation: await this.observe(page).then((result) => result.observation),
            candidateMilestone: candidateMilestone(decision),
          });
          if (!judged) return false;
          return await context.reportFinish("master") !== false;
        } catch {
          return false;
        }
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
    const facts = { password: false };
    const before = currentUrl(page);
    const disruptionBefore = await this.hasActiveDisruption(page);
    let finished = false;
    let failed = false;
    let failure: unknown;
    try {
      finished = await this.execute(page, context, decision, evidence, facts);
    } catch (error) {
      failed = true;
      failure = error;
    }
    const url = currentUrl(page);
    if (before !== undefined && url !== undefined) evidence.navigated = url !== before;
    const secret = decision.type === "type" && (facts.password || namesSecret(decision))
      ? decision.text
      : undefined;
    const secretField = secret === undefined ? {} : { secret };
    if (!failed) {
      if (disruptionBefore && !(await this.hasActiveDisruption(page))) {
        evidence.clearedSabotage = true;
        try {
          await context.reportRecovery?.();
        } catch {
          // Recovery lifecycle must not turn a successful browser action into
          // a competitor failure.
        }
      }
      return { finished, evidence, url, ...secretField };
    }
    const error = failure instanceof Error ? failure.message : String(failure);
    const blockedBy = classifyBlockedBy(failure);
    if (blockedBy) evidence.blockedBy = blockedBy;
    return {
      finished: false,
      evidence,
      url,
      error,
      modelError: modelFacingError(failure, error, blockedBy),
      ...secretField,
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

  private async bootstrapCursor(page: Page): Promise<void> {
    if (this.cursorBootstrapped.has(page) || typeof page.addInitScript !== "function") return;
    try {
      await page.addInitScript({ content: CURSOR_BOOTSTRAP_SCRIPT });
      this.cursorBootstrapped.add(page);
    } catch {
      // Cursor visuals must never prevent a racer from starting.
    }
  }

  private async restoreCursor(page: Page, racerId: string): Promise<void> {
    const point = this.cursorPositions.get(racerId) ?? initialCursorPoint(page);
    this.cursorPositions.set(racerId, point);
    await movePageCursor(page, point.x, point.y, "click", false);
    if (page.mouse) await page.mouse.move(point.x, point.y);
  }

  /**
   * Moves both the page-rendered cursor and Playwright's synthetic pointer at
   * a paced, distance-based speed. The page cursor is the visual source of
   * truth because Steel records it as ordinary page pixels.
   */
  private async moveCursorToTarget(
    page: Page,
    racerId: string,
    target: Locator,
    action: CursorPosition["action"],
  ): Promise<CursorPosition | undefined> {
    try {
      if (typeof target.scrollIntoViewIfNeeded === "function") {
        await target.scrollIntoViewIfNeeded({ timeout: this.actionTimeoutMs }).catch(() => undefined);
      }
      if (typeof target.boundingBox !== "function" || !page.mouse) return undefined;
      const box = await target.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) return undefined;
      const viewport = readViewportSize(page);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const viewportWidth = viewport?.width ?? Math.max(1, Math.ceil(box.x + box.width));
      const viewportHeight = viewport?.height ?? Math.max(1, Math.ceil(box.y + box.height));
      const from = this.cursorPositions.get(racerId) ?? initialCursorPoint(page);
      const distance = Math.hypot(x - from.x, y - from.y);
      const duration = Math.min(
        CURSOR_MAX_MOVE_MS,
        Math.max(CURSOR_MIN_MOVE_MS, distance / CURSOR_PIXELS_PER_MS),
      );
      const steps = Math.max(1, Math.ceil(duration / CURSOR_FRAME_MS));

      for (let step = 1; step <= steps; step += 1) {
        const rawProgress = step / steps;
        const progress = rawProgress * rawProgress * (3 - 2 * rawProgress);
        const nextX = from.x + (x - from.x) * progress;
        const nextY = from.y + (y - from.y) * progress;
        await movePageCursor(page, nextX, nextY, action, step === steps);
        await page.mouse.move(nextX, nextY);
        if (step < steps) await page.waitForTimeout(CURSOR_FRAME_MS);
      }
      await page.waitForTimeout(CURSOR_SETTLE_MS);
      this.cursorPositions.set(racerId, { x, y });
      return { x, y, viewportWidth, viewportHeight, action };
    } catch {
      // Pointer movement is visual evidence and must never block the action.
      return undefined;
    }
  }

  private async evaluateDom(page: Page, script: string): Promise<unknown> {
    const source = validateEvaluateScript(script);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        page.evaluate((expression) => {
          const evaluate = new Function(`return (${expression})`) as () => unknown;
          return evaluate();
        }, source),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("evaluate script timed out")), EVALUATE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async hasActiveDisruption(page: Page): Promise<boolean> {
    if (typeof page.evaluate !== "function") return false;
    return page.evaluate(() => {
      const registry = (window as unknown as {
        __arenaDisruptions?: Record<string, { active?: boolean }>;
      }).__arenaDisruptions;
      return Object.values(registry ?? {}).some((entry) => entry.active !== false);
    }).catch(() => false);
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

function candidateMilestone(decision: AgentDecision): string | undefined {
  if (decision.type === "checkpoint") return `checkpoint:${decision.checkpoint}`;
  if (decision.type === "finish") return "finish";
  return undefined;
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
  return modelFacingHeadline(message, blockedBy);
}

/** The runner's own "No control ..." messages: the model sees them as they are. */
const OWN_BLOCKED_MESSAGE = /^No control (?:has|with) data-arena-role /;

/**
 * What the model was told about a failed step, rebuilt from a raw error
 * (which can hold Playwright's call log and hidden markup such as the decoy
 * flag). Prefer `StepRecord.modelError`, which records the same text
 * directly; this stays for records without it.
 */
export function modelFacingErrorText(error: string, blockedBy: BlockedBy | null | undefined): string {
  return OWN_BLOCKED_MESSAGE.test(error) ? error : modelFacingHeadline(error, blockedBy ?? undefined);
}

function modelFacingHeadline(message: string, blockedBy: BlockedBy | undefined): string {
  const headline = (message.split("\n", 1)[0] ?? "")
    .replace(/\x1b\[[0-9;]*m/g, "")
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

/**
 * Ground truth about the resolved element, and whether it is a password input
 * (read from its `type` attribute); undefined when it can't be read. A
 * password field's value is never read.
 */
async function readTarget(
  target: Locator,
): Promise<{ target: NonNullable<ActionEvidence["target"]>; password: boolean } | undefined> {
  try {
    const read = await target.evaluate(
      (element, max) => {
        const html = element as HTMLElement;
        const type = String(element.getAttribute("type") ?? "").trim().toLowerCase();
        const value = type === "password" ? "" : (element as HTMLInputElement).value;
        const label = String(
          html.innerText ||
            value ||
            element.getAttribute("aria-label") ||
            element.textContent ||
            "",
        ).replace(/\s+/g, " ").trim().slice(0, max).trim();
        return {
          role: element.getAttribute("data-arena-role"),
          text: label.length > 0 ? label : null,
          decoy: element.getAttribute("data-arena-decoy") === "true",
          type,
        };
      },
      EVIDENCE_TEXT_MAX,
      { timeout: EVIDENCE_TIMEOUT_MS },
    );
    return {
      target: { role: read.role, text: read.text, decoy: read.decoy },
      password: read.type === "password",
    };
  } catch {
    return undefined;
  }
}

/**
 * A browser observation as recorded with its step (StepObservation). Controls
 * flagged in `masked` show a password field's value, which is redacted.
 */
export function stepObservation(
  observation: BrowserObservation,
  masked: readonly boolean[] = [],
): StepObservation {
  return {
    url: observation.url,
    title: observation.title,
    text: observation.bodyText.slice(0, OBSERVATION_TEXT_MAX),
    controls: observation.controls.slice(0, OBSERVATION_CONTROLS_MAX).map((control, index) => ({
      tag: control.tag,
      role: control.role,
      arenaRole: control.arenaRole,
      label: masked[index] === true ? REDACTED_TEXT : control.text,
      visible: control.visible,
      disabled: control.disabled,
    })),
  };
}

function namesSecret(decision: { targetRole: string; label?: string }): boolean {
  return SECRET_FIELD_PATTERN.test(decision.targetRole) ||
    (decision.label !== undefined && SECRET_FIELD_PATTERN.test(decision.label));
}

/**
 * Remembers text typed into password fields during one run and removes it,
 * raw, JSON-escaped or URL-encoded, from everything reported afterwards.
 */
class SecretScrubber {
  private readonly variants: string[] = [];

  add(secret: string): void {
    if (secret.trim().length < SECRET_SCRUB_MIN_LENGTH) return;
    for (const variant of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) {
      if (!this.variants.includes(variant)) this.variants.push(variant);
    }
    // Longest first, so a secret that contains another is replaced whole.
    this.variants.sort((left, right) => right.length - left.length);
  }

  scrub(text: string): string {
    let clean = text;
    for (const variant of this.variants) clean = clean.split(variant).join(REDACTED_TEXT);
    return clean;
  }

  /** Also covers Playwright's call log, which quotes the value a failed fill was given. */
  scrubError(error: string, secret: string | undefined): string {
    const quoted = secret === undefined ? null : `fill(${JSON.stringify(secret)})`;
    return this.scrub(quoted === null ? error : error.split(quoted).join(`fill("${REDACTED_TEXT}")`));
  }

  scrubEvidence(evidence: ActionEvidence): ActionEvidence {
    const target = evidence.target;
    if (this.variants.length === 0 || typeof target?.text !== "string") return evidence;
    return { ...evidence, target: { ...target, text: this.scrub(target.text) } };
  }

  scrubObservation(observation: StepObservation): StepObservation {
    if (this.variants.length === 0) return observation;
    return {
      url: observation.url === null ? null : this.scrub(observation.url),
      title: observation.title === null ? null : this.scrub(observation.title),
      text: this.scrub(observation.text),
      controls: observation.controls.map((control) => ({ ...control, label: this.scrub(control.label) })),
    };
  }

  scrubAction(action: DatasetAction): DatasetAction {
    if (this.variants.length === 0) return action;
    const clean: DatasetAction = { ...action };
    for (const key of ["targetRole", "label", "text", "script", "url"] as const) {
      const value = clean[key];
      if (typeof value === "string") clean[key] = this.scrub(value);
    }
    return clean;
  }
}

function initialCursorPoint(page: Page): CursorPoint {
  const viewport = readViewportSize(page);
  return {
    x: Math.min(CURSOR_INITIAL_X, Math.max(0, (viewport?.width ?? 800) - 1)),
    y: Math.min(CURSOR_INITIAL_Y, Math.max(0, (viewport?.height ?? 600) - 1)),
  };
}

function readViewportSize(page: Page): { width: number; height: number } | null {
  return typeof page.viewportSize === "function" ? page.viewportSize() : null;
}

const RUN_PROOF_QUERY_KEYS = [
  "raceId",
  "racerId",
  "courseId",
  "seed",
  "steelSessionId",
  "checkpointCount",
] as const;

function preserveRunProof(target: URL, current: URL): void {
  for (const key of RUN_PROOF_QUERY_KEYS) {
    const value = current.searchParams.get(key);
    if (value !== null) target.searchParams.set(key, value);
  }
}

async function movePageCursor(
  page: Page,
  x: number,
  y: number,
  action: CursorPosition["action"],
  pulse: boolean,
): Promise<void> {
  if (typeof page.evaluate !== "function") return;
  await page.evaluate(
    ({ x: nextX, y: nextY, action: nextAction, pulse: shouldPulse }) => {
      const api = (window as Window & { __arenaAgentCursor?: PageCursorApi }).__arenaAgentCursor;
      if (!api) return;
      api.move(nextX, nextY, nextAction, shouldPulse);
    },
    { x, y, action, pulse },
  );
}
