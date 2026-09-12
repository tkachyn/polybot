// The seeded catalogue and task behind the `arena-shop` storefront course.
// Everything here is a pure function of the run seed: every racer in a race
// shops the same store, and tests can recompute the one correct answer.

export const SHOP_COURSE_ID = "arena-shop";
export const SHOP_CHECKPOINT_COUNT = 3;
export const SHOP_CHECKPOINT_LABELS: readonly string[] = [
  "Product found",
  "Added to cart",
  "Shipping details",
];
export const SHOP_STORE_NAME = "Voltmart";
/** Catalogue seed for a run that was created without one. */
export const SHOP_DEFAULT_SEED = "arena-shop";
/** The contact the task asks for. The store accepts any non-empty name and address. */
export const SHOP_SHIP_TO = {
  name: "Arena Tester",
  address: "1 Market Street, San Francisco, CA 94105",
} as const;

export type ShippingMethod = "standard" | "express";

export const SHOP_SHIPPING_METHODS: ReadonlyArray<{
  value: ShippingMethod;
  label: string;
  costCents: number;
}> = [
  { value: "standard", label: "Standard (5–7 business days) · Free", costCents: 0 },
  { value: "express", label: "Express (1–2 business days) · $14.99", costCents: 1_499 },
];

/** Why a listing is in the catalogue. Server-side only; never rendered. */
export type ShopProductKind =
  | "target" // the only listing that satisfies the task
  | "not-cheapest" // new, right capacity, under budget, but pricier than the target
  | "refurbished" // right capacity, under budget and cheaper, but refurbished
  | "smaller-capacity" // cheaper, but the wrong (smaller) capacity
  | "just-over-budget" // new, right capacity, a few cents to a few dollars over budget
  | "premium" // new, right capacity, well over budget
  | "larger-on-sale" // wrong (larger) capacity, discounted under budget
  | "larger-capacity"; // wrong (larger) capacity at its regular price

export type ShopProduct = {
  /** Opaque SKU. Agents only reach a product through its link. */
  id: string;
  /** Unique across the catalogue, so a visible label identifies one product. */
  name: string;
  brand: string;
  capacityGb: number;
  capacityLabel: string;
  priceCents: number;
  /** Struck-through list price, when the listing is discounted. */
  listPriceCents?: number;
  condition: "new" | "refurbished";
  connection: string;
  readMBps: number;
  rating: number;
  reviewCount: number;
  kind: ShopProductKind;
};

export type ShopConstraint = {
  capacityGb: number;
  capacityLabel: string;
  /** Prices must be strictly below this. */
  budgetCents: number;
  condition: "new";
};

export type ShopCatalogue = {
  seed: string;
  constraint: ShopConstraint;
  /** Listing order ("Featured"): seeded and never sorted by price. */
  products: ShopProduct[];
  correctProductId: string;
};

export type ShopTask = {
  title: string;
  task: string;
  taskDetail: string;
  successCondition: string;
  checkpointLabels: string[];
  checkpointCount: number;
};

const CAPACITIES: Record<number, { label: string; compact: string }> = {
  250: { label: "250 GB", compact: "250GB" },
  500: { label: "500 GB", compact: "500GB" },
  1000: { label: "1 TB", compact: "1TB" },
  2000: { label: "2 TB", compact: "2TB" },
  4000: { label: "4 TB", compact: "4TB" },
};

const TARGET_TIERS = [
  { capacityGb: 500, smallerGb: 250, largerGb: 1000, budgets: [50, 55, 60] },
  { capacityGb: 1000, smallerGb: 500, largerGb: 2000, budgets: [80, 90, 100] },
  { capacityGb: 2000, smallerGb: 1000, largerGb: 4000, budgets: [130, 140, 150] },
] as const;

const BRANDS = [
  "Kinetic", "Lumen", "Northpeak", "Vaultline", "Arcwave", "Tidewater",
  "Photon", "Sable", "Quanta", "Ironclad", "Helix", "Nimbus",
] as const;

const SERIES = [
  "X1", "Go", "Pro", "Edge", "Rugged", "Mini",
  "Flex", "Pocket", "Swift", "Nano", "Shield", "Pulse",
] as const;

const EVERYDAY_CONNECTIONS = [
  { name: "USB-C 3.2 Gen 2", readMBps: 1_050 },
  { name: "USB-C 3.2 Gen 2x2", readMBps: 2_000 },
] as const;

const FAST_CONNECTIONS = [
  { name: "USB4", readMBps: 3_800 },
  { name: "Thunderbolt 4", readMBps: 2_800 },
] as const;

