import assert from "node:assert/strict";
import test from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { buildCourseApp } from "../src/course/course-server.js";
import {
  DeterministicCourseVerifier,
  type CourseStateGateway,
} from "../src/course/deterministic-course-verifier.js";
import {
  SHOP_COURSE_ID,
  satisfiesShopTask,
  shopCatalogueForSeed,
  shopCorrectProductId,
  shopTaskForSeed,
  type ShopProduct,
} from "../src/course/shop-course.js";

type App = ReturnType<typeof buildCourseApp>;

const SEED = "seed-shop-1";
const run = {
  raceId: "race-shop",
  racerId: "racer-1",
  courseId: SHOP_COURSE_ID,
  seed: SEED,
  steelSessionId: "steel-1",
  checkpointCount: "3",
};
const ids = { raceId: run.raceId, racerId: run.racerId, courseId: run.courseId };
const VALID_ORDER = {
  name: "Arena Tester",
  address: "1 Market Street, San Francisco, CA 94105",
  shipping: "standard",
};

const catalogue = shopCatalogueForSeed(SEED);
const answer = catalogue.products.find((product) => product.id === catalogue.correctProductId)!;
const byKind = (kind: ShopProduct["kind"]) => catalogue.products.find((product) => product.kind === kind)!;

function decode(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function page(app: App, path: string, extra: Record<string, string> = {}) {
  return app.inject({ method: "GET", url: `${path}?${new URLSearchParams({ ...run, ...extra })}` });
}

function post(app: App, path: string, extra: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ ...run, ...extra }).toString(),
  });
}

async function courseState(app: App) {
  const response = await app.inject({ method: "GET", url: `/arena/state?${new URLSearchParams(ids)}` });
  assert.equal(response.statusCode, 200);
  return response.json() as {
    completedCheckpoints: number[];
    targetOpened?: boolean;
    finished: boolean;
  };
}

/** Follows a POST-redirect-GET like a browser. */
function follow(app: App, response: LightMyRequestResponse) {
  assert.equal(response.statusCode, 303);
  return app.inject({ method: "GET", url: String(response.headers.location) });
}

type ParsedForm = { method: string; action: string; hidden: Record<string, string> };

function formsIn(html: string): ParsedForm[] {
  return html.split("<form").slice(1).map((chunk) => {
    const body = chunk.slice(0, chunk.indexOf("</form>"));
    const open = body.slice(0, body.indexOf(">"));
    const hidden: Record<string, string> = {};
    for (const match of body.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) {
      hidden[decode(match[1])] = decode(match[2]);
    }
    return {
      method: /method="([^"]*)"/.exec(open)?.[1] ?? "get",
      action: decode(/action="([^"]*)"/.exec(open)?.[1] ?? ""),
      hidden,
    };
  });
}

/** Submits the first matching form with its hidden fields plus `fields`, like a browser. */
function submit(
  app: App,
  html: string,
  matches: (form: ParsedForm) => boolean,
  fields: Record<string, string> = {},
) {
  const form = formsIn(html).find(matches);
  assert.ok(form, "no matching form on the page");
  const data = new URLSearchParams({ ...form.hidden, ...fields }).toString();
  return form.method === "post"
    ? app.inject({
      method: "POST",
      url: form.action,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: data,
    })
    : app.inject({ method: "GET", url: `${form.action}?${data}` });
}

const action = (path: string, method?: string) => (form: ParsedForm) =>
  form.action === path && (method === undefined || form.method === method);

function productHref(html: string, name: string): string {
  const match = new RegExp(`<a href="([^"]*)" data-arena-role="product-link">${name}</a>`).exec(html);
  assert.ok(match, `no product link for ${name}`);
  return decode(match[1]);
}

/** The text that follows the first primary-action hook: what a hazard would target. */
function firstPrimaryAction(html: string): string {
  const start = html.indexOf('data-arena-role="primary-action"');
  assert.ok(start >= 0, "page has no primary-action");
  return html.slice(start, html.indexOf("</", start));
}

function injectGateway(app: App): CourseStateGateway {
  return {
    async getState(input) {
      const params = new URLSearchParams({
        raceId: input.raceId,
        racerId: input.racerId,
        courseId: input.courseId,
      });
      return (await app.inject({ method: "GET", url: `/arena/state?${params}` })).json();
    },
  };
}

