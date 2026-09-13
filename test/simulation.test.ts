import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActionReport, CapturedFrame, CompetitorContext } from "../src/application/contracts.js";
import { validateDisruptionCommand } from "../src/infra/cdp-obstacle-provider.js";
import { HAZARD_TYPES, SABOTAGE_DETAIL_MAX, SABOTAGE_SUMMARY_MAX } from "../src/domain/sabotage.js";
import {
  SIM_TEMPLATES,
  fitTemplate,
  pageAfterCheckpoint,
  templateForCourse,
  type SimTemplate,
} from "../src/simulation/catalogue.js";
import { SIM_AGENT_ROSTER } from "../src/simulation/factory.js";
import { escapeXml, renderSimFrame } from "../src/simulation/frames.js";
import { planFight, planTimeline, type RacerPlan } from "../src/simulation/plan.js";
import { Rng, hashString } from "../src/simulation/rng.js";
import { InertCompetitorRunner, SimulatedCompetitorRunner } from "../src/simulation/runner.js";
import {
  STALL_PACE_FACTOR,
  SimRacerScript,
  chooseResponse,
  runScriptOffline,
  scriptHistoryRuns,
  targetForAction,
  type ScriptEvent,
  type ScriptHazard,
  type ScriptStep,
} from "../src/simulation/script.js";
import { SimulatedObstacleExecutor, SimulatedWorld, scaleDurationMs } from "../src/simulation/world.js";

const RACERS = SIM_AGENT_ROSTER.map((agent, index) => ({ racerId: `racer-${index + 1}`, key: agent.key }));

