/**
 * Real-browser checks that each hazard changes what a DOM-driven competitor's
 * `[data-arena-role]` locator resolves to, and reverts only after recovery.
 * Skipped when Playwright's Chromium cannot launch on this machine.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import {
  PlaywrightCompetitorRunner,
  type AgentDecision,
  type CompetitorDecisionModel,
} from "../src/agents/playwright-competitor-runner.js";
import type { AgentActionReport } from "../src/application/contracts.js";
import type { DisruptionCommand } from "../src/domain/types.js";
import { buildDisruptionScript, DECOY_ID_PREFIX } from "../src/infra/cdp-obstacle-provider.js";

let browser: Browser | undefined;
try {
  browser = await chromium.launch({ timeout: 30_000 });
} catch {
  browser = undefined;
}
after(async () => {
  await browser?.close();
});

/** `test`, or `test.skip` when Chromium is unavailable. */
function browserTest(name: string, fn: () => Promise<void>): void {
  if (browser) test(name, fn);
  else test.skip(`${name} (Chromium unavailable)`, fn);
}

const ROLE = "primary-action";
const SELECTOR = `[data-arena-role="${ROLE}"]`;
const REAL_LABEL = "Complete checkpoint 2";
const COURSE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Hazard course</title>
<style>button { padding: 12px 20px; font: 16px sans-serif; }</style></head>
<body>
  <main id="course">
    <h1>Checkout</h1>
    <p>Step 2 of 4</p>
    <div id="actions"><button type="button" class="cta" id="checkpoint" data-arena-role="${ROLE}"><span>Complete</span> checkpoint 2</button></div>
  </main>
  <script>
    window.clicks = 0;
    document.getElementById("checkpoint").addEventListener("click", () => { window.clicks += 1; });
  </script>
</body>
</html>`;

type ApplyResult = { applied: boolean; reason?: string; disruptionId?: string };

async function openCourse(html = COURSE_HTML): Promise<Page> {
  const page = await browser!.newPage();
  await page.setContent(html);
  return page;
}

function hazard(
  hazardType: DisruptionCommand["hazardType"],
  intensity: number,
  durationMs: number,
): DisruptionCommand {
  return { hazardType, targetRole: ROLE, durationMs, intensity };
}

function applyHazard(
  page: Page,
  command: DisruptionCommand,
  id: string,
  options: { externalSite?: boolean } = {},
): Promise<ApplyResult> {
  return page.evaluate<ApplyResult>(buildDisruptionScript(command, id, options));
}

function revertHazard(page: Page, id: string): Promise<void> {
  return page.evaluate((disruptionId) => {
    (window as unknown as { __arenaDisruptions: Record<string, { revert(): void }> })
      .__arenaDisruptions[disruptionId].revert();
  }, id);
}

function clicks(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { clicks: number }).clicks);
}

function bodyHtml(page: Page): Promise<string> {
  return page.evaluate(() => document.body.outerHTML);
}

function containerHtml(page: Page): Promise<string> {
  return page.locator("#actions").evaluate((element) => element.outerHTML);
}

/** Polls until the body is byte-identical to `original` (the hazard reverted). */
async function waitForRevert(page: Page, original: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let current = await bodyHtml(page);
  while (current !== original && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = await bodyHtml(page);
  }
  assert.equal(current, original);
}

async function clickFailure(page: Page, selector: string, timeout = 400): Promise<{ message: string; elapsed: number }> {
  const started = Date.now();
  try {
    await page.locator(selector).first().click({ timeout });
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error), elapsed: Date.now() - started };
  }
  throw new Error(`clicking ${selector} unexpectedly succeeded`);
}

browserTest("insert_decoy plants a same-role clone first in document order that does nothing", async () => {
  const page = await openCourse();
  try {
    const originalBody = await bodyHtml(page);
    const originalContainer = await containerHtml(page);
    const id = "disruption-race-1-racer-1-0-plant-decoy-control";
    assert.deepEqual(await applyHazard(page, hazard("insert_decoy", 1, 1_500), id), {
      applied: true,
      disruptionId: id,
    });

    const matches = page.locator(SELECTOR);
    assert.equal(await matches.count(), 2);
    const first = matches.first();
    assert.equal(await first.getAttribute("data-arena-decoy"), "true");
    assert.equal(await first.getAttribute("data-arena-role"), ROLE);
    assert.equal(await first.innerText(), "Continue");
    const decoyId = await first.getAttribute("id") ?? "";
    assert.ok(decoyId.startsWith(DECOY_ID_PREFIX), decoyId);
    assert.match(decoyId, /^[A-Za-z0-9_-]+$/);
    assert.equal(await page.locator(`#${decoyId}`).count(), 1);

    await first.click({ timeout: 1_000 });
    assert.equal(await clicks(page), 0, "the decoy click did nothing");
    await matches.filter({ hasText: "complete CHECKPOINT 2" }).first().click({ timeout: 1_000 });
    assert.equal(await clicks(page), 1, "the labelled click reached the real control");

    assert.deepEqual(await applyHazard(page, hazard("insert_decoy", 1, 1_500), id), {
      applied: false,
      reason: "already_applied",
    });
    assert.equal(await matches.count(), 2, "no second decoy");

    await page.waitForTimeout(1_700);
    assert.equal(await matches.count(), 2, "the decoy persists after its duration");
    await revertHazard(page, id);
    await waitForRevert(page, originalBody);
    assert.equal(await containerHtml(page), originalContainer);
    assert.equal(await matches.count(), 1);
    // The same disruption id never applies twice in one document.
    assert.equal((await applyHazard(page, hazard("insert_decoy", 1, 1_500), id)).reason, "already_applied");
  } finally {
    await page.close();
  }
});

