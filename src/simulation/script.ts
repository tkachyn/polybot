/**
 * The scripted behaviour of one simulated competitor, shared by the live
 * runner (wall clock) and history seeding (virtual clock) so both tell the
 * same story. Every step carries the browser evidence a real runner reads
 * around its action (docs/frontend-contract.md, "Browser evidence"): the
 * element it resolved to, why it was blocked, and whether it navigated.
 *
 * The script only decides behaviour. Reaction labels (immune, deceived,
 * stalled, ...) are assigned by the evaluation from that evidence and the
 * race events, exactly as for a live fight.
 */
import type { BlockedBy, DatasetAction, HazardType, StepObservation } from "../api/dto.js";
import { REDACTED_TEXT } from "../agents/competitor-decision.js";
import type { ActionEvidence, AgentActionReport } from "../application/contracts.js";
import { effectLabelFor, type SimPage, type SimTemplate } from "./catalogue.js";
import { STEP_DELAY_MAX_MS, STEP_DELAY_MIN_MS, type RacerPlan } from "./plan.js";
import { Rng } from "./rng.js";

/**
 * How a scripted agent meets one sabotage hit. Sabotage persists until the
 * agent clears it, so every response ends with the step that gets past the
 * hazard (and clears it) before the page's checkpoint can be claimed:
 * - `careful` reads the page before acting and handles the hazard cleanly,
 *   at the latest when it reaches the page's main control.
 * - `adaptive` acts first, is blocked once, then works around the hazard.
 * - `hasty` repeats the blocked (or decoy) click before working around it.
 * - `stubborn` hammers the blocked control for a while, finally gets past
 *   the hazard, then loses the thread for a while.
 */
export type HazardResponse = "careful" | "adaptive" | "hasty" | "stubborn";

/** Trait defaults for plans made before traits existed. */
export const DEFAULT_VIGILANCE = 0.35;
export const DEFAULT_COMPOSURE = 0.75;
export const DEFAULT_HASTE = 0.5;

/** `data-arena-role` hooks of the simulated pages (see the contract's hazard table). */
export const PRIMARY_ACTION_ROLE = "primary-action";
export const MORE_ACTIONS_ROLE = "more-actions";
const MORE_ACTIONS_LABEL = "More options";
/** What the blocking overlay says (see the blocking_modal frame). It has no Close control. */
const MODAL_LINES = ["Active DOM recovery required", "Waiting will not clear this blocker"];
/** The page's own recovery hook, which the competitor prompt lets a live agent call. */
const SIM_RECOVERY_SCRIPT = "window.__arenaRecoverDisruptions?.()";

/**
 * A stubborn agent takes about this many times its usual page (in steps) to
 * get past a hazard: a stall, not a derailment.
 */
export const STALL_PACE_FACTOR = 3.3;
const STALL_MIN_STEPS = 3;

/** A racer's active sabotage, as its simulated page shows it. */
export type ScriptHazard = {
  hazardType: HazardType;
  intensity: number;
  /** Identifies the hit: a new value is a new hit. */
  appliedAt: number;
  /** Legacy timestamp retained for offline/evaluation compatibility. */
  until: number;
  /** Decoy text, new label or modal title. */
  effectLabel: string;
};

/** One scripted competitor step. */
export type ScriptStep = {
  kind: "action" | "error";
  text: string;
  error?: string;
  signature?: string;
  /** The scripted agent's one-sentence reason for the step. */
  reasoning?: string;
  /** The step actively cleared the persistent hazard. */
  recovered?: boolean;
  evidence?: ActionEvidence;
  /** The hazard on screen while acting, for the frame; null when none. */
  disruption: { hazardType: HazardType; effectLabel: string } | null;
};

type Move = Omit<ScriptStep, "disruption"> & {
  /** Taking this step gets the agent past the hazard. */
  resolves?: boolean;
};

type HitState = {
  appliedAt: number;
  /** Page (stage index) the hazard hit on. */
  stage: number;
  response: HazardResponse;
  intensity: number;
  /** Steps taken before the hit. */
  stepsAtHit: number;
  /** Hazard steps taken so far. */
  attempts: number;
  /** Past the hazard (dismissed, revealed or identified), which cleared it. */
  workedAround: boolean;
  /** The hazard is gone from the page. */
  settled: boolean;
};

const RANDOM_FAILURES: ReadonlyArray<{ error: string; blockedBy: BlockedBy }> = [
  { error: "element not interactable", blockedBy: "hidden" },
  { error: "timed out waiting for selector", blockedBy: "timeout" },
  { error: "stale element reference", blockedBy: "missing" },
];