test("catalogue templates respect the UI and contract bounds", () => {
  assert.ok(SIM_TEMPLATES.length >= 8);
  const ids = new Set<string>();
  for (const template of SIM_TEMPLATES) {
    assert.ok(!ids.has(template.id), `duplicate id ${template.id}`);
    ids.add(template.id);
    assert.ok(template.title.length <= 90, `${template.id} title too long`);
    assert.ok(template.task.length > 0 && template.taskDetail.length > 0 && template.successCondition.length > 0);
    assert.ok(template.stages.length >= 3 && template.stages.length <= 5, `${template.id} stage count`);
    for (const page of [...template.stages, template.finish]) {
      assert.match(page.url, /^https:\/\/[a-z]+\.arena\.test\//, `${template.id} url ${page.url}`);
      assert.ok(page.actions.length > 0 && page.target.length > 0 && page.targetRole.length > 0);
    }
    assert.equal(new Set(template.stages.map((stage) => stage.label)).size, template.stages.length);

    const sabotage = template.sabotage;
    assert.ok(sabotage.summary.length <= SABOTAGE_SUMMARY_MAX, `${template.id} summary ${sabotage.summary.length}`);
    assert.ok(sabotage.detail.length <= SABOTAGE_DETAIL_MAX, `${template.id} detail too long`);
    assert.ok(Number.isInteger(sabotage.checkpoint));
    assert.ok(sabotage.checkpoint >= 1 && sabotage.checkpoint <= template.stages.length);
    assert.ok(HAZARD_TYPES.includes(sabotage.policy.hazardType));
    validateDisruptionCommand(sabotage.policy);
    // The policy aims at the control the agent needs right after the checkpoint.
    assert.equal(
      sabotage.policy.targetRole,
      pageAfterCheckpoint(template, sabotage.checkpoint).targetRole,
      `${template.id} sabotage target`,
    );
    assert.equal(templateForCourse(`sim-${template.id}`), template);
  }
  assert.ok(new Set(SIM_TEMPLATES.map((template) => template.sabotage.policy.hazardType)).size === HAZARD_TYPES.length);
});

test("fitTemplate adapts a template to other checkpoint labels", () => {
  const template = SIM_TEMPLATES[0];
  const fitted = fitTemplate(template, ["A", "B"]);
  assert.deepEqual(fitted.stages.map((stage) => stage.label), ["A", "B"]);
  assert.ok(fitted.sabotage.checkpoint <= 2);
  const longer = fitTemplate(template, ["1", "2", "3", "4", "5", "6"]);
  assert.equal(longer.stages.length, 6);
  assert.match(longer.stages[5].url, /^https:\/\/shop\.arena\.test\/step-6$/);
});

test("rng is deterministic per seed and helpers stay in range", () => {
  const left = new Rng("seed-a");
  const right = new Rng("seed-a");
  const other = new Rng("seed-b");
  const a = Array.from({ length: 20 }, () => left.float());
  const b = Array.from({ length: 20 }, () => right.float());
  const c = Array.from({ length: 20 }, () => other.float());
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(hashString("abc"), hashString("abc"));

  const rng = new Rng("ranges");
  for (let index = 0; index < 500; index += 1) {
    const value = rng.range(2, 5);
    assert.ok(value >= 2 && value < 5);
    const int = rng.int(1, 3);
    assert.ok(Number.isInteger(int) && int >= 1 && int <= 3);
    assert.ok(["x", "y"].includes(rng.pick(["x", "y"])));
  }
  assert.equal(new Rng("h").hex(6).length, 6);
  assert.match(new Rng("h").hex(6), /^[0-9a-f]{6}$/);
  assert.equal(new Rng("w").weighted(["a", "b"], (item) => (item === "b" ? 1 : 0)), "b");
  assert.deepEqual(new Rng("f").fork("x").float(), new Rng("f/x").float());
});

test("fight plans are deterministic and vary skill per fight", () => {
  const first = planFight("fight-1", RACERS, 4);
  assert.deepEqual(planFight("fight-1", RACERS, 4), first);
  for (const plan of Object.values(first.racers)) {
    assert.equal(plan.stepsPerStage.length, 5);
    assert.ok(plan.stepsPerStage.every((steps) => steps >= 1));
  }
  // Across many fights, every agent is the fastest at least once.
  const fastest = new Set<string>();
  for (let index = 0; index < 60; index += 1) {
    const plan = planFight(`fight-${index}`, RACERS, 4, { difficulty: "normal" });
    const totals = RACERS.map(({ racerId, key }) => ({
      key,
      steps: plan.racers[racerId].stepsPerStage.reduce((sum, steps) => sum + steps, 0) *
        plan.racers[racerId].speed,
    }));
    totals.sort((left, right) => left.steps - right.steps);
    fastest.add(totals[0].key);
  }
  assert.equal(fastest.size, 4);

  // At timeScale 1, normal fights mostly finish between ~70 and ~170 s.
  const winners: number[] = [];
  for (let index = 0; index < 40; index += 1) {
    const plan = planFight(`timing-${index}`, RACERS, 4, { difficulty: "normal" });
    const rng = new Rng(`timing-${index}`);
    const finishes = RACERS
      .map(({ racerId }) => planTimeline({ ...plan.racers[racerId], failAtStep: null }, rng, null).finishAt)
      .filter((value): value is number => value !== null);
    winners.push(Math.min(...finishes));
  }
  const inBand = winners.filter((ms) => ms >= 60_000 && ms <= 180_000).length;
  assert.ok(inBand >= 34, `only ${inBand}/40 winners in band: ${winners.join(",")}`);
  const brutal = planFight("brutal", RACERS, 4, { difficulty: "brutal" });
  const brutalFinish = Math.min(...RACERS.map(({ racerId }) =>
    planTimeline({ ...brutal.racers[racerId], failAtStep: null }, new Rng(racerId), null).finishAt ?? Infinity));
  assert.ok(brutalFinish > 250_000, `brutal fight finished at ${brutalFinish}`);
});

/** Minimal XML well-formedness check: balanced tags, quoted attributes, no raw `&`. */
function assertWellFormedSvg(svg: string): void {
  assert.ok(svg.startsWith("<svg "), "starts with <svg");
  assert.ok(svg.endsWith("</svg>"), "ends with </svg>");
  assert.match(svg, /viewBox="0 0 1280 800"/);
  assert.doesNotMatch(svg, /&(?!(amp|lt|gt|quot|apos);)/, "unescaped ampersand");
  const stack: string[] = [];
  const tagPattern = /<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z:-]+="[^"<]*")*)\s*(\/?)>/g;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(svg)) !== null) {
    const between = svg.slice(consumed, match.index);
    assert.doesNotMatch(between, /[<>]/, `stray markup near ${between.slice(0, 40)}`);
    consumed = match.index + match[0].length;
    const [, closing, name, , selfClosing] = match;
    if (closing) {
      assert.equal(stack.pop(), name, `mismatched </${name}>`);
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  assert.equal(consumed, svg.length, "trailing content");
  assert.deepEqual(stack, []);
}