browserTest("insert_decoy labels by intensity and never reuses the target's label", async () => {
  for (const [intensity, expected] of [[2, "Proceed to next step"], [3, "Continue (recommended)"]] as const) {
    const page = await openCourse();
    try {
      await applyHazard(page, hazard("insert_decoy", intensity, 2_000), `d-${intensity}`);
      assert.equal(await page.locator(SELECTOR).first().innerText(), expected);
    } finally {
      await page.close();
    }
  }
  const page = await openCourse(
    `<main><button data-arena-role="${ROLE}" onclick="window.clicks = (window.clicks || 0) + 1">Continue</button></main>`,
  );
  try {
    await applyHazard(page, hazard("insert_decoy", 1, 2_000), "d-collide");
    const first = page.locator(SELECTOR).first();
    assert.equal(await first.innerText(), "Proceed to next step");
    // Inline handlers are not cloned onto the decoy.
    await first.click({ timeout: 1_000 });
    assert.equal(await page.evaluate(() => (window as unknown as { clicks?: number }).clicks ?? 0), 0);
  } finally {
    await page.close();
  }
});

browserTest("a decoy inside a form never hijacks its submission", async () => {
  const page = await openCourse(`<form id="search"><input name="q" aria-label="Search">
<button type="submit" class="btn" data-arena-role="${ROLE}">Search</button></form>
<script>
  window.submits = 0;
  document.getElementById("search").addEventListener("submit", (event) => {
    event.preventDefault();
    window.submits += 1;
  });
</script>`);
  const submits = () => page.evaluate(() => (window as unknown as { submits: number }).submits);
  try {
    await applyHazard(page, hazard("insert_decoy", 1, 5_000), "d-form");
    const decoy = page.locator(SELECTOR).first();
    assert.equal(await decoy.getAttribute("data-arena-decoy"), "true");
    await decoy.click({ timeout: 1_000 });
    assert.equal(await submits(), 0, "the decoy click did not submit the form");
    await page.locator('input[name="q"]').press("Enter");
    assert.equal(await submits(), 1, "Enter still submits through the real button");
  } finally {
    await page.close();
  }
});

