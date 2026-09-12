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
} from "../src/simulation/catalogue.js";
import { SIM_AGENT_ROSTER } from "../src/simulation/factory.js";
import { escapeXml, renderSimFrame } from "../src/simulation/frames.js";
import { planFight, planTimeline } from "../src/simulation/plan.js";
import { Rng, hashString } from "../src/simulation/rng.js";
import { InertCompetitorRunner, SimulatedCompetitorRunner } from "../src/simulation/runner.js";
import { SimulatedObstacleExecutor, SimulatedWorld } from "../src/simulation/world.js";

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
});

test("disrupted runners report blocked steps against the sabotage", async () => {
  const template = SIM_TEMPLATES[1];
  // 12 s modal / 200 = 60 ms, several 12-30 ms steps.
  const world = new SimulatedWorld(200);
  const executor = new SimulatedObstacleExecutor(world, "exec");
  const plan = planFight("runner-disrupt", RACERS, template.stages.length, { difficulty: "normal" });
  plan.racers["racer-2"] = { ...plan.racers["racer-2"], failAtStep: null };
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
      assert.deepEqual(await executor.apply("racer-2", template.sabotage.policy), { applied: true });
    }
  };
  await runner.run(context);
  assert.equal(sink.finished, true);
  const blocked = sink.actions.filter((report) =>
    report.text.includes("modal") || report.text.includes("overlay") || report.error?.includes("overlay"));
  assert.ok(blocked.length >= 1, "blocked steps were reported");
  assert.ok(sink.actions.some((report) => report.text.startsWith("resume:")));
  assert.ok(sink.frames.some((frame) => String(frame.body).includes("SABOTAGE")));
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

test("obstacle executor disrupts for durationMs / timeScale", async () => {
  let clock = 1_000;
  const world = new SimulatedWorld(10, () => clock);
  const executor = new SimulatedObstacleExecutor(world, "seed");
  const policy = await executor.getPolicy("race", 2);
  assert.ok(policy);
  validateDisruptionCommand(policy);
  await executor.apply("racer-1", { hazardType: "blocking_modal", targetRole: "x", durationMs: 8_000, intensity: 2 });
  assert.equal(world.disruption("racer-1")?.until, 1_800);
  clock = 1_799;
  assert.ok(world.disruption("racer-1"));
  clock = 1_800;
  assert.equal(world.disruption("racer-1"), null);
});