test("shop happy path: search, open the answer, add it, check out and place the order", async () => {
  const app = buildCourseApp();
  const home = await app.inject({ method: "GET", url: `/?${new URLSearchParams(run)}` });
  assert.equal(home.statusCode, 200);
  assert.match(home.body, /data-arena-role="search-input"/);
  assert.match(firstPrimaryAction(home.body), />Search$/);
  assert.deepEqual((await courseState(app)).completedCheckpoints, []);

  const results = await submit(app, home.body, action("/shop/search"), { q: "1 TB portable SSD" });
  assert.equal(results.statusCode, 200);
  assert.ok(results.body.includes(answer.name));
  assert.ok(results.body.includes(`Capacity: ${answer.capacityLabel}`));
  assert.match(firstPrimaryAction(results.body), />Search$/);

  const product = await app.inject({ method: "GET", url: productHref(results.body, answer.name) });
  assert.equal(product.statusCode, 200);
  assert.match(firstPrimaryAction(product.body), />Add to cart$/);
  assert.equal(product.body.split('data-arena-role="primary-action"').length, 2);
  let state = await courseState(app);
  assert.deepEqual(state.completedCheckpoints, [1]);
  assert.equal(state.targetOpened, true);

  const cart = await follow(app, await submit(app, product.body, action("/shop/cart/add")));
  assert.equal(cart.statusCode, 200);
  assert.ok(cart.body.includes(answer.name));
  assert.match(cart.body, /data-arena-role="remove-item">Remove</);
  assert.match(firstPrimaryAction(cart.body), />Checkout$/);
  assert.deepEqual((await courseState(app)).completedCheckpoints, [1, 2]);

  const checkout = await submit(app, cart.body, action("/shop/checkout", "get"));
  assert.equal(checkout.statusCode, 200);
  for (const role of ["shipping-name", "shipping-address", "shipping-method"]) {
    assert.match(checkout.body, new RegExp(`data-arena-role="${role}"`));
  }
  assert.match(checkout.body, /<option value="standard" selected>/);
  assert.match(firstPrimaryAction(checkout.body), />Place order$/);

  const confirmation = await follow(
    app,
    await submit(app, checkout.body, action("/shop/checkout", "post"), VALID_ORDER),
  );
  assert.equal(confirmation.statusCode, 200);
  assert.match(confirmation.body, /Order number: <strong id="order-number">VM-[0-9]{6}</);
  assert.ok(confirmation.body.includes(answer.name));
  state = await courseState(app);
  assert.deepEqual(state.completedCheckpoints, [1, 2, 3]);
  assert.equal(state.finished, true);

  // The existing verifier accepts the storefront run unchanged.
  const verifier = new DeterministicCourseVerifier(injectGateway(app));
  const session = { racerId: run.racerId, steelSessionId: run.steelSessionId };
  assert.equal(await verifier.verifyTargetOpening({ ...ids, seed: SEED, session }), true);
  for (const checkpoint of [1, 2, 3]) {
    assert.equal(await verifier.verifyCheckpoint({ ...ids, seed: SEED, checkpoint, session }), true);
  }
  assert.equal(await verifier.verifyFinish({ ...ids, seed: SEED, session }), true);
  assert.equal(await verifier.verifyFinish({ ...ids, seed: "other-seed", session }), false);
  await app.close();
});

test("opening or buying a wrong product completes no checkpoint", async () => {
  const app = buildCourseApp();
  await page(app, "/");
  for (const product of catalogue.products.filter((candidate) => candidate.id !== answer.id)) {
    const response = await page(app, "/shop/product", { sku: product.id });
    assert.equal(response.statusCode, 200);
    assert.match(firstPrimaryAction(response.body), />Add to cart$/);
  }
  assert.equal((await post(app, "/shop/cart/add", { sku: byKind("refurbished").id })).statusCode, 303);
  // The store takes a valid order for the wrong drive; the course records nothing.
  const placed = await post(app, "/shop/checkout", VALID_ORDER);
  assert.equal(placed.statusCode, 303);
  assert.equal((await follow(app, placed)).statusCode, 200);
  const state = await courseState(app);
  assert.deepEqual(state.completedCheckpoints, []);
  assert.equal(state.targetOpened, false);
  assert.equal(state.finished, false);
  await app.close();
});

test("checkpoint 2 needs exactly one unit of the answer, evaluated on add and remove", async () => {
  const app = buildCourseApp();
  await page(app, "/");
  await page(app, "/shop/product", { sku: answer.id });
  const smaller = byKind("smaller-capacity");
  const checkpoints = async () => (await courseState(app)).completedCheckpoints;

  await post(app, "/shop/cart/add", { sku: smaller.id });
  await post(app, "/shop/cart/add", { sku: answer.id });
  assert.deepEqual(await checkpoints(), [1], "an extra item keeps checkpoint 2 open");
  await post(app, "/shop/cart/remove", { sku: answer.id });
  assert.deepEqual(await checkpoints(), [1], "removing the answer leaves it unsatisfied");
  await post(app, "/shop/cart/add", { sku: answer.id });
  await post(app, "/shop/cart/add", { sku: answer.id });
  await post(app, "/shop/cart/remove", { sku: smaller.id });
  assert.deepEqual(await checkpoints(), [1], "two units are not exactly one");
  const doubled = await page(app, "/shop/cart");
  assert.match(doubled.body, /Qty: 2/);
  assert.match(doubled.body, new RegExp(`Remove<span class="sr-only"> ${answer.name}</span>`));
  await post(app, "/shop/cart/remove", { sku: answer.id });
  assert.deepEqual(await checkpoints(), [1]);
  await post(app, "/shop/cart/add", { sku: answer.id });
  assert.deepEqual(await checkpoints(), [1, 2]);

  // Completed checkpoints are final. Emptying the cart afterwards blocks the order instead.
  await post(app, "/shop/cart/remove", { sku: answer.id });
  assert.deepEqual(await checkpoints(), [1, 2]);
  const empty = await post(app, "/shop/checkout", VALID_ORDER);
  assert.equal(empty.statusCode, 422);
  assert.match(empty.body, /Your cart is empty/);
  assert.equal((await courseState(app)).finished, false);
  await app.close();
});