browserTest("blocking_modal intercepts clicks until bounded DOM recovery (intensity 1)", async () => {
  const page = await openCourse();
  try {
    const originalBody = await bodyHtml(page);
    assert.equal((await applyHazard(page, hazard("blocking_modal", 1, 2_000), "d-modal-1")).applied, true);

    const blocked = await clickFailure(page, SELECTOR);
    assert.match(blocked.message, /intercepts pointer events/);
    assert.ok(blocked.elapsed < 2_000, `failed after ${blocked.elapsed} ms`);

    const close = page.locator('[data-arena-role="dismiss-overlay"]');
    assert.equal(await close.count(), 1);
    await close.click({ timeout: 1_000 });
    assert.equal(await page.locator('[role="dialog"]').count(), 0);
    await page.locator(SELECTOR).first().click({ timeout: 1_000 });
    assert.equal(await clicks(page), 1);

    // Manual dismissal fully reverts the persistent overlay.
    await waitForRevert(page, originalBody);
  } finally {
    await page.close();
  }
});

browserTest("blocking_modal remains until its visible Close recovery at intensity 3", async () => {
  const page = await openCourse();
  try {
    const originalBody = await bodyHtml(page);
    await applyHazard(page, hazard("blocking_modal", 3, 1_200), "d-modal-3");
    const close = page.locator('[data-arena-role="dismiss-overlay"]');
    assert.equal(await close.count(), 1);
    assert.match((await clickFailure(page, SELECTOR, 200)).message, /intercepts pointer events/);

    await close.click({ timeout: 1_000 });
    await page.locator(SELECTOR).first().click({ timeout: 1_000 });
    assert.equal(await clicks(page), 1);
    await waitForRevert(page, originalBody);
  } finally {
    await page.close();
  }
});

browserTest("an external-site blocking modal has a visible Close recovery", async () => {
  const page = await openCourse();
  try {
    await applyHazard(page, hazard("blocking_modal", 3, 8_000), "d-external-modal", { externalSite: true });
    const close = page.getByRole("button", { name: "Close" });
    assert.equal(await close.count(), 1);
    await close.click({ timeout: 1_000 });
    assert.equal(await page.locator('[role="dialog"]').count(), 0);
    await page.locator(SELECTOR).click({ timeout: 1_000 });
    assert.equal(await clicks(page), 1);
  } finally {
    await page.close();
  }
});

browserTest("temporary_disable sets disabled and aria-disabled, then restores them", async () => {
  const page = await openCourse();
  try {
    const originalBody = await bodyHtml(page);
    await applyHazard(page, hazard("temporary_disable", 2, 1_000), "d-disable");
    const target = page.locator(SELECTOR);
    assert.equal(await target.isDisabled(), true);
    assert.equal(await target.getAttribute("aria-disabled"), "true");
    assert.match((await clickFailure(page, SELECTOR)).message, /element is not enabled/);

    await revertHazard(page, "d-disable");
    await waitForRevert(page, originalBody);
    assert.equal(await target.isDisabled(), false);
    await target.click({ timeout: 1_000 });
    assert.equal(await clicks(page), 1);
  } finally {
    await page.close();
  }
});

browserTest("move_primary_action hides the target behind a More options disclosure", async () => {
  const page = await openCourse();
  try {
    const originalBody = await bodyHtml(page);
    await applyHazard(page, hazard("move_primary_action", 1, 1_500), "d-move");
    const target = page.locator(SELECTOR);
    const disclosure = page.locator('[data-arena-role="more-actions"]');
    assert.equal(await target.isHidden(), true);
    assert.equal(await disclosure.innerText(), "More options");
    assert.match((await clickFailure(page, SELECTOR)).message, /element is not visible/);

    await disclosure.click({ timeout: 1_000 });
    assert.equal(await target.isVisible(), true);
    assert.equal(await disclosure.count(), 0);
    await target.click({ timeout: 1_000 });
    assert.equal(await clicks(page), 1);

    // The disclosure manually reverts the persistent hazard.
    await waitForRevert(page, originalBody);
  } finally {
    await page.close();
  }
});

browserTest("rename_control relabels by intensity, keeps the role and restores the children", async () => {
  for (const [intensity, expected] of [[1, "Unavailable"], [2, "Not now"], [3, "Cancel"]] as const) {
    const page = await openCourse();
    try {
      const originalBody = await bodyHtml(page);
      await applyHazard(page, hazard("rename_control", intensity, 600), `d-rename-${intensity}`);
      const target = page.locator("#checkpoint");
      assert.equal(await target.innerText(), expected);
      assert.equal(await target.getAttribute("data-arena-role"), ROLE);
      await revertHazard(page, `d-rename-${intensity}`);
      await waitForRevert(page, originalBody);
      assert.equal(await target.innerText(), REAL_LABEL);
      assert.equal(await page.locator("#checkpoint > span").innerText(), "Complete");
    } finally {
      await page.close();
    }
  }
});

