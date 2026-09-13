import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { AmazonCheckoutVerifier } from "../src/application/amazon-checkout-verifier.js";
import type { RacerSessionHandle } from "../src/application/contracts.js";

function session(url: string, body: string): RacerSessionHandle {
  const page = {
    url: () => url,
    locator: () => ({ innerText: async () => body }),
  } as unknown as Page;
  return { racerId: "racer-1", steelSessionId: "steel-1", page };
}

test("verifies Amazon product and cart milestones from visible page state", async () => {
  const verifier = new AmazonCheckoutVerifier();
  assert.equal(
    await verifier.verifyCheckpoint({
      raceId: "race-1",
      racerId: "racer-1",
      courseId: "amazon-checkout",
      checkpoint: 1,
      session: session("https://www.amazon.com/dp/B001", "Add to Cart"),
    }),
    true,
  );
  assert.equal(
    await verifier.verifyCheckpoint({
      raceId: "race-1",
      racerId: "racer-1",
      courseId: "amazon-checkout",
      checkpoint: 2,
      session: session("https://www.amazon.com/gp/cart/view.html", "Shopping Cart"),
    }),
    true,
  );
});

test("leaves the checkout milestone to the click terminal action", async () => {
  const verifier = new AmazonCheckoutVerifier();
  assert.equal(verifier.coversRun(), false);
  assert.equal(
    await verifier.verifyCheckpoint({
      raceId: "race-1",
      racerId: "racer-1",
      courseId: "amazon-checkout",
      checkpoint: 3,
      session: session("https://www.amazon.com/gp/cart/view.html", "Proceed to checkout"),
    }),
    false,
  );
});