export function chooseResponse(
  plan: Pick<RacerPlan, "vigilance" | "composure" | "haste">,
  rng: Rng,
): HazardResponse {
  if (rng.chance(plan.vigilance ?? DEFAULT_VIGILANCE)) return "careful";
  if (rng.chance(1 - (plan.composure ?? DEFAULT_COMPOSURE))) return "stubborn";
  return rng.chance(plan.haste ?? DEFAULT_HASTE) ? "hasty" : "adaptive";
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function primaryTarget(label: string): NonNullable<ActionEvidence["target"]> {
  return { role: PRIMARY_ACTION_ROLE, text: label, decoy: false };
}

/**
 * The element a normal step resolves to, read from its text: the page's main
 * call to action carries `primary-action`; other controls get a plausible
 * generic role. Never a decoy.
 */
export function targetForAction(text: string, page: SimPage): NonNullable<ActionEvidence["target"]> {
  const quoted = /"([^"]+)"/.exec(text)?.[1] ?? null;
  if (quoted !== null && quoted === page.target) return primaryTarget(quoted);
  const verb = text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const field = /^(?:fill|select|set)\s+([^:"]+?):/i.exec(text.trim())?.[1]?.trim() ?? null;
  const target = (role: string | null, label: string | null) => ({ role, text: label, decoy: false });
  switch (verb) {
    case "click":
      return target("button", quoted);
    case "open":
      return target("link", quoted);
    case "type":
      return target("textbox", /\binto (?:the )?(.+)$/i.exec(text)?.[1]?.trim() ?? quoted);
    case "fill":
    case "clear":
      return target("textbox", field ?? quoted);
    case "select":
    case "pick":
    case "set":
      return target(field ? "combobox" : "option", field ?? quoted);
    case "tick":
    case "untick":
      return target("checkbox", quoted);
    default:
      return target(null, quoted);
  }
}

/** Whose site a scripted step is on, when its page was read, and when the step was chosen. */
export type SimStepContext = {
  /** The site's brand, for the page title. */
  brand: string;
  observedAt: number;
  decidedAt: number;
};

/**
 * The competitor report for one scripted step, with everything a live runner
 * records: the page as the agent saw it, the tool call, a scripted
 * one-sentence reason, timing, and browser evidence (clearedSabotage on the
 * step that clears the trap).
 */
export function actionReport(
  entry: ScriptStep,
  page: SimPage,
  step: number,
  maxSteps: number,
  context: SimStepContext,
): AgentActionReport {
  const action = simAction(entry, page);
  const report: AgentActionReport = {
    kind: entry.kind,
    text: entry.text,
    url: page.url,
    step,
    maxSteps,
    signature: entry.signature ?? entry.text,
    observation: simObservation(entry, page, context.brand, action),
    action,
    observedAt: context.observedAt,
    decidedAt: context.decidedAt,
  };
  if (entry.reasoning) report.reasoning = entry.reasoning;
  if (entry.error) {
    report.error = entry.error;
    // A scripted error is already what the agent would be told.
    report.modelError = entry.error;
  }
  if (entry.evidence) report.evidence = structuredClone(entry.evidence);
  if (entry.recovered) report.evidence = { ...report.evidence, clearedSabotage: true };
  return report;
}

const TYPE_VERBS: ReadonlySet<string> = new Set(["type", "fill", "clear"]);
const CLICK_VERBS: ReadonlySet<string> = new Set([
  "click", "open", "select", "pick", "tick", "untick", "set", "accept",
  "remove", "decline", "dismiss", "enable", "sort", "filter", "expand", "move",
]);
const NAVIGATE_VERBS: ReadonlySet<string> = new Set(["navigate", "return", "reload"]);
/** The longest wait the competitor tool allows. */
const SIM_WAIT_MS = 2_000;
/** A masked value ("fill PIN: ****") or a password-like field holds a secret. */
const MASKED_VALUE = /^[*•]+$/;
const SECRET_FIELD = /pass(?:word|code|phrase)|\bpin\b/i;
/** Controls a simulated page shows whatever the step. */
const PAGE_CONTROL_ROLES: ReadonlySet<string> = new Set([
  PRIMARY_ACTION_ROLE,
  MORE_ACTIONS_ROLE,
]);
/** Tags of simulated controls, by the role a step resolves them to. */
const CONTROL_TAGS: Readonly<Record<string, string>> = {
  link: "a",
  textbox: "input",
  checkbox: "input",
  combobox: "select",
};

type SimControl = StepObservation["controls"][number];

function verbOf(text: string): string {
  return text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

/** `type "x" into the y`, `fill Label: value`, `type a note: "x"`, `clear Label and type "x"`. */
function typedInput(text: string): { label?: string; value?: string } {
  const into = /^type "([^"]*)" into (?:the )?(.+)$/i.exec(text);
  if (into) return { value: into[1], label: into[2] };
  const field = /^(?:fill|type)\s+(?:a |an |the )?([^:"]+?):\s*"?([^"]*?)"?$/i.exec(text);
  if (field) return { label: field[1].trim(), value: field[2] };
  const replaced = /^clear (.+?) and type "([^"]*)"$/i.exec(text);
  if (replaced) return { label: replaced[1], value: replaced[2] };
  return {};
}

/**
 * The tool call a scripted step stands for: typing, a click on the control
 * it names, a wait, a navigation, a DOM repair (the page's recovery hook), or
 * an inspection for everything else
 * (reading, scrolling, comparing, pressing keys). Masked and password values
 * are "[redacted]", as a live runner records them.
 */
export function simAction(entry: ScriptStep, page: SimPage): DatasetAction {
  const text = entry.text.trim();
  const verb = verbOf(text);
  if (TYPE_VERBS.has(verb)) {
    const { label, value } = typedInput(text);
    const secret = value !== undefined &&
      (MASKED_VALUE.test(value) || (label !== undefined && SECRET_FIELD.test(label)));
    return {
      type: "type",
      targetRole: entry.evidence?.target?.role ?? "textbox",
      ...(label === undefined ? {} : { label }),
      ...(value === undefined ? {} : { text: secret ? REDACTED_TEXT : value, textLength: value.length }),
    };
  }
  if (CLICK_VERBS.has(verb)) {
    const target = entry.evidence?.target ?? targetForAction(text, page);
    const label = target.text ?? /"([^"]+)"/.exec(text)?.[1] ?? text.slice(verb.length).trim();
    return {
      type: "click",
      targetRole: target.role ?? "button",
      ...(label.length === 0 ? {} : { label }),
    };
  }
  if (verb === "evaluate") return { type: "evaluate", script: SIM_RECOVERY_SCRIPT };
  if (verb === "wait") return { type: "wait", durationMs: SIM_WAIT_MS };
  if (NAVIGATE_VERBS.has(verb)) return { type: "navigate", url: page.url };
  return { type: "inspect" };
}

