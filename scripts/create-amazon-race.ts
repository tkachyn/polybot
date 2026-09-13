import "dotenv/config";
import { randomBytes } from "node:crypto";
import { AMAZON_CHECKOUT_COURSE_ID } from "../src/application/site-modes.js";

// Creates a live fight whose four racers attempt the same Amazon checkout
// journey. Two bounded sabotages fire at the first two milestones. The runner
// stops on the checkout click, before Amazon's sign-in page and any order.

const AMAZON_SEARCHES = [
  "USB C charging cable",
  "wireless computer mouse",
  "reusable water bottle",
  "phone stand",
  "notebook",
  "LED desk lamp",
] as const;

function fail(message: string): never {
  console.error(`race:amazon: ${message}`);
  process.exit(1);
}

const apiUrl = (process.env.API_URL?.trim() || "http://127.0.0.1:3001").replace(/[/]+$/, "");
const seed = process.env.SEED?.trim() || `amazon-${randomBytes(4).toString("hex")}`;
const query = process.env.AMAZON_QUERY?.trim() ||
  AMAZON_SEARCHES[hash(seed) % AMAZON_SEARCHES.length]!;
const raceId = `amazon-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const startUrl = new URL("https://www.amazon.com/s");
startUrl.searchParams.set("k", query);
startUrl.searchParams.set("ref", "nb_sb_noss");

const body = {
  raceId,
  courseId: AMAZON_CHECKOUT_COURSE_ID,
  seed,
  checkpointCount: 3,
  task: `On Amazon.com, find an in-stock "${query}" item, choose one listing under $50, add exactly one to the cart, and proceed to checkout. Stop on the checkout or order-review page before placing the order. Do not sign in, enter personal or payment information, or submit an order.`,
  title: `Amazon checkout: ${query}`,
  taskDetail: "Four browser agents compete to reach checkout for the same randomly selected product category.",
  successCondition: "The agent clicks Amazon's checkout control without signing in, entering payment details, or placing an order.",
  checkpointLabels: ["Product selected", "Item added to cart", "Checkout clicked"],
  startUrl: startUrl.toString(),
  obstaclesEnabled: true,
  sabotageSchedule: { maxSteps: 2, includeFinalCheckpoint: false },
};

let response: Response;
try {
  response = await fetch(`${apiUrl}/races`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
} catch (error) {
  fail(`could not reach the API at ${apiUrl} (${error instanceof Error ? error.message : String(error)})`);
}

const text = await response.text();
if (!response.ok) {
  let detail = text.trim() || response.statusText;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; code?: unknown };
    if (typeof parsed.error === "string") {
      detail = typeof parsed.code === "string" ? `${parsed.error} (${parsed.code})` : parsed.error;
    }
  } catch {
    // Keep the raw response when it is not JSON.
  }
  fail(`the API rejected the race with HTTP ${response.status}: ${detail}`);
}

console.log(`Race created: ${raceId}`);
console.log(`Search:       ${query}`);
console.log(`Start URL:    ${startUrl}`);
console.log(`Status:       ${apiUrl}/races/${encodeURIComponent(raceId)}`);
console.log(`Fight:        http://localhost:5173/fights/${encodeURIComponent(raceId)}`);

function hash(value: string): number {
  return [...value].reduce((total, character) => total + character.charCodeAt(0), 0);
}