test("renderSimFrame produces a small, well-formed, escaped SVG for every layout and hazard", () => {
  const template = SIM_TEMPLATES[0];
  const hostile = { ...template.stages[0], heading: "Tom & Jerry's <script>\"quotes\"</script>" };
  const hazards = [null, ...HAZARD_TYPES];
  const layouts = new Set(SIM_TEMPLATES.flatMap((item) => [...item.stages, item.finish].map((page) => page.layout)));
  assert.ok(layouts.size >= 6);
  for (const item of SIM_TEMPLATES) {
    for (const page of [...item.stages, item.finish, hostile]) {
      for (const hazard of hazards) {
        const svg = renderSimFrame({
          brand: item.brand,
          page,
          stageNumber: 2,
          stageCount: item.stages.length,
          stageLabel: "Cart & <review>",
          agentKey: "claude",
          agentName: "Claude Opus 4.6",
          step: 12,
          maxSteps: 90,
          action: "click \"Proceed\" & <wait>",
          disruption: hazard ? { hazardType: hazard, effectLabel: "Express <checkout> & more" } : null,
          status: "working",
        });
        assertWellFormedSvg(svg);
        assert.ok(Buffer.byteLength(svg) < 30_000, `frame is ${Buffer.byteLength(svg)} bytes`);
        assert.ok(svg.includes("#e8c07a"), "agent colour highlights the target");
      }
    }
  }
  assert.equal(escapeXml("a&b<c>\"d'"), "a&amp;b&lt;c&gt;&quot;d&apos;");
});

function runnerContext(
  racerId: string,
  sink: { actions: AgentActionReport[]; frames: CapturedFrame[]; checkpoints: number[]; finished: boolean },
): CompetitorContext {
  return {
    raceId: "race-sim",
    racerId,
    courseId: "sim-ssd-checkout",
    seed: "seed",
    checkpointCount: 4,
    session: { racerId, steelSessionId: "sim-1" },
    async reportCheckpoint(checkpoint) {
      sink.checkpoints.push(checkpoint);
    },
    async reportFinish() {
      sink.finished = true;
    },
    reportAction(report) {
      sink.actions.push(report);
    },
    reportFrame(frame) {
      sink.frames.push(frame);
    },
  };
}

test("simulated runner reports actions and frames, advances checkpoints and finishes", async () => {
  const template = SIM_TEMPLATES[0];
  const world = new SimulatedWorld(2_000);
  const plan = planFight("runner-finish", RACERS, template.stages.length, { difficulty: "normal" });
  plan.racers["racer-1"] = { ...plan.racers["racer-1"], failAtStep: null };
  const runner = new SimulatedCompetitorRunner({
    template,
    world,
    plan,
    agents: { "racer-1": SIM_AGENT_ROSTER[0] },
    timeScale: 2_000,
    seed: "runner-finish",
  });
  const sink = { actions: [] as AgentActionReport[], frames: [] as CapturedFrame[], checkpoints: [] as number[], finished: false };
  const context = runnerContext("racer-1", sink);
  await runner.prepare(context);
  await runner.run(context);
  assert.deepEqual(sink.checkpoints, [1, 2, 3, 4]);
  assert.equal(sink.finished, true);
  assert.ok(sink.actions.length > 10);
  const steps = sink.actions.filter((report) => report.kind !== "note").map((report) => report.step);
  assert.deepEqual(steps, steps.map((_, index) => index + 1), "steps increase by one");
  assert.ok(sink.actions.every((report) => report.url?.startsWith("https://shop.arena.test/")));
  assert.ok(sink.frames.length >= sink.actions.length);
  assert.ok(sink.frames.every((frame) => frame.contentType === "image/svg+xml"));
  assert.deepEqual(runner.activeRacers(), []);
  // Every step carries browser evidence; without sabotage nothing is a decoy.
  const steps2 = sink.actions.filter((report) => report.kind !== "note");
  assert.ok(steps2.every((report) => report.evidence !== undefined));
  assert.ok(steps2.every((report) => report.evidence?.target?.decoy !== true));
  assert.ok(steps2.some((report) => report.evidence?.target?.role === "primary-action"));
});