test("express shipping or missing fields re-render checkout with an error and complete nothing", async () => {
  const app = buildCourseApp();
  await page(app, "/");
  await page(app, "/shop/product", { sku: answer.id });
  await post(app, "/shop/cart/add", { sku: answer.id });

  const express = await post(app, "/shop/checkout", { ...VALID_ORDER, shipping: "express" });
  assert.equal(express.statusCode, 422);
  assert.match(express.body, /role="alert"/);
  assert.match(express.body, /Choose Standard shipping/);
  assert.match(express.body, /<option value="express" selected>/);

  const blank = await post(app, "/shop/checkout", { name: "   ", address: "", shipping: "standard" });
  assert.equal(blank.statusCode, 422);
  assert.match(blank.body, /Enter the full name for delivery/);
  assert.match(blank.body, /Enter a shipping address/);

  const hostile = await post(app, "/shop/checkout", { name: '<b>"Arena"</b>', address: "", shipping: "express" });
  assert.equal(hostile.statusCode, 422);
  assert.ok(hostile.body.includes("&lt;b&gt;&quot;Arena&quot;&lt;/b&gt;"));
  assert.ok(!hostile.body.includes('<b>"Arena"</b>'));

  let state = await courseState(app);
  assert.deepEqual(state.completedCheckpoints, [1, 2]);
  assert.equal(state.finished, false);

  // The cart survives the errors, so a corrected submission still finishes.
  assert.equal((await post(app, "/shop/checkout", VALID_ORDER)).statusCode, 303);
  state = await courseState(app);
  assert.deepEqual(state.completedCheckpoints, [1, 2, 3]);
  assert.equal(state.finished, true);
  await app.close();
});

test("rejects run-proof mismatches, uninitialized runs and direct progress reports", async () => {
  const app = buildCourseApp();
  assert.equal((await page(app, "/")).statusCode, 200);

  const wrongSeed = await page(app, "/shop/product", { sku: answer.id, seed: "other-seed" });
  assert.equal(wrongSeed.statusCode, 400);
  assert.match(wrongSeed.json().error, /seed does not match/);
  const wrongSteel = await page(app, "/", { steelSessionId: "steel-2" });
  assert.equal(wrongSteel.statusCode, 400);
  assert.match(wrongSteel.json().error, /Steel session does not match/);
  const forged = await post(app, "/shop/cart/add", { sku: answer.id, steelSessionId: "steel-2" });
  assert.equal(forged.statusCode, 400);

  const stranger = await post(app, "/shop/cart/add", { sku: answer.id, racerId: "racer-9" });
  assert.equal(stranger.statusCode, 400);
  assert.match(stranger.json().error, /not initialized/);
  const wrongCount = await page(app, "/", { racerId: "racer-2", checkpointCount: "4" });
  assert.equal(wrongCount.statusCode, 400);
  assert.match(wrongCount.json().error, /exactly 3 checkpoints/);

  const report = { ...ids, seed: SEED, steelSessionId: run.steelSessionId };
  const shortcut = await app.inject({ method: "POST", url: "/arena/checkpoint", payload: { ...report, checkpoint: 1 } });
  assert.equal(shortcut.statusCode, 400);
  assert.match(shortcut.json().error, /storefront/);
  const finish = await app.inject({ method: "POST", url: "/arena/finish", payload: report });
  assert.equal(finish.statusCode, 400);

  const state = await courseState(app);
  assert.deepEqual(state.completedCheckpoints, []);
  assert.equal(state.targetOpened, false);
  await app.close();
});

