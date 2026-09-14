import { describe, expect, it } from "vitest";
import { slipPriceLabel, tradingBlockedReason } from "./market";

describe("slip price label", () => {
  it("calls only an open market's price live", () => {
    expect(slipPriceLabel("open")).toBe("Live");
    expect(slipPriceLabel("frozen")).toBe("Frozen");
    expect(slipPriceLabel("resolved")).toBe("Closed");
    expect(slipPriceLabel("unresolved")).toBe("Closed");
  });

  it("agrees with the reason trading is blocked", () => {
    expect(tradingBlockedReason("open")).toBeNull();
    expect(tradingBlockedReason("frozen")).toBe("Trading frozen");
  });
});
