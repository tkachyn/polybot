import type { ApiCreateRaceInput } from "../api/race-registry.js";

export const AMAZON_CHECKOUT_COURSE_ID = "amazon-checkout";

export function isAmazonCheckoutRun(input: Pick<ApiCreateRaceInput, "courseId" | "startUrl">): boolean {
  if (input.courseId === AMAZON_CHECKOUT_COURSE_ID) return true;
  try {
    return new URL(input.startUrl).hostname === "amazon.com" ||
      new URL(input.startUrl).hostname.endsWith(".amazon.com");
  } catch {
    return false;
  }
}