test("carries the run identity through every link and form, with no external assets", async () => {
  const app = buildCourseApp();
  const bodies: string[] = [];
  const visit = async (response: Promise<LightMyRequestResponse> | LightMyRequestResponse) => {
    const resolved = await response;
    bodies.push(resolved.body);
    return resolved;
  };

  await visit(page(app, "/"));
  await visit(page(app, "/shop/cart"));
  await visit(page(app, "/shop/checkout"));
  await visit(page(app, "/shop/search", { q: "" }));
  await visit(page(app, "/shop/search", { q: "zzz no such drive" }));
  await visit(page(app, "/shop/help"));
  await visit(page(app, "/shop/product", { sku: "vm-missing" }));
  await visit(page(app, "/shop/product", { sku: answer.id, q: "ssd" }));
  await visit(follow(app, await post(app, "/shop/cart/add", { sku: answer.id })));
  await visit(page(app, "/shop/checkout"));
  await visit(post(app, "/shop/checkout", { ...VALID_ORDER, shipping: "express" }));
  await visit(follow(app, await post(app, "/shop/checkout", VALID_ORDER)));
  await visit(page(app, "/shop/order", { order: "VM-000000" }));

  for (const body of bodies) {
    assert.match(body, /data-arena-role="primary-action"/);
    assert.ok(!/<script|<link|<img|src=/.test(body), "pages are self-contained");
    const hrefs = [...body.matchAll(/href="([^"]*)"/g)].map((match) => decode(match[1]));
    assert.ok(hrefs.length >= 8);
    for (const href of hrefs) {
      const url = new URL(href, "http://course.test");
      assert.equal(url.origin, "http://course.test", href);
      for (const [key, value] of Object.entries(run)) {
        assert.equal(url.searchParams.get(key), value, `${href} lost ${key}`);
      }
    }
    const forms = formsIn(body);
    assert.ok(forms.length >= 1);
    for (const form of forms) {
      for (const [key, value] of Object.entries(run)) {
        assert.equal(form.hidden[key], value, `${form.action} form lost ${key}`);
      }
    }
  }
  await app.close();
});

test("escapes search text and keeps the Featured order, not price order", async () => {
  const app = buildCourseApp();
  await page(app, "/");
  const results = await page(app, "/shop/search", { q: '<script>alert("x")</script> ssd' });
  assert.equal(results.statusCode, 200);
  assert.ok(!results.body.includes("<script>"));
  assert.ok(results.body.includes("&lt;script&gt;"));
  const shown = catalogue.products.filter((product) => results.body.includes(product.name));
  assert.equal(shown.length, catalogue.products.length);
  const positions = catalogue.products.map((product) => results.body.indexOf(product.name));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  const prices = catalogue.products.map((product) => product.priceCents);
  assert.notDeepEqual(prices, [...prices].sort((left, right) => left - right));
  await app.close();
});

test("shopTaskForSeed is deterministic and every seed has exactly one answer", () => {
  assert.deepEqual(shopTaskForSeed("seed-a"), shopTaskForSeed("seed-a"));
  assert.deepEqual(shopCatalogueForSeed("seed-a"), shopCatalogueForSeed("seed-a"));
  const titles = new Set<string>();
  for (let index = 0; index < 50; index += 1) {
    const seed = `seed-${index}`;
    const task = shopTaskForSeed(seed);
    const shop = shopCatalogueForSeed(seed);
    assert.ok(task.title.length <= 90, task.title);
    assert.equal(task.checkpointCount, 3);
    assert.deepEqual(task.checkpointLabels, ["Product found", "Added to cart", "Shipping details"]);
    assert.ok(task.task.includes(shop.constraint.capacityLabel) && task.task.includes("Standard shipping"));
    titles.add(task.title);

    assert.ok(shop.products.length >= 7 && shop.products.length <= 9);
    const answers = shop.products.filter((product) => satisfiesShopTask(product, shop));
    assert.deepEqual(answers.map((product) => product.id), [shopCorrectProductId(seed)], seed);
    assert.equal(new Set(shop.products.map((product) => product.name)).size, shop.products.length);

    const target = shop.products.find((product) => product.id === shop.correctProductId)!;
    const kind = (name: ShopProduct["kind"]) => shop.products.find((product) => product.kind === name)!;
    const refurbished = kind("refurbished");
    assert.equal(refurbished.capacityGb, target.capacityGb);
    assert.ok(refurbished.priceCents < target.priceCents, "the refurbished drive is a cheaper near miss");
    const over = kind("just-over-budget");
    assert.equal(over.capacityGb, target.capacityGb);
    assert.ok(over.priceCents > shop.constraint.budgetCents && over.priceCents <= shop.constraint.budgetCents + 400);
    const smaller = kind("smaller-capacity");
    assert.ok(smaller.capacityGb < target.capacityGb && smaller.priceCents < target.priceCents);

    const prices = shop.products.map((product) => product.priceCents);
    assert.notDeepEqual(prices, [...prices].sort((left, right) => left - right));
  }
  assert.ok(titles.size > 1, "seeds vary the task");
});