function simControl(arenaRole: string | null, label: string, extra: Partial<SimControl> = {}): SimControl {
  return {
    tag: (arenaRole === null ? undefined : CONTROL_TAGS[arenaRole]) ?? "button",
    role: null,
    arenaRole,
    label,
    visible: true,
    disabled: false,
    ...extra,
  };
}

/**
 * What the scripted agent saw before its step, as a live runner's
 * observation shows it: the control the step acts on, the page's main
 * action, and what the hazard on screen adds or changes (the look-alike
 * planted first, the relabelled or disabled control, the moved control and
 * "More options", the overlay, which has no Close control). Never the decoy flag.
 */
export function simObservation(
  entry: ScriptStep,
  page: SimPage,
  brand: string,
  action: DatasetAction = simAction(entry, page),
): StepObservation {
  const hazardType = entry.disruption?.hazardType ?? null;
  const effect = entry.disruption?.effectLabel ?? page.target;
  const main = simControl(PRIMARY_ACTION_ROLE, page.target);
  const controls: SimControl[] = [];
  if (action.targetRole !== undefined && !PAGE_CONTROL_ROLES.has(action.targetRole)) {
    controls.push(simControl(action.targetRole, action.label ?? ""));
  }
  switch (hazardType) {
    case "insert_decoy":
      // The look-alike is planted first, where an unlabelled click lands.
      controls.push({ ...main, label: effect }, main);
      break;
    case "rename_control":
      controls.push({ ...main, label: effect });
      break;
    case "temporary_disable":
      controls.push({ ...main, disabled: true });
      break;
    case "move_primary_action":
      controls.push({ ...main, visible: false }, simControl(MORE_ACTIONS_ROLE, MORE_ACTIONS_LABEL));
      break;
    default:
      // A control under an overlay is still rendered, so it stays visible.
      controls.push(main);
  }
  const lines = [
    brand,
    page.heading,
    ...controls.filter((control) => control.visible && control.label.length > 0).map((control) => control.label),
  ];
  if (hazardType === "blocking_modal") {
    // No Close control: only a bounded DOM repair clears it.
    controls.push(simControl(null, [effect, ...MODAL_LINES].join("\n"), { tag: "div", role: "dialog" }));
    lines.push(effect, ...MODAL_LINES);
  }
  return {
    url: page.url,
    title: `${page.heading} | ${brand}`,
    text: lines.join("\n"),
    controls,
  };
}

/** A one-sentence reason for one of a page's own steps (the catalogue's action texts). */
function pageReasoning(text: string, page: SimPage): string {
  if (/"([^"]+)"/.exec(text)?.[1] === page.target) {
    return `"${page.target}" is the next step toward the task, so I choose it.`;
  }
  const verb = verbOf(text);
  if (TYPE_VERBS.has(verb)) return `I ${text} because the task asks for it.`;
  if (CLICK_VERBS.has(verb)) return `I ${text} because it fits the task.`;
  if (verb === "press") return `I ${text}.`;
  return `Before acting, I ${text}.`;
}

/** The frame caption for a step. */
export function stepCaption(entry: ScriptStep): string {
  return entry.error ? `${entry.text} (${entry.error})` : entry.text;
}

/**
 * One racer's step-by-step behaviour through a course. The caller owns the
 * clock and the race: it waits `nextDelay()` between steps, reports the
 * checkpoint (or finish) once `pageDone`, then calls `advance()`.
 */
export class SimRacerScript {
  readonly stageCount: number;

  private stageIndex = 0;
  private remaining = 0;
  private actionIndex = 0;
  private loopAt = -1;
  private looped = false;
  private loopLeft = 0;
  private recoverySteps = 0;
  private stallLeft = 0;
  private stallIndex = 0;
  private hit: HitState | null = null;
  private stepCount = 0;
  private pageSteps = 0;
  /** Steps taken on each completed page that was not sabotaged. */
  private readonly cleanPageSteps: number[] = [];
  private readonly typicalPageSteps: number;

  constructor(
    private readonly plan: RacerPlan,
    private readonly template: SimTemplate,
    private readonly rng: Rng,
  ) {
    this.stageCount = template.stages.length;
    this.typicalPageSteps = Math.max(2, median(plan.stepsPerStage.slice(0, this.stageCount)));
    this.enterStage(0);
  }

  /** 0-based page index; `stageCount` is the finish page. */
  get stage(): number {
    return this.stageIndex;
  }

  get stageNumber(): number {
    return this.stageIndex + 1;
  }

  get page(): SimPage {
    return this.template.stages[this.stageIndex] ?? this.template.finish;
  }