test("disrupted runners report blocked steps against the sabotage", async () => {
  const template = SIM_TEMPLATES[1];
  // 12 s modal / 200 = 60 ms (sim policies carry the scaled duration), several 12-30 ms steps.
  const world = new SimulatedWorld(200);
  const scaledPolicy = {
    ...template.sabotage.policy,
    durationMs: scaleDurationMs(template.sabotage.policy.durationMs, 200),
  };
  const executor = new SimulatedObstacleExecutor(world, "exec");
  const plan = planFight("runner-disrupt", RACERS, template.stages.length, { difficulty: "normal" });
  // Stubborn (never careful, never composed): it must actively clear the
  // persistent modal before it can resume.
  plan.racers["racer-2"] = { ...plan.racers["racer-2"], failAtStep: null, vigilance: 0, composure: 0 };
  const runner = new SimulatedCompetitorRunner({
    template,
    world,
    plan,
    agents: { "racer-2": SIM_AGENT_ROSTER[1] },
    timeScale: 200,
    seed: "runner-disrupt",
  });
  const sink = { actions: [] as AgentActionReport[], frames: [] as CapturedFrame[], checkpoints: [] as number[], finished: false };
  const context = runnerContext("racer-2", sink);
  context.reportCheckpoint = async (checkpoint) => {
    sink.checkpoints.push(checkpoint);
    if (checkpoint === template.sabotage.checkpoint) {
      assert.deepEqual(await executor.apply("racer-2", scaledPolicy), { applied: true });
    }
  };
  await runner.run(context);
  assert.equal(sink.finished, true);
  const blocked = sink.actions.filter((report) =>
    report.text.includes("modal") || report.text.includes("overlay") || report.error?.includes("overlay"));
  assert.ok(blocked.length >= 1, "blocked steps were reported");
  assert.ok(sink.actions.some((report) => report.text.includes("DOM recovery helper")));
  assert.ok(sink.frames.some((frame) => String(frame.body).includes("SABOTAGE")));
  assert.ok(sink.actions.some((report) =>
    report.kind === "error" && report.evidence?.blockedBy === "modal" &&
    report.evidence.target?.role === "primary-action"), "the overlay is named as the blocker");
});