browserTest("reports target_not_found, but a modal needs no target", async () => {
  const page = await openCourse();
  try {
    const missing = { ...hazard("temporary_disable", 1, 500), targetRole: "no-such-role" };
    assert.deepEqual(await applyHazard(page, missing, "d-missing"), {
      applied: false,
      reason: "target_not_found",
    });
    const originalBody = await bodyHtml(page);
    const modal = { ...hazard("blocking_modal", 1, 300), targetRole: "no-such-role" };
    assert.equal((await applyHazard(page, modal, "d-modal-untargeted")).applied, true);
    await revertHazard(page, "d-modal-untargeted");
    await waitForRevert(page, originalBody);
  } finally {
    await page.close();
  }
});

browserTest("the runner reports decoy clicks and blocked actions against real hazards", async () => {
  const page = await browser!.newPage();
  try {
    await page.route("https://course.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: COURSE_HTML }));
    const inputs: Array<Parameters<CompetitorDecisionModel["decide"]>[0]> = [];
    const reports: AgentActionReport[] = [];
    let syncs = 0;
    const click = (label?: string): AgentDecision =>
      label === undefined ? { type: "click", targetRole: ROLE } : { type: "click", targetRole: ROLE, label };
    const turns: Array<() => Promise<AgentDecision>> = [
      async () => {
        await applyHazard(page, hazard("insert_decoy", 1, 20_000), "d-decoy");
        return { type: "inspect" };
      },
      async () => click(),
      async () => click(REAL_LABEL),
      async () => {
        await revertHazard(page, "d-decoy");
        await applyHazard(page, hazard("temporary_disable", 2, 20_000), "d-disable");
        return click(REAL_LABEL);
      },
      async () => {
        await revertHazard(page, "d-disable");
        await applyHazard(page, hazard("move_primary_action", 1, 20_000), "d-move");
        return click(REAL_LABEL);
      },
      async () => {
        await revertHazard(page, "d-move");
        await applyHazard(page, hazard("blocking_modal", 3, 20_000), "d-modal");
        return click(REAL_LABEL);
      },
      async () => {
        await revertHazard(page, "d-modal");
        return click("Cancel order");
      },
      async () => ({ type: "finish" }),
    ];
    const runner = new PlaywrightCompetitorRunner({
      task: "Complete checkpoint 2",
      startUrl: "https://course.test/start",
      actionTimeoutMs: 400,
      model: {
        async decide(input) {
          inputs.push(structuredClone(input));
          const next = turns.shift();
          if (!next) throw new Error("No turn configured");
          return next();
        },
      },
    });
    const base = {
      raceId: "race-1",
      racerId: "racer-1",
      courseId: "course-1",
      seed: "seed-1",
      checkpointCount: 4,
      session: { racerId: "racer-1", steelSessionId: "steel-1", page },
    };
    await runner.prepare(base);
    await runner.run({
      ...base,
      async reportCheckpoint() {},
      async reportFinish() {},
      reportAction(report) { reports.push(report); },
      async syncProgress() { syncs += 1; },
    });

    assert.deepEqual(
      reports.map((report) => [
        report.kind,
        report.evidence?.blockedBy ?? null,
        report.evidence?.target?.decoy ?? null,
      ]),
      [
        ["action", null, null],
        ["action", null, true],
        ["action", null, false],
        ["error", "disabled", false],
        ["error", "hidden", false],
        ["error", "modal", false],
        ["error", "missing", null],
        ["action", null, null],
      ],
    );
    const decoyEvidence = reports[1].evidence;
    assert.ok(decoyEvidence);
    const { cursor: decoyCursor, ...decoyRest } = decoyEvidence;
    assert.deepEqual(decoyRest, {
      target: { role: ROLE, text: "Continue", decoy: true },
      navigated: false,
    });
    // The paced cursor records where the click landed, inside the viewport.
    assert.equal(decoyCursor?.action, "click");
    assert.ok(
      decoyCursor &&
        decoyCursor.x > 0 && decoyCursor.x < decoyCursor.viewportWidth &&
        decoyCursor.y > 0 && decoyCursor.y < decoyCursor.viewportHeight,
    );
    assert.deepEqual(reports[2].evidence?.target, { role: ROLE, text: REAL_LABEL, decoy: false });
    assert.equal(await clicks(page), 1, "only the labelled click reached the real control");
    assert.equal(syncs, reports.length);

    // The model sees what a user could: labels and visibility, never the decoy flag.
    const decoyView = inputs[1].observation.controls.filter((control) => control.arenaRole === ROLE);
    assert.deepEqual(
      decoyView.map((control) => [control.text, control.visible, control.disabled]),
      [["Continue", true, false], [REAL_LABEL, true, false]],
    );
    const disabledView = inputs[4].observation.controls.find((control) => control.arenaRole === ROLE);
    assert.equal(disabledView?.disabled, true);
    const movedView = inputs[5].observation.controls;
    assert.equal(movedView.find((control) => control.arenaRole === ROLE)?.visible, false);
    assert.deepEqual(
      movedView.filter((control) => control.arenaRole === "more-actions").map((control) => [control.text, control.visible]),
      [["More options", true]],
    );
    assert.equal(
      inputs[6].history.at(-1)?.error,
      "locator.click: Timeout 400ms exceeded. Another element is covering the control.",
    );
    assert.doesNotMatch(JSON.stringify(inputs), /decoy|disruption|Call log/i);
  } finally {
    await page.close();
  }
});

browserTest("the runner records a paced, pointer-transparent in-page cursor", async () => {
  const page = await browser!.newPage();
  try {
    await page.route("https://course.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: COURSE_HTML }));
    const runner = new PlaywrightCompetitorRunner({
      task: "Complete checkpoint 2",
      startUrl: "https://course.test/start",
      model: {
        async decide(input) {
          return input.history.length === 0
            ? { type: "click", targetRole: ROLE, label: REAL_LABEL }
            : { type: "finish" };
        },
      },
    });
    const base = {
      raceId: "race-1",
      racerId: "racer-1",
      courseId: "course-1",
      seed: "seed-1",
      checkpointCount: 4,
      session: { racerId: "racer-1", steelSessionId: "steel-1", page },
    };
    await runner.prepare(base);
    const target = page.locator(SELECTOR).filter({ hasText: REAL_LABEL }).first();
    const targetBox = await target.boundingBox();
    assert.ok(targetBox);
    await page.evaluate(() => {
      const cursor = document.getElementById("arena-agent-cursor");
      if (!cursor) throw new Error("cursor was not installed");
      let mutations = 0;
      (window as unknown as { arenaCursorMutations?: () => number }).arenaCursorMutations = () => mutations;
      new MutationObserver(() => {
        mutations += 1;
      }).observe(cursor, { attributes: true, attributeFilter: ["style"] });
    });

    await runner.run({
      ...base,
      async reportCheckpoint() {},
      async reportFinish() {},
    });

    const result = await page.evaluate(() => {
      const cursor = document.getElementById("arena-agent-cursor");
      const shape = cursor?.querySelector(".arena-agent-cursor-shape");
      const rect = cursor?.getBoundingClientRect();
      return {
        pointerEvents: cursor ? getComputedStyle(cursor).pointerEvents : null,
        shapeFilter: shape ? getComputedStyle(shape).filter : null,
        left: rect?.left ?? null,
        top: rect?.top ?? null,
        mutations: (window as unknown as { arenaCursorMutations?: () => number }).arenaCursorMutations?.() ?? 0,
      };
    });
    assert.equal(result.pointerEvents, "none");
    assert.match(result.shapeFilter ?? "", /drop-shadow/);
    assert.ok(result.mutations > 1, "cursor should move through intermediate positions");
    assert.ok(Math.abs((result.left ?? 0) - (targetBox.x + targetBox.width / 2)) < 1);
    assert.ok(Math.abs((result.top ?? 0) - (targetBox.y + targetBox.height / 2)) < 1);
  } finally {
    await page.close();
  }
});