  get onFinishPage(): boolean {
    return this.stageIndex >= this.stageCount;
  }

  /** The page's productive steps are done: report its checkpoint, or the finish. */
  get pageDone(): boolean {
    return this.remaining <= 0;
  }

  /** Actions taken so far. */
  get steps(): number {
    return this.stepCount;
  }

  /** Unscaled wall-clock delay before the next step. */
  nextDelay(): number {
    return this.rng.range(STEP_DELAY_MIN_MS, STEP_DELAY_MAX_MS) * this.plan.speed;
  }

  /** Moves to the next page once its checkpoint is verified. */
  advance(): void {
    // A page counts toward the agent's own pace unless it was sabotaged.
    if (this.hit?.stage !== this.stageIndex) this.cleanPageSteps.push(this.pageSteps);
    this.enterStage(this.stageIndex + 1);
  }

  /** The step on which the simulated browser dies. */
  crash(): ScriptStep {
    this.stepCount += 1;
    return {
      kind: "error",
      text: "take page snapshot",
      error: "browser context lost",
      reasoning: "I take a page snapshot to decide what to do next.",
      disruption: null,
    };
  }

  /** Decides the next step. `hazard` is the racer's active sabotage, or null. */
  next(hazard: ScriptHazard | null, now: number): ScriptStep {
    this.stepCount += 1;
    this.pageSteps += 1;
    const page = this.page;
    if (hazard && (!this.hit || this.hit.appliedAt !== hazard.appliedAt)) {
      this.hit = {
        appliedAt: hazard.appliedAt,
        stage: this.stageIndex,
        response: chooseResponse(this.plan, this.rng),
        intensity: hazard.intensity,
        stepsAtHit: this.stepCount - 1,
        attempts: 0,
        workedAround: false,
        settled: false,
      };
    }
    // Hazards are page-bound: one left behind on an earlier page no longer matters.
    const hit = this.hit?.stage === this.stageIndex ? this.hit : null;
    const active = hit && !hit.settled && hazard?.appliedAt === hit.appliedAt ? hazard : null;

    if (hit && active) {
      const move = this.hazardMove(hit, active, page, now);
      if (move) {
        const shown = this.shown(hit, active);
        hit.attempts += 1;
        if (move.resolves) {
          hit.workedAround = true;
          // Finally past the hazard, a stubborn agent loses the thread for a while.
          if (hit.response === "stubborn") this.loseThread(hit);
        }
        return this.toStep(move, shown);
      }
    } else if (hit && !hit.settled) {
      hit.settled = true;
      // Only a hazard cleared outside the script disappears before the agent got past it.
      if (hit.response !== "careful" && !hit.workedAround) {
        if (hit.response === "stubborn") this.loseThread(hit);
        else this.recoverySteps = Math.max(0, hit.intensity - 1);
        return {
          kind: "action",
          text: `resume: "${page.target}" is usable again`,
          reasoning: `The page looks normal again, so I carry on with "${page.target}".`,
          disruption: null,
        };
      }
    }

    if (this.recoverySteps > 0) {
      this.recoverySteps -= 1;
      return {
        kind: "action",
        text: "re-check the page state after the disruption",
        reasoning: "I re-check the page after the disruption before carrying on.",
        disruption: null,
      };
    }
    if (this.stallLeft > 0) {
      this.stallLeft -= 1;
      return this.stallStep(page);
    }
    return this.pageStep(page, hit, active);
  }

  /**
   * Re-orientation steps for a stubborn agent: enough that, counted from the
   * hit, getting past the page takes about STALL_PACE_FACTOR of its usual
   * pages (its clean pages so far, in steps).
   */
  private stallBudget(hit: HitState): number {
    const pace = median(this.cleanPageSteps) || this.typicalPageSteps;
    const target = Math.ceil(STALL_PACE_FACTOR * pace);
    // Includes the step being taken now.
    const used = this.stepCount - hit.stepsAtHit;
    const planned = this.recoverySteps + Math.max(0, this.remaining);
    return Math.max(STALL_MIN_STEPS, target - used - planned);
  }

  /** A stubborn agent re-checks the page, then re-orients (see stallBudget). */
  private loseThread(hit: HitState): void {
    this.recoverySteps = Math.max(0, hit.intensity - 1);
    this.stallLeft = this.stallBudget(hit);
  }

  private enterStage(stage: number): void {
    this.stageIndex = stage;
    this.pageSteps = 0;
    this.remaining = this.plan.stepsPerStage[stage] ?? 2;
    this.actionIndex = 0;
    this.looped = false;
    this.loopLeft = 0;
    this.recoverySteps = 0;
    this.stallLeft = 0;
    this.loopAt = this.rng.chance(this.plan.loopRate)
      ? this.rng.int(0, Math.max(0, this.remaining - 1))
      : -1;
  }

  /** What the page shows while its hazard is on; a manually cleared hazard is gone. */
  private shown(hit: HitState, hazard: ScriptHazard): ScriptStep["disruption"] {
    if (hit.workedAround) return null;
    return { hazardType: hazard.hazardType, effectLabel: hazard.effectLabel };
  }

  private toStep(move: Move, disruption: ScriptStep["disruption"]): ScriptStep {
    const step: ScriptStep = { kind: move.kind, text: move.text, disruption };
    if (move.error) step.error = move.error;
    if (move.signature) step.signature = move.signature;
    if (move.reasoning) step.reasoning = move.reasoning;
    if (move.evidence) step.evidence = move.evidence;
    if (move.resolves) step.recovered = true;
    return step;
  }

