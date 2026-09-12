import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  assertRunProof,
  positiveInteger,
  requireString,
  stateKey,
  type CourseKey,
  type CourseRunProof,
  type StoredCourseState,
} from "./course-state.js";
import {
  SHOP_CHECKPOINT_COUNT,
  SHOP_COURSE_ID,
  SHOP_DEFAULT_SEED,
  hashString,
  searchShopProducts,
  shopCatalogueForSeed,
  type ShippingMethod,
  type ShopCatalogue,
  type ShopProductKind,
} from "./shop-catalogue.js";
import {
  renderCart,
  renderCheckout,
  renderConfirmation,
  renderHelp,
  renderHome,
  renderNotFound,
  renderProduct,
  renderResults,
  type CartLine,
  type CheckoutForm,
  type PageFrame,
  type RunParams,
} from "./shop-pages.js";

export * from "./shop-catalogue.js";

// The arena-shop storefront: a realistic multi-step course served by the
// course app. It shares the course state map, stateKey and run-proof rules,
// so /arena/state and the deterministic verifier work unchanged.
//
// Checkpoints, strictly in order:
//   1 Product found     opening the correct product's page (sets targetOpened)
//   2 Added to cart     the cart holds exactly one unit of the correct product
//   3 Shipping details  a valid Standard-shipping order for that cart (sets finished)

type CartItem = { sku: string; quantity: number };

type StoredOrder = {
  number: string;
  name: string;
  address: string;
  shipping: ShippingMethod;
  items: CartItem[];
  totalCents: number;
};

type ShopSession = {
  cart: CartItem[];
  orders: StoredOrder[];
  targetViewed: boolean;
  correctOrderPlaced: boolean;
};

type RawInput = Record<string, unknown>;

const MAX_CART_LINES = 20;
const MAX_QUANTITY = 10;
const MAX_ORDERS = 20;
const MAX_QUERY_LENGTH = 100;
const TRENDING_KINDS: ReadonlySet<ShopProductKind> = new Set(["refurbished", "larger-on-sale", "premium"]);

export type ShopCourse = {
  /** GET /?courseId=arena-shop: opens (or resumes) the run and sends the store home. */
  home(query: unknown, reply: FastifyReply): FastifyReply;
  /** The /shop/* routes. Register with app.register: the form-body parser stays encapsulated. */
  plugin: FastifyPluginAsync;
};

function inputOf(value: unknown): RawInput {
  return value !== null && typeof value === "object" ? (value as RawInput) : {};
}

function identityOf(input: RawInput): CourseKey {
  const identity: CourseKey = {
    raceId: requireString(input.raceId, "raceId"),
    racerId: requireString(input.racerId, "racerId"),
    courseId: requireString(input.courseId, "courseId"),
  };
  if (identity.courseId !== SHOP_COURSE_ID) {
    throw new Error(`courseId must be ${SHOP_COURSE_ID}`);
  }
  return identity;
}

