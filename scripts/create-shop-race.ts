import "dotenv/config";
import { randomBytes } from "node:crypto";
import {
  SHOP_COURSE_ID,
  formatPrice,
  shopCatalogueForSeed,
  shopTaskForSeed,
} from "../src/course/shop-course.js";

// Creates a live fight on the arena-shop storefront course.
//
//   API_URL          arena API (default http://127.0.0.1:3001), running in live mode
//   COURSE_BASE_URL  PUBLIC URL of the course server: Steel cloud browsers load
//                    the store from it, so it must be reachable from the internet
//   SEED             optional catalogue seed (default: random)

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

function fail(message: string): never {
  console.error(`race:shop: ${message}`);
  process.exit(1);
}

const apiUrl = (process.env.API_URL?.trim() || "http://127.0.0.1:3001").replace(/[/]+$/, "");
const courseBase = process.env.COURSE_BASE_URL?.trim().replace(/[/]+$/, "") ?? "";
if (!courseBase) {
  fail("COURSE_BASE_URL is required: the public URL of the course server, for example an ngrok or cloudflared tunnel to port 4000.");
}

let courseUrl: URL;
try {
  courseUrl = new URL(courseBase);
} catch {
  fail(`COURSE_BASE_URL is not a valid URL: ${courseBase}`);
}
if (LOCAL_HOSTS.has(courseUrl.hostname) || courseUrl.hostname.endsWith(".local")) {
  console.warn(
    `Warning: COURSE_BASE_URL (${courseBase}) is a local address. Steel cloud browsers cannot reach it, ` +
      "so the racers will not load the store. Expose the course server through a tunnel and use that URL.",
  );
}

const seed = process.env.SEED?.trim() || `shop-${randomBytes(4).toString("hex")}`;
const raceId = `shop-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const task = shopTaskForSeed(seed);
const catalogue = shopCatalogueForSeed(seed);
const answer = catalogue.products.find((product) => product.id === catalogue.correctProductId);

const body = {
  raceId,
  courseId: SHOP_COURSE_ID,
  seed,
  checkpointCount: task.checkpointCount,
  task: task.task,
  title: task.title,
  taskDetail: task.taskDetail,
  successCondition: task.successCondition,
  checkpointLabels: task.checkpointLabels,
  // The runner appends raceId, racerId, seed, steelSessionId and checkpointCount.
  startUrl: `${courseBase}/?courseId=${SHOP_COURSE_ID}`,
  obstaclesEnabled: true,
};

console.log(`Creating ${raceId} on ${apiUrl} with seed ${seed}.`);
console.log("The API opens four Steel sessions before it answers, which can take up to a minute.");

let response: Response;
try {
  response = await fetch(`${apiUrl}/races`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  fail(`could not reach the API at ${apiUrl} (${reason}). Start it in live mode, for example with npm run dev:all.`);
}

const responseText = await response.text();
if (!response.ok) {
  let detail = responseText.trim() || response.statusText;
  try {
    const parsed = JSON.parse(responseText) as { error?: unknown; code?: unknown };
    if (typeof parsed.error === "string") {
      detail = typeof parsed.code === "string" ? `${parsed.error} (${parsed.code})` : parsed.error;
    }
  } catch {
    // Not JSON: keep the raw body.
  }
  fail(`the API rejected the race with HTTP ${response.status}: ${detail}`);
}

console.log(`Race created: ${raceId}`);
console.log(`Title:        ${task.title}`);
console.log(`Store:        ${body.startUrl}`);
if (answer) {
  console.log(`Answer key:   ${answer.name}, ${formatPrice(answer.priceCents)} (${answer.id})`);
}
console.log(`Status:       ${apiUrl}/races/${encodeURIComponent(raceId)}`);
console.log(`Fight:        http://localhost:5173/fights/${encodeURIComponent(raceId)}`);