  /** The page's normal flow: loops, random errors and productive steps. */
  private pageStep(page: SimPage, hit: HitState | null, hazard: ScriptHazard | null): ScriptStep {
    // A careful agent on the page it was sabotaged on makes no missteps.
    const focused = hit?.response === "careful";
    const shown = hit && hazard ? this.shown(hit, hazard) : null;
    if (!focused && !hazard) {
      if (this.loopLeft > 0) {
        this.loopLeft -= 1;
        return this.loopStep(page);
      }
      if (!this.looped && this.actionIndex === this.loopAt) {
        this.looped = true;
        this.loopLeft = this.rng.int(2, 3);
        return this.loopStep(page);
      }
    }

    const text = page.actions[this.actionIndex % page.actions.length] ?? `click "${page.target}"`;
    const targeted = text.includes(`"${page.target}"`);
    // The page is left through its main control, so an agent still facing the
    // hazard meets it there: when it reaches the control, and at the latest
    // on the page's last step. Getting past it clears it before the page's
    // checkpoint is claimed.
    if (hit && hazard && !hit.workedAround && (targeted || this.remaining <= 1)) {
      const control = this.controlMove(hazard, page);
      hit.workedAround = true;
      if (!control.productive) return this.toStep(control, shown);
      return this.productive(control, page, shown, true);
    }

    const reasoning = pageReasoning(text, page);
    if (!focused && this.rng.chance(this.plan.errorRate)) {
      const failure = this.rng.pick(RANDOM_FAILURES);
      const evidence: ActionEvidence = { blockedBy: failure.blockedBy };
      if (failure.blockedBy !== "timeout") evidence.target = targetForAction(text, page);
      return { kind: "error", text, error: failure.error, reasoning, evidence, disruption: shown };
    }
    return this.productive(
      { kind: "action", text, reasoning, evidence: { target: targetForAction(text, page) } },
      page,
      shown,
      targeted,
    );
  }

  private productive(
    move: Move,
    page: SimPage,
    shown: ScriptStep["disruption"],
    targeted: boolean,
  ): ScriptStep {
    this.actionIndex += 1;
    this.remaining -= 1;
    const step = this.toStep(move, shown);
    // Completing the page with its main control moves on to the next page.
    if (this.remaining === 0 && targeted) step.evidence = { ...step.evidence, navigated: true };
    return step;
  }

  private loopStep(page: SimPage): ScriptStep {
    return {
      kind: "action",
      text: `click "${page.target}" (no visible change)`,
      signature: `loop:${page.targetRole}`,
      reasoning: `The page did not seem to change, so I click "${page.target}" again.`,
      evidence: { target: primaryTarget(page.target) },
      disruption: null,
    };
  }

  /** A stubborn agent re-orienting after the hazard reverted. */
  private stallStep(page: SimPage): ScriptStep {
    const recheck: Move = {
      kind: "action",
      text: `re-check "${page.heading}" after the disruption`,
      signature: "stall:recheck",
      reasoning: `I am not sure the page is back to normal, so I check "${page.heading}" again.`,
    };
    const moves: Move[] = [
      {
        kind: "action",
        text: "re-read the task instructions",
        reasoning: "I lost track after the disruption, so I re-read the task.",
      },
      recheck,
      recheck,
      recheck,
      {
        kind: "action",
        text: `scroll back to the top of "${page.heading}"`,
        reasoning: "I scroll back to the top of the page to get my bearings.",
      },
      {
        kind: "action",
        text: "take a fresh page snapshot",
        reasoning: "I take a fresh snapshot to see where I am.",
      },
      {
        kind: "action",
        text: "navigate back to the previous page",
        reasoning: "I go back a page to retrace my steps.",
        evidence: { navigated: true },
      },
      {
        kind: "action",
        text: `return to "${page.heading}"`,
        reasoning: `I return to "${page.heading}" to try again.`,
        evidence: { navigated: true },
      },
    ];
    const move = moves[this.stallIndex % moves.length];
    this.stallIndex += 1;
    return this.toStep(move, null);
  }

  /**
   * The page's main control while its hazard is still on, for an agent that
   * reads the page (careful): the move that gets past the hazard, which
   * clears it. Productive when it also does the page's work (the real or the
   * relabelled control); otherwise the page's own step follows.
   */
  private controlMove(hazard: ScriptHazard, page: SimPage): Move & { productive: boolean } {
    const target = page.target;
    const effect = hazard.effectLabel;
    switch (hazard.hazardType) {
      case "blocking_modal":
        return { ...modalRecovery(effect), productive: false };
      case "temporary_disable":
        return { ...fillWhileDisabled(page), productive: false };
      case "rename_control":
        return {
          kind: "action",
          text: `click "${effect}" (the relabelled "${target}")`,
          reasoning: `The button where "${target}" used to be now reads "${effect}", so I click it.`,
          evidence: { target: { role: PRIMARY_ACTION_ROLE, text: effect, decoy: false } },
          resolves: true,
          productive: true,
        };
      case "insert_decoy":
        // Clicking the real control gets past the look-alike and clears the trap.
        return {
          kind: "action",
          text: `click "${target}", not the look-alike "${effect}"`,
          reasoning: `"${target}" is the control the task needs and "${effect}" only looks like it, so I click "${target}".`,
          evidence: { target: primaryTarget(target) },
          resolves: true,
          productive: true,
        };
      case "move_primary_action":
      default:
        return { ...openMoreOptions(target), productive: false };
    }
  }