function proofOf(input: RawInput): CourseRunProof {
  return {
    seed: typeof input.seed === "string" ? input.seed : undefined,
    steelSessionId: typeof input.steelSessionId === "string" ? input.steelSessionId : undefined,
  };
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function runParams(state: StoredCourseState): RunParams {
  const params: RunParams = {
    raceId: state.raceId,
    racerId: state.racerId,
    courseId: state.courseId,
  };
  if (state.seed !== undefined) params.seed = state.seed;
  if (state.steelSessionId !== undefined) params.steelSessionId = state.steelSessionId;
  params.checkpointCount = String(state.checkpointCount);
  return params;
}

function orderNumber(state: StoredCourseState, index: number): string {
  const hash = hashString(`${state.raceId}|${state.racerId}|${state.seed ?? ""}|${index}`);
  return `VM-${100_000 + (hash % 900_000)}`;
}

export function createShopCourse(states: Map<string, StoredCourseState>): ShopCourse {
  const sessions = new WeakMap<StoredCourseState, ShopSession>();

  /** Any storefront page opens the run exactly like the course home does. */
  function openRun(input: RawInput): StoredCourseState {
    const identity = identityOf(input);
    const proof = proofOf(input);
    const checkpointCount = positiveInteger(input.checkpointCount, "checkpointCount");
    if (checkpointCount !== SHOP_CHECKPOINT_COUNT) {
      throw new Error(`${SHOP_COURSE_ID} has exactly ${SHOP_CHECKPOINT_COUNT} checkpoints`);
    }
    const key = stateKey(identity);
    let state = states.get(key);
    if (!state) {
      state = {
        ...identity,
        ...proof,
        checkpointCount,
        completedCheckpoints: [],
        targetOpened: false,
        finished: false,
      };
      states.set(key, state);
    } else {
      assertRunProof(state, proof);
    }
    return state;
  }

  /** Form submissions act only on a run that a page already opened. */
  function resumeRun(input: RawInput): StoredCourseState {
    const state = states.get(stateKey(identityOf(input)));
    if (!state) throw new Error("Course run was not initialized");
    assertRunProof(state, proofOf(input));
    return state;
  }

  function sessionFor(state: StoredCourseState): ShopSession {
    let session = sessions.get(state);
    if (!session) {
      session = { cart: [], orders: [], targetViewed: false, correctOrderPlaced: false };
      sessions.set(state, session);
    }
    return session;
  }

  function catalogueFor(state: StoredCourseState): ShopCatalogue {
    return shopCatalogueForSeed(state.seed ?? SHOP_DEFAULT_SEED);
  }

  function linesFor(items: readonly CartItem[], catalogue: ShopCatalogue): CartLine[] {
    return items.flatMap((item) => {
      const product = catalogue.products.find((candidate) => candidate.id === item.sku);
      return product ? [{ product, quantity: item.quantity }] : [];
    });
  }

  function holdsExactlyTarget(session: ShopSession, catalogue: ShopCatalogue): boolean {
    return session.cart.length === 1 &&
      session.cart[0].sku === catalogue.correctProductId &&
      session.cart[0].quantity === 1;
  }

  /** Completes every next checkpoint whose condition now holds, in order. */
  function advance(state: StoredCourseState, session: ShopSession, catalogue: ShopCatalogue): void {
    while (!state.finished && state.completedCheckpoints.length < state.checkpointCount) {
      const next = state.completedCheckpoints.length + 1;
      const met = next === 1
        ? session.targetViewed
        : next === 2
          ? holdsExactlyTarget(session, catalogue)
          : session.correctOrderPlaced;
      if (!met) return;
      state.completedCheckpoints.push(next);
      if (next === 1) state.targetOpened = true;
      if (next === state.checkpointCount) state.finished = true;
    }
  }

  function frameFor(state: StoredCourseState, session: ShopSession): PageFrame {
    return {
      run: runParams(state),
      cartCount: session.cart.reduce((sum, item) => sum + item.quantity, 0),
    };
  }

  function sendHtml(reply: FastifyReply, html: string, status = 200): FastifyReply {
    return reply
      .status(status)
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(html);
  }

  function redirectTo(reply: FastifyReply, path: string, state: StoredCourseState, extra: Record<string, string> = {}) {
    const query = new URLSearchParams({ ...runParams(state), ...extra });
    return reply.header("cache-control", "no-store").redirect(`${path}?${query.toString()}`, 303);
  }

  function checkoutPage(
    reply: FastifyReply,
    state: StoredCourseState,
    session: ShopSession,
    form: CheckoutForm,
    errors: string[],
  ): FastifyReply {
    const lines = linesFor(session.cart, catalogueFor(state));
    return sendHtml(
      reply,
      renderCheckout(frameFor(state, session), lines, form, errors),
      errors.length > 0 ? 422 : 200,
    );
  }

  const plugin: FastifyPluginAsync = async (shop) => {
    shop.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 16_384 },
      (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      },
    );

    shop.get("/shop/search", async (request, reply) => {
      const input = inputOf(request.query);
      const state = openRun(input);
      const query = typeof input.q === "string" ? input.q.slice(0, MAX_QUERY_LENGTH) : "";
      const results = searchShopProducts(catalogueFor(state), query);
      return sendHtml(reply, renderResults(frameFor(state, sessionFor(state)), query, results));
    });

    shop.get("/shop/product", async (request, reply) => {
      const input = inputOf(request.query);
      const state = openRun(input);
      const session = sessionFor(state);
      const catalogue = catalogueFor(state);
      const product = catalogue.products.find((candidate) => candidate.id === input.sku);
      if (!product) {
        return sendHtml(reply, renderNotFound(
          frameFor(state, session),
          "Product not found",
          "That listing is no longer available.",
        ), 404);
      }
      if (product.id === catalogue.correctProductId) {
        session.targetViewed = true;
        advance(state, session, catalogue);
      }
      const query = typeof input.q === "string" ? input.q.slice(0, MAX_QUERY_LENGTH) : undefined;
      return sendHtml(reply, renderProduct(frameFor(state, session), product, query));
    });

    shop.post("/shop/cart/add", async (request, reply) => {
      const input = inputOf(request.body);
      const state = resumeRun(input);
      const session = sessionFor(state);
      const catalogue = catalogueFor(state);
      const product = catalogue.products.find((candidate) => candidate.id === input.sku);
      if (!product) throw new Error("Unknown product");
      const line = session.cart.find((item) => item.sku === product.id);
      if (line) {
        line.quantity = Math.min(MAX_QUANTITY, line.quantity + 1);
      } else if (session.cart.length < MAX_CART_LINES) {
        session.cart.push({ sku: product.id, quantity: 1 });
      }
      advance(state, session, catalogue);
      return redirectTo(reply, "/shop/cart", state);
    });

    shop.post("/shop/cart/remove", async (request, reply) => {
      const input = inputOf(request.body);
      const state = resumeRun(input);
      const session = sessionFor(state);
      session.cart = session.cart.filter((item) => item.sku !== input.sku);
      advance(state, session, catalogueFor(state));
      return redirectTo(reply, "/shop/cart", state);
    });

    shop.get("/shop/cart", async (request, reply) => {
      const state = openRun(inputOf(request.query));
      const session = sessionFor(state);
      return sendHtml(reply, renderCart(frameFor(state, session), linesFor(session.cart, catalogueFor(state))));
    });

    shop.get("/shop/checkout", async (request, reply) => {
      const state = openRun(inputOf(request.query));
      return checkoutPage(reply, state, sessionFor(state), { name: "", address: "", shipping: "standard" }, []);
    });

    shop.post("/shop/checkout", async (request, reply) => {
      const input = inputOf(request.body);
      const state = resumeRun(input);
      const session = sessionFor(state);
      const catalogue = catalogueFor(state);
      const form: CheckoutForm = {
        name: text(input.name, 120),
        address: text(input.address, 200),
        shipping: typeof input.shipping === "string" ? input.shipping : "",
      };
      const lines = linesFor(session.cart, catalogue);
      const errors: string[] = [];
      if (lines.length === 0) errors.push("Your cart is empty.");
      if (form.name === "") errors.push("Enter the full name for delivery.");
      if (form.address === "") errors.push("Enter a shipping address.");
      if (form.shipping === "express") {
        errors.push("Express shipping isn't available for this order. Choose Standard shipping.");
      } else if (form.shipping !== "standard") {
        errors.push("Choose a shipping method.");
      }
      if (errors.length > 0) return checkoutPage(reply, state, session, form, errors);

      // The store places any valid order. Only exactly one unit of the
      // correct product satisfies the task; any other order completes nothing.
      const order: StoredOrder = {
        number: orderNumber(state, session.orders.length),
        name: form.name,
        address: form.address,
        shipping: "standard",
        items: session.cart.map((item) => ({ ...item })),
        totalCents: lines.reduce((sum, line) => sum + line.product.priceCents * line.quantity, 0),
      };
      session.orders.push(order);
      if (session.orders.length > MAX_ORDERS) session.orders.shift();
      if (holdsExactlyTarget(session, catalogue)) {
        session.correctOrderPlaced = true;
        advance(state, session, catalogue);
      }
      session.cart = [];
      return redirectTo(reply, "/shop/order", state, { order: order.number });
    });

    shop.get("/shop/order", async (request, reply) => {
      const input = inputOf(request.query);
      const state = openRun(input);
      const session = sessionFor(state);
      const order = session.orders.find((candidate) => candidate.number === input.order);
      if (!order) {
        return sendHtml(reply, renderNotFound(
          frameFor(state, session),
          "Order not found",
          "We couldn't find that order.",
        ), 404);
      }
      return sendHtml(reply, renderConfirmation(frameFor(state, session), {
        number: order.number,
        name: order.name,
        address: order.address,
        shipping: order.shipping,
        lines: linesFor(order.items, catalogueFor(state)),
        totalCents: order.totalCents,
      }));
    });

    shop.get("/shop/help", async (request, reply) => {
      const state = openRun(inputOf(request.query));
      return sendHtml(reply, renderHelp(frameFor(state, sessionFor(state))));
    });
  };

  return {
    home(query, reply) {
      const state = openRun(inputOf(query));
      const catalogue = catalogueFor(state);
      const trending = catalogue.products.filter((product) => TRENDING_KINDS.has(product.kind));
      return sendHtml(reply, renderHome(frameFor(state, sessionFor(state)), trending));
    },
    plugin,
  };
}
