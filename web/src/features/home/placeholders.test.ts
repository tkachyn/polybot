import { describe, expect, it } from "vitest";
import type { FightDetail } from "@contract";
import { slipFromParam, formatSlipParam } from "../market/slipParam";
import { formatChance } from "./FeaturedFightCard";
import { PLACEHOLDER_TEMPLATES, buildPlaceholderFights, placeholderNumbers } from "./placeholders";

const NOW = 1_800_000_000_000;

describe("placeholder fights", () => {
  const fights = buildPlaceholderFights(NOW, 412);

  it("builds one card per template, in lobby order", () => {
    expect(fights.map((f) => f.status)).toEqual(["live", "live", "upcoming", "upcoming", "resolved", "resolved"]);
    expect(fights).toHaveLength(PLACEHOLDER_TEMPLATES.length);
  });

  it("respects the handoff's text bounds and four agents", () => {
    for (const fight of fights) {
      expect(fight.title.length).toBeLessThanOrEqual(90);
      expect(fight.sabotage?.summary?.length ?? 0).toBeLessThanOrEqual(70);
      expect(fight.agents).toHaveLength(4);
    }
  });

  it("keeps YES prices summing to ~100¢ and NO = 1 - YES", () => {
    for (const fight of fights) {
      const sum = fight.agents.reduce((total, a) => total + a.yes, 0);
      expect(sum).toBeCloseTo(1, 6);
      for (const a of fight.agents) expect(a.no).toBeCloseTo(1 - a.yes, 6);
    }
  });

  it("never reuses the featured fight's number and stays positive", () => {
    for (const base of [1, 2, 5, 412]) {
      const numbers = placeholderNumbers(base);
      expect(new Set(numbers).size).toBe(numbers.length);
      expect(numbers).not.toContain(base);
      expect(Math.min(...numbers)).toBeGreaterThan(0);
    }
  });

  it("places times relative to now", () => {
    const [live, , upcoming, , resolved, voided] = fights;
    expect(live!.startedAt).toBeLessThan(NOW);
    expect(upcoming!.startsAt).toBeGreaterThan(NOW);
    expect(resolved!.finishedAt).toBeLessThan(NOW);
    expect(resolved!.winnerRacerId).toBe("racer-2");
    expect(voided!.voided).toBe(true);
    expect(voided!.marketStatus).toBe("unresolved");
  });
});

describe("slip param", () => {
  const fight = {
    marketStatus: "open",
    agents: [
      { racerId: "racer-1", yes: 0.3, no: 0.7 },
      { racerId: "racer-2", yes: 0.2, no: 0.8 },
    ],
  } as unknown as Pick<FightDetail, "agents" | "marketStatus">;

  it("round-trips a valid outcome", () => {
    expect(slipFromParam(fight, formatSlipParam("racer-2", "no"))).toEqual({ racerId: "racer-2", side: "no", price: 0.8 });
    expect(slipFromParam(fight, "racer-1:yes")).toEqual({ racerId: "racer-1", side: "yes", price: 0.3 });
  });

  it("ignores bad values and closed markets", () => {
    expect(slipFromParam(fight, null)).toBeNull();
    expect(slipFromParam(fight, "racer-9:yes")).toBeNull();
    expect(slipFromParam(fight, "racer-1:maybe")).toBeNull();
    expect(slipFromParam({ ...fight, marketStatus: "frozen" }, "racer-1:yes")).toBeNull();
  });
});

describe("formatChance", () => {
  it("shows whole percents with clamped ends", () => {
    expect(formatChance(0.344)).toBe("34%");
    expect(formatChance(0.001)).toBe("<1%");
    expect(formatChance(0.999)).toBe(">99%");
    expect(formatChance(0)).toBe("0%");
  });
});