  /**
   * A step spent on the hazard itself, by response and attempt. Null when the
   * agent carries on with the page (careful, or already past the hazard).
   */
  private hazardMove(hit: HitState, hazard: ScriptHazard, page: SimPage, _now: number): Move | null {
    if (hit.workedAround) return null;
    const n = hit.attempts;
    const response = hit.response;
    const target = page.target;
    const effect = hazard.effectLabel;
    switch (hazard.hazardType) {
      case "blocking_modal": {
        const blocked: Move = {
          kind: "error",
          text: `click "${target}"`,
          error: "click intercepted by an overlay",
          reasoning: `"${target}" is the next step, so I click it.`,
          evidence: { target: primaryTarget(target), blockedBy: "modal" },
        };
        const look: Move = {
          kind: "action",
          text: `inspect the "${effect}" overlay and its DOM`,
          reasoning: "An overlay with no close control covers the page, so I inspect it before repairing the DOM.",
        };
        const recover = modalRecovery(effect);
        switch (response) {
          case "careful":
            return recover;
          case "adaptive":
            if (n === 0) return blocked;
            if (n === 1) return look;
            return recover;
          case "hasty":
            if (n < 2) return blocked;
            if (n === 2) return look;
            return recover;
          default:
            return stubbornMove(n, [blocked, blocked, look], recover);
        }
      }
      case "insert_decoy": {
        const decoyClick: Move = {
          kind: "action",
          text: `click "${effect}"`,
          reasoning: `"${effect}" looks like the way forward, so I click it.`,
          evidence: { target: { role: PRIMARY_ACTION_ROLE, text: effect, decoy: true } },
        };
        const noChange: Move = {
          kind: "error",
          text: `wait for the page after clicking "${effect}"`,
          error: "timed out waiting for the next page",
          reasoning: `I clicked "${effect}", so I wait for the next page to load.`,
          evidence: { blockedBy: "timeout" },
        };
        const compare: Move = {
          kind: "action",
          text: `compare "${effect}" with "${target}"`,
          reasoning: `Two similar buttons appeared, so I compare "${effect}" with "${target}" before choosing.`,
        };
        const realClick: Move = {
          kind: "action",
          text: `click "${target}", not the look-alike "${effect}"`,
          reasoning: `"${target}" is the control the task needs and "${effect}" only looks like it, so I click "${target}".`,
          evidence: { target: primaryTarget(target), navigated: false },
          resolves: true,
        };
        const reload: Move = {
          kind: "action",
          text: "reload the page",
          reasoning: "Nothing changed after my click, so I reload the page.",
        };
        switch (response) {
          case "careful":
            return null;
          case "adaptive":
            return n === 0 ? compare : realClick;
          case "hasty":
            return n === 0 ? decoyClick : n === 1 ? noChange : realClick;
          default:
            return stubbornMove(n, [decoyClick, noChange, reload, decoyClick], realClick);
        }
      }
      case "temporary_disable": {
        const disabledClick: Move = {
          kind: "error",
          text: `click "${target}"`,
          error: "button is disabled",
          reasoning: `The form looks ready, so I click "${target}".`,
          evidence: { target: primaryTarget(target), blockedBy: "disabled" },
        };
        const wait: Move = {
          kind: "action",
          text: `wait for "${target}" to become enabled`,
          signature: `wait:${target}`,
          reasoning: `"${target}" is greyed out, so I wait for it to become enabled.`,
          evidence: { target: primaryTarget(target) },
        };
        const fillFirst = fillWhileDisabled(page);
        const recheck: Move = {
          kind: "action",
          text: "re-check the form for validation errors",
          reasoning: `"${target}" stays disabled, so I check the form for validation errors.`,
        };
        switch (response) {
          case "careful":
            return fillFirst;
          case "adaptive":
            return n === 0 ? disabledClick : fillFirst;
          case "hasty":
            return n < 2 ? disabledClick : fillFirst;
          default:
            return stubbornMove(n, [disabledClick, wait, wait, recheck], fillFirst);
        }
      }
      case "rename_control": {
        const search: Move = {
          kind: "action",
          text: `search the page for "${target}"`,
          reasoning: `I cannot see "${target}", so I search the page for it.`,
        };
        const missingClick: Move = {
          kind: "error",
          text: `click "${target}"`,
          error: "no control with that label",
          reasoning: `I click "${target}" to move on.`,
          evidence: { blockedBy: "missing" },
        };
        const renamedClick: Move = {
          kind: "action",
          text: `click "${effect}" (the relabelled "${target}")`,
          reasoning: `The button where "${target}" used to be now reads "${effect}", so I click it.`,
          evidence: { target: { role: PRIMARY_ACTION_ROLE, text: effect, decoy: false }, navigated: false },
          resolves: true,
        };
        const readCopy: Move = {
          kind: "action",
          text: "read the surrounding page copy",
          reasoning: "I read the page copy to work out which control moves me forward.",
        };
        switch (response) {
          case "careful":
            return renamedClick;
          case "adaptive":
            return n === 0 ? missingClick : renamedClick;
          case "hasty":
            return n < 2 ? missingClick : renamedClick;
          default:
            return stubbornMove(n, [search, missingClick, readCopy, missingClick], renamedClick);
        }
      }
      case "move_primary_action":
      default: {
        const hiddenClick: Move = {
          kind: "error",
          text: `click "${target}" at its usual position`,
          error: "element is not visible",
          reasoning: `I click "${target}" where it usually sits.`,
          evidence: { target: primaryTarget(target), blockedBy: "hidden" },
        };
        const scroll: Move = {
          kind: "action",
          text: `scroll to find "${target}"`,
          reasoning: `"${target}" is not where I expected, so I scroll to find it.`,
        };
        const footer: Move = {
          kind: "action",
          text: `look for "${target}" in the page footer`,
          reasoning: `"${target}" may have moved, so I look for it in the page footer.`,
        };
        const snapshot: Move = {
          kind: "action",
          text: "take a fresh page snapshot",
          reasoning: `I take a fresh look at the page to find "${target}".`,
        };
        switch (response) {
          case "careful":
            return null;
          case "adaptive":
            return n === 0 ? hiddenClick : openMoreOptions(target);
          case "hasty":
            return n < 2 ? hiddenClick : openMoreOptions(target);
          default:
            return stubbornMove(n, [hiddenClick, scroll, footer, snapshot], openMoreOptions(target));
        }
      }
    }
  }
}

