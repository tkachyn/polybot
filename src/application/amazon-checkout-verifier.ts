import type { RacerSessionHandle } from "./contracts.js";
import { JudgeOnlySiteVerifier } from "./judge-only-site-verifier.js";

/**
 * Best-effort visible-state verifier for Amazon's first two milestones.
 * Amazon's checkout click is handled separately because it immediately
 * navigates to a sign-in page.
 */
export class AmazonCheckoutVerifier extends JudgeOnlySiteVerifier {
  override async verifyTargetOpening(input: {
    raceId: string;
    racerId: string;
    courseId: string;
    seed?: string;
    session: RacerSessionHandle;
  }): Promise<boolean> {
    return this.productPageVisible(input.session);
  }

  override async verifyCheckpoint(input: {
    raceId: string;
    racerId: string;
    courseId: string;
    checkpoint: number;
    seed?: string;
    session: RacerSessionHandle;
  }): Promise<boolean> {
    if (input.checkpoint === 1) return this.productPageVisible(input.session);
    if (input.checkpoint === 2) return this.cartPageVisible(input.session);
    // Checkpoint 3 is claimed atomically by reportTerminalAction.
    return false;
  }

  private async productPageVisible(session: RacerSessionHandle): Promise<boolean> {
    const page = session.page;
    if (!page) return false;
    const path = pagePath(page);
    const body = await page.locator("body").innerText().catch(() => "");
    return /\/(?:dp|gp\/product)\//.test(path) ||
      /\/(?:cart|gp\/cart)\//.test(path) ||
      /\badd\s+to\s+cart\b/i.test(body);
  }

  private async cartPageVisible(session: RacerSessionHandle): Promise<boolean> {
    const page = session.page;
    if (!page) return false;
    const path = pagePath(page);
    if (/\/(?:cart|gp\/cart)\//.test(path)) return true;
    const body = await page.locator("body").innerText().catch(() => "");
    return /\bshopping\s+cart\b/i.test(body) && /\bproceed\s+to\s+checkout\b/i.test(body);
  }
}

function pagePath(page: NonNullable<RacerSessionHandle["page"]>): string {
  try {
    return new URL(page.url()).pathname.toLowerCase();
  } catch {
    return "";
  }
}