/** FNV-1a, 32-bit. Stable across platforms and Node versions. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 over a hashed seed. */
class SeededRandom {
  private state: number;

  constructor(seed: string) {
    this.state = hashString(`arena-shop:${seed}`);
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    const low = Math.ceil(Math.min(min, max));
    const high = Math.floor(Math.max(min, max));
    return low + Math.floor(this.next() * (high - low + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const other = this.int(0, index);
      [copy[index], copy[other]] = [copy[other], copy[index]];
    }
    return copy;
  }
}

/** `dollars` rounded down to a price ending in `cents`: (81, 99) is $80.99. */
function priceEnding(dollars: number, cents: number): number {
  return (dollars - 1) * 100 + cents;
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function isSortedByPrice(products: readonly ShopProduct[]): boolean {
  const prices = products.map((product) => product.priceCents);
  const ascending = prices.every((price, index) => index === 0 || prices[index - 1] <= price);
  const descending = prices.every((price, index) => index === 0 || prices[index - 1] >= price);
  return ascending || descending;
}

type Draft = Omit<ShopProduct, "id" | "name" | "brand" | "rating" | "reviewCount" | "capacityLabel">;

export function shopCatalogueForSeed(seed: string): ShopCatalogue {
  const rng = new SeededRandom(seed);
  const tier = rng.pick(TARGET_TIERS);
  const budget = rng.pick(tier.budgets);
  const budgetCents = budget * 100;
  const everyday = () => rng.pick(EVERYDAY_CONNECTIONS);
  const fast = () => rng.pick(FAST_CONNECTIONS);

  // Target price: 6-16% under budget. Every other price is placed relative to
  // it, so the target is always the unique cheapest new listing of the right
  // capacity under budget, and each distractor misses by exactly one rule.
  const targetDollars = budget - rng.int(Math.ceil(budget * 0.06), Math.floor(budget * 0.16));
  const drafts: Draft[] = [];
  const add = (
    kind: ShopProductKind,
    capacityGb: number,
    priceCents: number,
    connection: { name: string; readMBps: number },
    extra: Partial<Draft> = {},
  ) => {
    drafts.push({
      kind,
      capacityGb,
      priceCents,
      condition: "new",
      connection: connection.name,
      readMBps: connection.readMBps,
      ...extra,
    });
  };

  add("target", tier.capacityGb, priceEnding(targetDollars, 99), everyday(),
    rng.next() < 0.5
      ? { listPriceCents: priceEnding(targetDollars + rng.int(Math.round(budget * 0.12), Math.round(budget * 0.3)), 99) }
      : {});
  add("not-cheapest", tier.capacityGb, priceEnding(rng.int(targetDollars + 1, budget), 99), everyday());
  add("refurbished", tier.capacityGb,
    priceEnding(rng.int(targetDollars - Math.max(3, Math.round(budget * 0.14)), targetDollars - 1), 99),
    everyday(), { condition: "refurbished" });
  add("smaller-capacity", tier.smallerGb,
    priceEnding(rng.int(Math.round(targetDollars * 0.5), targetDollars - 2), 95), everyday());
  add("just-over-budget", tier.capacityGb, budgetCents + rng.pick([99, 149, 249, 399]), everyday(),
    rng.next() < 0.5 ? { listPriceCents: priceEnding(budget + rng.int(10, 25), 99) } : {});
  add("premium", tier.capacityGb,
    priceEnding(budget + rng.int(Math.round(budget * 0.25), Math.round(budget * 0.5)), 99), fast());
  add("larger-on-sale", tier.largerGb, priceEnding(rng.int(targetDollars + 1, budget), 49), everyday(), {
    listPriceCents: priceEnding(Math.round((budget * rng.int(150, 190)) / 100), 99),
  });
  add("larger-capacity", tier.largerGb,
    priceEnding(Math.round((budget * rng.int(165, 210)) / 100), 99), everyday());

  const brands = rng.shuffle(BRANDS);
  const series = rng.shuffle(SERIES);
  const usedIds = new Set<string>();
  const products = drafts.map((draft, index): ShopProduct => {
    const capacity = CAPACITIES[draft.capacityGb];
    const name = `${brands[index]} ${series[index]} Portable SSD ${capacity.compact}`;
    let id = `vm-${hashString(`${seed}|${index}|${name}`).toString(16).padStart(8, "0").slice(0, 6)}`;
    while (usedIds.has(id)) id = `${id}${index}`;
    usedIds.add(id);
    return {
      ...draft,
      id,
      name,
      brand: brands[index],
      capacityLabel: capacity.label,
      rating: rng.int(39, 49) / 10,
      reviewCount: rng.int(40, 4_800),
    };
  });

  const listed = rng.shuffle(products);
  if (isSortedByPrice(listed)) [listed[0], listed[1]] = [listed[1], listed[0]];

  const target = products[0];
  return {
    seed,
    constraint: {
      capacityGb: tier.capacityGb,
      capacityLabel: CAPACITIES[tier.capacityGb].label,
      budgetCents,
      condition: "new",
    },
    products: listed,
    correctProductId: target.id,
  };
}

/** Whether a listing meets the capacity, condition and budget rules. */
export function isEligibleShopProduct(product: ShopProduct, constraint: ShopConstraint): boolean {
  return product.condition === constraint.condition &&
    product.capacityGb === constraint.capacityGb &&
    product.priceCents < constraint.budgetCents;
}

/** Whether a listing is the cheapest eligible one, i.e. the task's answer. */
export function satisfiesShopTask(product: ShopProduct, catalogue: ShopCatalogue): boolean {
  if (!isEligibleShopProduct(product, catalogue.constraint)) return false;
  return catalogue.products.every((other) =>
    other.id === product.id ||
    !isEligibleShopProduct(other, catalogue.constraint) ||
    other.priceCents > product.priceCents);
}

/** The id of the one product the task asks for. */
export function shopCorrectProductId(seed: string): string {
  return shopCatalogueForSeed(seed).correctProductId;
}

export function shopTaskForSeed(seed: string): ShopTask {
  const { constraint, products } = shopCatalogueForSeed(seed);
  const capacity = constraint.capacityLabel;
  const budget = `$${constraint.budgetCents / 100}`;
  const smaller = products.find((product) => product.kind === "smaller-capacity")?.capacityLabel ?? "smaller";
  return {
    title: `Buy the cheapest new ${capacity} portable SSD under ${budget} with standard shipping`,
    task:
      `On the ${SHOP_STORE_NAME} store, buy the cheapest new (not refurbished) ${capacity} portable SSD ` +
      `priced under ${budget}. Put exactly one in the cart, check out with Standard shipping, and ship it to ` +
      `${SHOP_SHIP_TO.name}, ${SHOP_SHIP_TO.address}.`,
    taskDetail:
      `Search ${SHOP_STORE_NAME} for portable SSDs and compare capacity, condition and price across ` +
      `${products.length} listings. Open the cheapest new ${capacity} drive under ${budget}, add one to the ` +
      `cart, enter the shipping name and address, and place the order with Standard shipping. Near misses ` +
      `include a refurbished ${capacity} drive, a cheaper ${smaller} drive and a ${capacity} drive just over budget.`,
    successCondition:
      `${SHOP_STORE_NAME} confirms an order for exactly one unit of the cheapest new ${capacity} portable SSD ` +
      `under ${budget}, shipped Standard.`,
    checkpointLabels: [...SHOP_CHECKPOINT_LABELS],
    checkpointCount: SHOP_CHECKPOINT_COUNT,
  };
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "for", "with", "under", "below", "less", "than",
  "over", "buy", "cheapest", "cheap", "best", "new", "find", "me", "i", "want",
  "to", "of", "on", "in", "at", "by", "from", "price", "priced", "standard",
  "shipping", "ship", "store", "voltmart", "please", "one", "exactly", "not",
]);

function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/(\d+)\s*-?\s*(tb|gb)\b/g, "$1$2")
    .split(/[^a-z0-9$.]+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ""))
    .filter((token) =>
      token.length > 0 &&
      !STOP_WORDS.has(token) &&
      !token.startsWith("$") &&
      !/^\d+(\.\d+)?$/.test(token));
}

function productTokens(product: ShopProduct): string[] {
  const capacity = CAPACITIES[product.capacityGb]?.compact.toLowerCase() ?? "";
  return [
    ...product.name.toLowerCase().split(/[^a-z0-9]+/),
    capacity,
    "ssd", "ssds", "portable", "external", "drive", "drives", "storage", "usb", "usbc",
    ...(product.condition === "refurbished" ? ["refurbished", "renewed", "used"] : []),
    ...(product.listPriceCents !== undefined ? ["deal", "deals", "sale"] : []),
  ].filter(Boolean);
}

/**
 * Forgiving keyword search. A listing matches when any meaningful query word
 * matches one of its words (exactly, or as a prefix of at least 3 letters).
 * Results keep the Featured order; an empty query lists everything.
 */
export function searchShopProducts(catalogue: ShopCatalogue, query: string): ShopProduct[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [...catalogue.products];
  return catalogue.products.filter((product) => {
    const words = productTokens(product);
    return tokens.some((token) =>
      words.some((word) => word === token || (token.length >= 3 && word.startsWith(token))));
  });
}