function openMoreOptions(target: string): Move {
  return {
    kind: "action",
    text: `open "${MORE_ACTIONS_LABEL}"`,
    reasoning: `"${target}" is no longer in its usual place, so I look under "${MORE_ACTIONS_LABEL}".`,
    evidence: { target: { role: MORE_ACTIONS_ROLE, text: MORE_ACTIONS_LABEL, decoy: false } },
    resolves: true,
  };
}

/** The bounded DOM repair that clears a blocking overlay, which has no Close control. */
function modalRecovery(effect: string): Move {
  return {
    kind: "action",
    text: "evaluate a bounded same-page DOM recovery helper",
    reasoning: `The "${effect}" overlay blocks the page and waiting will not clear it, so I run the DOM recovery helper.`,
    resolves: true,
  };
}

/** Completing the rest of the form re-enables the disabled main control. */
function fillWhileDisabled(page: SimPage): Move {
  return {
    kind: "action",
    text: `fill in the rest of "${page.heading}" while "${page.target}" is disabled`,
    reasoning: `"${page.target}" is disabled, so I complete the rest of the form first.`,
    resolves: true,
  };
}

/**
 * A stubborn agent's attempt `n`: its misses first, then, because sabotage
 * never reverts on its own, the move that gets past the hazard.
 */
function stubbornMove(n: number, misses: readonly Move[], fix: Move): Move {
  return n < misses.length ? misses[n] : fix;
}

// ---------------------------------------------------------------------------
// Offline runs (history seeding)
// ---------------------------------------------------------------------------

/** One step of the fight's sabotage sequence, in order. */
export type ScriptSabotageStep = {
  checkpoint: number;
  hazardType: HazardType;
  durationMs: number;
  intensity: number;
};

type PageRef = { page: SimPage; stageNumber: number };

/**
 * Offsets are from the race start. A step (or crash) is taken at `t`; its
 * agent read the page at `observedT`, when its previous event ended.
 */
export type ScriptEvent =
  | ({ t: number; kind: "note"; step: number; text: string; idle: boolean } & PageRef)
  | ({ t: number; kind: "step"; step: number; entry: ScriptStep; observedT: number } & PageRef)
  | ({ t: number; kind: "crash"; step: number; entry: ScriptStep; observedT: number } & PageRef)
  | { t: number; kind: "checkpoint"; checkpoint: number }
  | { t: number; kind: "finish" };

export type OfflineRun = {
  /** In time order. */
  events: ScriptEvent[];
  checkpointAt: number[];
  finishAt: number | null;
  failAt: number | null;
  /** Offsets at which a sabotage step hit. */
  hitAt: number[];
  steps: number;
};

export type OfflineRunOptions = {
  plan: RacerPlan;
  template: SimTemplate;
  seed: string;
  sabotage: readonly ScriptSabotageStep[];
  /** From this offset hazards no longer apply (the race froze hazards). */
  freezeAtMs: number;
  /** Nothing is scripted at or after this offset. */
  horizonMs: number;
  maxSteps: number;
  /** Between a page's last step and its verified checkpoint. Default 150 ms. */
  verifyMs?: number;
};

/**
 * Runs the script against a virtual clock, applying the engine's rules: the
 * racer claims each sabotage step at its checkpoint while hazards are live,
 * and cannot report progress until the hazard has been actively cleared.
 */