test("runner stop() aborts promptly and leaves no pending loop", async () => {
  const template = SIM_TEMPLATES[2];
  const runner = new SimulatedCompetitorRunner({
    template,
    world: new SimulatedWorld(1),
    plan: planFight("runner-stop", RACERS, template.stages.length),
    agents: {},
    timeScale: 1,
    seed: "runner-stop",
  });
  const sink = { actions: [] as AgentActionReport[], frames: [] as CapturedFrame[], checkpoints: [] as number[], finished: false };
  const started = Date.now();
  const running = runner.run(runnerContext("racer-3", sink));
  assert.deepEqual(runner.activeRacers(), ["racer-3"]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await runner.stop("racer-3");
  await running;
  assert.ok(Date.now() - started < 1_000, "stop did not wait for the 2.5 s step");
  assert.deepEqual(runner.activeRacers(), []);
  assert.equal(sink.finished, false);

  // Stopping before run() makes run() return immediately.
  await runner.stop("racer-4");
  await runner.run(runnerContext("racer-4", sink));

  const inert = new InertCompetitorRunner();
  const pending = inert.run(runnerContext("racer-1", sink));
  assert.deepEqual(inert.pendingRacers(), ["racer-1"]);
  await inert.stop("racer-1");
  await pending;
  assert.deepEqual(inert.pendingRacers(), []);
});

test("sim policies retain scaled duration metadata until explicitly cleared", async () => {
  let clock = 1_000;
  const world = new SimulatedWorld(10, () => clock);
  const executor = new SimulatedObstacleExecutor(world, "seed");
  const policy = await executor.getPolicy("race", 2);
  assert.ok(policy);
  validateDisruptionCommand(policy);
  // 6-14 s of real time at 10x.
  assert.ok(policy.durationMs >= 600 && policy.durationMs <= 1_400, String(policy.durationMs));
  assert.equal(scaleDurationMs(8_000, 10), 800);
  await executor.apply("racer-1", { hazardType: "blocking_modal", targetRole: "x", durationMs: 800, intensity: 2 });
  assert.equal(world.disruption("racer-1")?.until, 1_800);
  clock = 1_799;
  assert.ok(world.disruption("racer-1"));
  clock = 1_800;
  assert.ok(world.disruption("racer-1"), "elapsed time does not clear sabotage");
  world.clear("racer-1");
  assert.equal(world.disruption("racer-1"), null);
});

// ---------------------------------------------------------------------------
// Scripted behaviour and browser evidence (script.ts)
// ---------------------------------------------------------------------------

function templateById(id: string): SimTemplate {
  const template = SIM_TEMPLATES.find((item) => item.id === id);
  assert.ok(template, id);
  return template;
}

function scriptPlan(template: SimTemplate, overrides: Partial<RacerPlan> = {}): RacerPlan {
  return {
    racerId: "racer-1",
    key: "gpt",
    speed: 1,
    stepsPerStage: [...template.stages.map(() => 4), 2],
    errorRate: 0,
    loopRate: 0,
    failAtStep: null,
    ...overrides,
  };
}

/** A script standing on the page right after `checkpoint`. */
function scriptAfter(
  template: SimTemplate,
  checkpoint: number,
  overrides: Partial<RacerPlan> = {},
): SimRacerScript {
  const script = new SimRacerScript(scriptPlan(template, overrides), template, new Rng(`script/${template.id}`));
  for (let page = 0; page < checkpoint; page += 1) {
    while (!script.pageDone) script.next(null, 0);
    script.advance();
  }
  return script;
}

/** The template's own sabotage, applied at t = 1 s. */
function hazardOf(template: SimTemplate, overrides: Partial<ScriptHazard> = {}): ScriptHazard {
  return {
    hazardType: template.sabotage.policy.hazardType,
    intensity: template.sabotage.policy.intensity,
    appliedAt: 1_000,
    until: 1_000 + template.sabotage.policy.durationMs,
    effectLabel: template.sabotage.effectLabel,
    ...overrides,
  };
}

/** Steps one second apart, with the hazard on while it lasts, until the page is done. */
function runPage(script: SimRacerScript, hazard: ScriptHazard | null): ScriptStep[] {
  const steps: ScriptStep[] = [];
  for (let t = 2_000; !script.pageDone && steps.length < 200; t += 1_000) {
    steps.push(script.next(hazard && t < hazard.until ? hazard : null, t));
  }
  return steps;
}

const ADAPTIVE = { vigilance: 0, composure: 1, haste: 0 };

test("hazard responses follow the plan's traits, which vary per fight", () => {
  const rng = new Rng("responses");
  assert.equal(chooseResponse({ vigilance: 1 }, rng), "careful");
  assert.equal(chooseResponse({ vigilance: 0, composure: 0 }, rng), "stubborn");
  assert.equal(chooseResponse({ vigilance: 0, composure: 1, haste: 1 }, rng), "hasty");
  assert.equal(chooseResponse({ vigilance: 0, composure: 1, haste: 0 }, rng), "adaptive");
  const seen = new Set<string>();
  for (let index = 0; index < 40; index += 1) {
    for (const racer of Object.values(planFight(`traits-${index}`, RACERS, 4).racers)) {
      assert.ok(racer.vigilance !== undefined && racer.composure !== undefined && racer.haste !== undefined);
      seen.add(chooseResponse(racer, new Rng(`traits-${index}/${racer.racerId}`)));
    }
  }
  assert.deepEqual([...seen].sort(), ["adaptive", "careful", "hasty", "stubborn"]);
});

test("normal steps carry a plausible target that is never a decoy", () => {
  const template = templateById("ssd-checkout");
  const cart = template.stages[2];
  const target = (role: string | null, text: string | null) => ({ role, text, decoy: false });
  assert.deepEqual(targetForAction(`click "${cart.target}"`, cart), target("primary-action", cart.target));
  assert.deepEqual(targetForAction("fill Full name: Arena Tester", cart), target("textbox", "Full name"));
  assert.deepEqual(targetForAction("type \"1tb usb-c ssd\" into the search box", cart), target("textbox", "search box"));
  assert.deepEqual(targetForAction("select Topic: Billing", cart), target("combobox", "Topic"));
  assert.deepEqual(targetForAction("open \"Kinetic X1\"", cart), target("link", "Kinetic X1"));
  assert.deepEqual(targetForAction("read the order subtotal: $84.99", cart), target(null, null));

  // The cart page ends on its main control, which moves on to the next page.
  const steps = runPage(scriptAfter(template, 2), null);
  assert.ok(steps.every((step) => step.kind === "action" && step.evidence?.target?.decoy === false));
  assert.deepEqual(steps.at(-1)?.evidence, { target: target("primary-action", cart.target), navigated: true });
});

test("a careful agent actively recovers a blocking modal at once and makes no missteps on that page", () => {
  const template = templateById("boot-exchange");
  // Random errors would be likely on any other page.
  const script = scriptAfter(template, template.sabotage.checkpoint, { vigilance: 1, errorRate: 0.5 });
  const steps = runPage(script, hazardOf(template));
  assert.equal(steps[0].text, "evaluate a bounded same-page DOM recovery helper");
  assert.equal(steps[0].evidence, undefined);
  assert.ok(steps[0].disruption, "the overlay was on screen when it acted");
  assert.ok(steps.every((step) => step.kind === "action"), "no errors after the hit");
  assert.ok(steps.slice(1).every((step) => step.disruption === null), "the closed overlay is gone");
});

test("a hasty agent clicks the planted decoy; a careful one clicks the real control", () => {
  const template = templateById("ssd-checkout");
  const page = pageAfterCheckpoint(template, template.sabotage.checkpoint);
  const decoyText = template.sabotage.effectLabel;
  const hasty = runPage(
    scriptAfter(template, template.sabotage.checkpoint, { vigilance: 0, composure: 1, haste: 1 }),
    hazardOf(template),
  );
  assert.equal(hasty[0].text, `click "${decoyText}"`);
  assert.deepEqual(hasty[0].evidence?.target, { role: "primary-action", text: decoyText, decoy: true });
  assert.deepEqual([hasty[1].kind, hasty[1].evidence?.blockedBy], ["error", "timeout"]);
  assert.deepEqual(hasty[2].evidence?.target, { role: "primary-action", text: page.target, decoy: false });
  assert.equal(hasty.filter((step) => step.evidence?.target?.decoy).length, 1);

  // The decoy stays up for the whole page: a careful agent reads the labels.
  const careful = runPage(
    scriptAfter(template, template.sabotage.checkpoint, { vigilance: 1 }),
    hazardOf(template, { until: 1_000_000 }),
  );
  assert.ok(careful.every((step) => step.kind === "action" && step.evidence?.target?.decoy !== true));
  const real = careful.find((step) => step.text.includes("not the look-alike"));
  assert.deepEqual(real?.evidence?.target, { role: "primary-action", text: page.target, decoy: false });
});

test("evidence names the block until an adaptive agent works around it", () => {
  const move = templateById("library-renewal");
  const moveSteps = runPage(scriptAfter(move, move.sabotage.checkpoint, ADAPTIVE), hazardOf(move, { until: 1_000_000 }));
  const opened = moveSteps.findIndex((step) => step.evidence?.target?.role === "more-actions");
  assert.ok(opened > 0, "opens More options after a miss");
  assert.equal(moveSteps[opened].text, "open \"More options\"");
  assert.ok(moveSteps.slice(0, opened).every((step) => step.kind === "error" && step.evidence?.blockedBy === "hidden"));
  assert.ok(moveSteps.slice(opened).every((step) => step.kind === "action"));

  const disable = templateById("support-refund");
  const disableSteps = runPage(scriptAfter(disable, disable.sabotage.checkpoint, ADAPTIVE), hazardOf(disable));
  assert.deepEqual([disableSteps[0].kind, disableSteps[0].evidence?.blockedBy], ["error", "disabled"]);
  assert.deepEqual(
    disableSteps[0].evidence?.target,
    { role: "primary-action", text: pageAfterCheckpoint(disable, disable.sabotage.checkpoint).target, decoy: false },
  );
  assert.ok(disableSteps.slice(1).every((step) => step.kind === "action"), "it waits instead of clicking again");

  const rename = templateById("garden-rsvp");
  const renameSteps = runPage(scriptAfter(rename, rename.sabotage.checkpoint, ADAPTIVE), hazardOf(rename));
  assert.deepEqual([renameSteps[0].kind, renameSteps[0].evidence?.blockedBy], ["error", "missing"]);
  assert.equal(renameSteps[1].kind, "action", "the relabelled control works");
  assert.deepEqual(renameSteps[1].evidence?.target, { role: "primary-action", text: "Decline", decoy: false });
});

test("a stubborn agent hammers the blocked control, then stalls about 3x its usual page", () => {
  const template = templateById("flight-sea");
  const script = scriptAfter(template, template.sabotage.checkpoint, { vigilance: 0, composure: 0 });
  const steps = runPage(script, hazardOf(template, { intensity: 2, until: 3_500 }));
  assert.deepEqual(
    steps.slice(0, 2).map((step) => [step.kind, step.evidence?.blockedBy]),
    [["error", "modal"], ["error", "modal"]],
  );
  assert.ok(steps.some((step) => step.text.startsWith("resume:")));
  assert.ok(steps.some((step) => step.signature === "stall:recheck"));
  // Its clean pages took 4 steps: getting past this one takes over three times that.
  assert.ok(steps.length >= 3 * 4, `${steps.length} steps`);
  assert.ok(steps.length <= Math.ceil(STALL_PACE_FACTOR * 4) + 1, `${steps.length} steps`);
});

test("offline runs follow the engine: progress waits for active recovery, frozen races apply none", () => {
  const template = templateById("ssd-checkout");
  const sabotage = [{ checkpoint: 2, hazardType: "insert_decoy" as const, durationMs: 60_000, intensity: 2 }];
  const plan = scriptPlan(template, { vigilance: 0, composure: 1, haste: 1 });
  const base = { plan, template, seed: "offline", sabotage, freezeAtMs: 1_000_000, horizonMs: 2_000_000, maxSteps: 90 };
  const isStep = (event: ScriptEvent): event is Extract<ScriptEvent, { kind: "step" }> => event.kind === "step";

  const run = runScriptOffline(base);
  assert.deepEqual(run.hitAt, [run.checkpointAt[1]]);
  const recovery = run.events.find((event): event is Extract<ScriptEvent, { kind: "step" }> =>
    isStep(event) && event.entry.recovered === true);
  assert.ok(recovery, "the script explicitly clears the persistent hazard");
  assert.ok(run.checkpointAt[2] >= recovery.t, "progress follows active recovery");
  assert.ok(run.finishAt !== null && run.finishAt > run.checkpointAt[3]);
  const times = run.events.map((event) => event.t);
  assert.deepEqual(times, [...times].sort((left, right) => left - right));
  const decoyClicks = run.events.filter(isStep).filter((event) => event.entry.evidence?.target?.decoy);
  assert.ok(decoyClicks.length > 0 && decoyClicks.every((event) => event.t > run.hitAt[0]));

  const frozen = runScriptOffline({ ...base, freezeAtMs: 1 });
  assert.deepEqual(frozen.hitAt, []);
  assert.ok(frozen.events.filter(isStep).every((event) => event.entry.disruption === null));

  const crashed = runScriptOffline({ ...base, plan: { ...plan, failAtStep: 5 } });
  assert.equal(crashed.events.at(-1)?.kind, "crash");
  assert.deepEqual([crashed.finishAt, crashed.steps], [null, 5]);
  assert.ok(crashed.failAt !== null);

  const exhausted = runScriptOffline({ ...base, maxSteps: 6 });
  const last = exhausted.events.at(-1);
  assert.ok(last?.kind === "note" && last.idle, "the budget runs out");
  assert.equal(exhausted.finishAt, null);
});

test("history runs finish well before the cap, and void runs never finish before it", () => {
  const template = templateById("ssd-checkout");
  const sabotage = [{ checkpoint: 2, hazardType: "insert_decoy" as const, durationMs: 9_000, intensity: 2 }];
  const options = { template, sabotage, freezeAtMs: 180_000, capMs: 300_000, maxSteps: 90 };
  for (const [index, seed] of ["history-1", "history-2", "history-3"].entries()) {
    const seeds = RACERS.map(({ racerId }) => `${seed}/${racerId}`);
    const fair = planFight(seed, RACERS, template.stages.length, { difficulty: index === 2 ? "hard" : "normal" });
    const runs = scriptHistoryRuns({ ...options, seeds, voided: false, plans: RACERS.map(({ racerId }) => fair.racers[racerId]) });
    const finishes = runs.map((run) => run.finishAt).filter((at): at is number => at !== null);
    assert.ok(finishes.length > 0 && Math.min(...finishes) <= 280_000, `${seed}: ${finishes.join(",")}`);

    const brutal = planFight(seed, RACERS, template.stages.length, { difficulty: "brutal" });
    const voided = scriptHistoryRuns({ ...options, seeds, voided: true, plans: RACERS.map(({ racerId }) => brutal.racers[racerId]) });
    assert.ok(voided.every((run) => run.finishAt === null || run.finishAt >= 320_000), seed);
  }
});