export function runScriptOffline(options: OfflineRunOptions): OfflineRun {
  const { plan, template, sabotage, freezeAtMs, horizonMs, maxSteps } = options;
  const verifyMs = options.verifyMs ?? 150;
  const script = new SimRacerScript(plan, template, new Rng(options.seed));
  const events: ScriptEvent[] = [];
  const checkpointAt: number[] = [];
  const hitAt: number[] = [];
  const pageRef = (): PageRef => ({ page: script.page, stageNumber: script.stageNumber });
  let t = 0;
  let hazard: ScriptHazard | null = null;
  let nextSabotage = 0;
  const result = (finishAt: number | null, failAt: number | null): OfflineRun =>
    ({ events, checkpointAt, finishAt, failAt, hitAt, steps: script.steps });

  events.push({ t: 0, kind: "note", step: 0, text: `open ${script.page.url}`, idle: false, ...pageRef() });
  for (;;) {
    // As live, progress is claimed only once the page's hazard is cleared.
    if (script.pageDone && hazard === null) {
      const at = t + verifyMs;
      if (at >= horizonMs) return result(null, null);
      if (script.onFinishPage) {
        events.push({ t: at, kind: "finish" });
        return result(at, null);
      }
      const checkpoint = script.stage + 1;
      events.push({ t: at, kind: "checkpoint", checkpoint });
      checkpointAt.push(at);
      t = at;
      script.advance();
      const step = sabotage[nextSabotage];
      if (step && step.checkpoint === checkpoint && at < freezeAtMs) {
        nextSabotage += 1;
        hazard = {
          hazardType: step.hazardType,
          intensity: step.intensity,
          appliedAt: at,
          until: at + step.durationMs,
          effectLabel: effectLabelFor(template, step.hazardType, script.page),
        };
        hitAt.push(at);
      }
      continue;
    }

    // The agent reads the page as its previous event ends, and acts at `t`.
    const observedT = t;
    t += script.nextDelay();
    if (t >= horizonMs) return result(null, null);
    if (script.steps >= maxSteps) {
      events.push({
        t,
        kind: "note",
        step: script.steps,
        text: "Step budget exhausted; waiting for the referee",
        idle: true,
        ...pageRef(),
      });
      return result(null, null);
    }
    if (plan.failAtStep !== null && script.steps + 1 >= plan.failAtStep) {
      const ref = pageRef();
      const entry = script.crash();
      events.push({ t, kind: "crash", step: script.steps, entry, observedT, ...ref });
      return result(null, t);
    }
    const ref = pageRef();
    const entry = script.next(hazard, t);
    events.push({ t, kind: "step", step: script.steps, entry, observedT, ...ref });
    if (entry.recovered) hazard = null;
  }
}

export type HistoryScriptOptions = {
  template: SimTemplate;
  /** Racer order. */
  plans: readonly RacerPlan[];
  /** Script seed per racer, racer order. */
  seeds: readonly string[];
  sabotage: readonly ScriptSabotageStep[];
  freezeAtMs: number;
  capMs: number;
  /** A void fight must not produce a finish before the cap. */
  voided: boolean;
  maxSteps: number;
};

function fastestFinish(runs: readonly OfflineRun[]): number | null {
  const finishes = runs
    .map((run) => run.finishAt)
    .filter((finishAt): finishAt is number => finishAt !== null);
  return finishes.length > 0 ? Math.min(...finishes) : null;
}

/** Each round, a void fight's pages after the sabotage take this much longer. */
const VOID_BOG_FACTOR = 1.8;

/**
 * Offline runs for a seeded history fight, racer order. A normal fight is
 * sped up until its fastest agent finishes well before the cap (and, when
 * nobody finishes, the first agent's crash is dropped). A void fight keeps
 * its plan's pace up to the sabotage, which fires and is judged as usual,
 * then the pages from the sabotaged one on bog every agent down until nobody
 * finishes before the cap. (Slowing the whole fight instead would let agents
 * reach the sabotage checkpoint after hazards froze, unhit.) Pace changes by
 * re-running the script: hazard durations are never rescaled, so scripted
 * hazard windows always match the engine's recovery.
 */
export function scriptHistoryRuns(options: HistoryScriptOptions): OfflineRun[] {
  const horizonMs = options.capMs + 60_000;
  const runAll = (plans: readonly RacerPlan[]): OfflineRun[] => plans.map((plan, index) => runScriptOffline({
    plan,
    template: options.template,
    seed: options.seeds[index] ?? `racer-${index + 1}`,
    sabotage: options.sabotage,
    freezeAtMs: options.freezeAtMs,
    horizonMs,
    maxSteps: options.maxSteps,
  }));

  if (options.voided) {
    // The sabotage hits on the page after its checkpoint (stage index = checkpoint).
    const bogFrom = options.sabotage[0]?.checkpoint ?? 0;
    let runs = runAll(options.plans);
    let factor = 1;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const fastest = fastestFinish(runs);
      if (fastest === null || fastest >= options.capMs + 20_000) break;
      factor *= VOID_BOG_FACTOR;
      runs = runAll(options.plans.map((plan) => bogDown(plan, bogFrom, factor)));
    }
    return runs;
  }

  let plans = [...options.plans];
  let runs = runAll(plans);
  if (runs.every((run) => run.finishAt === null)) {
    plans = plans.map((plan, index) => (index === 0 ? { ...plan, failAtStep: null } : plan));
    runs = runAll(plans);
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const fastest = fastestFinish(runs);
    if (fastest === null || fastest <= options.capMs - 20_000) break;
    const factor = (options.capMs - 50_000) / fastest;
    plans = plans.map((plan) => ({ ...plan, speed: plan.speed * factor }));
    runs = runAll(plans);
  }
  return runs;
}

/** The plan with every page from `stage` on (the finish page included) `factor` times longer. */
function bogDown(plan: RacerPlan, stage: number, factor: number): RacerPlan {
  return {
    ...plan,
    stepsPerStage: plan.stepsPerStage.map((steps, index) => (index >= stage ? Math.ceil(steps * factor) : steps)),
  };
}
