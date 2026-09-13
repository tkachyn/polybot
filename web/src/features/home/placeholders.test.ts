import { describe, expect, it } from "vitest";
import type { FightDetail } from "@contract";
import { slipFromParam, formatSlipParam } from "../market/slipParam";
import { formatChance } from "./FeaturedFightCard";
import { DISPLAYED_SABOTAGE_COUNT, sabotageProgress } from "./FightCard";
import {
  DEFAULT_PREVIEW_NUMBER,
  PLACEHOLDER_TEMPLATES,
  buildPlaceholderFights,
  placeholderNumbers,
  previewsAllowed,
} from "./placeholders";

const NOW = 1_800_000_000_000;

describe("placeholder fights", () => {
  const fights = buildPlaceholderFights(NOW, [412]);

  it("builds one card per template, in lobby order", () => {
    const rank = { live: 0, upcoming: 1, resolved: 2 } as const;
    const ranks = fights.map((f) => rank[f.status]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(fights).toHaveLength(PLACEHOLDER_TEMPLATES.length);
  });

  it("fills the upcoming section with many samples, soonest first", () => {
    const starts = fights.filter((f) => f.status === "upcoming").map((f) => f.startsAt!);
    expect(starts).toHaveLength(18);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
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

  it("uses ids that can never match a real fight", () => {
    for (const fight of fights) expect(fight.raceId.startsWith("preview-")).toBe(true);
  });

  it("places times relative to now", () => {
    const live = fights.find((f) => f.status === "live");
    const [resolved, voided] = fights.filter((f) => f.status === "resolved");
    expect(live!.startedAt).toBeLessThan(NOW);
    for (const upcoming of fights.filter((f) => f.status === "upcoming")) {
      expect(upcoming.startsAt).toBeGreaterThan(NOW);
    }
    expect(resolved!.finishedAt).toBeLessThan(NOW);
    expect(resolved!.winnerRacerId).toBe("racer-2");
    expect(voided!.voided).toBe(true);
    expect(voided!.marketStatus).toBe("unresolved");
  });

  it("shows sabotage progress against the two-step demo limit", () => {
    const [armedLive, firedLive, upcoming] = fights;
    expect(DISPLAYED_SABOTAGE_COUNT).toBe(2);
    expect(sabotageProgress(armedLive!.sabotage)).toBe(0);
    expect(sabotageProgress(firedLive!.sabotage)).toBe(1);
    expect(sabotageProgress(upcoming!.sabotage)).toBe(0);
    expect(sabotageProgress(null)).toBe(0);
  });
});

describe("placeholderNumbers", () => {
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const upcomingIndexes = PLACEHOLDER_TEMPLATES.flatMap((t, i) => (t.status === "upcoming" ? [i] : []));

  const cases: Record<string, number[]> = {
    "no fights yet": [],
    "one fight": [412],
    "the QA lobby (#0428-#0459)": range(401, 459),
    "fights from #1": [1, 2, 3],
    "a single #1": [1],
    "a sparse lobby": [3, 7, 8, 40, 41, 43],
  };

  for (const [name, real] of Object.entries(cases)) {
    it(`never collides with a real fight: ${name}`, () => {
      const numbers = placeholderNumbers(real);
      expect(numbers).toHaveLength(PLACEHOLDER_TEMPLATES.length);
      expect(new Set(numbers).size).toBe(numbers.length);
      for (const n of numbers) {
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThan(0);
        expect(real).not.toContain(n);
      }
    });
  }

  it("numbers upcoming previews after the newest real fight", () => {
    const numbers = placeholderNumbers(range(428, 459));
    expect(upcomingIndexes.map((i) => numbers[i])).toEqual(range(460, 459 + upcomingIndexes.length));
  });

  it("numbers the others below the oldest real fight when there is room", () => {
    const numbers = placeholderNumbers([428, 429, 430]);
    const others = numbers.filter((_, i) => !upcomingIndexes.includes(i));
    for (const n of others) expect(n).toBeLessThan(428);
  });

  it("sits around the default number when the backend has no fight", () => {
    const numbers = placeholderNumbers([]);
    expect(upcomingIndexes.map((i) => numbers[i])).toEqual(
      range(DEFAULT_PREVIEW_NUMBER, DEFAULT_PREVIEW_NUMBER + upcomingIndexes.length - 1),
    );
  });

  it("ignores values that are not fight numbers", () => {
    expect(placeholderNumbers([Number.NaN, -3, 0, 2.5, 10])).not.toContain(10);
  });
});

describe("previewsAllowed", () => {
  it("never while the lobby is loading", () => {
    expect(previewsAllowed({ loaded: false, error: null })).toBe(false);
  });

  it("never while the server is unreachable, loaded or not", () => {
    const error = new Error("Can't reach the server");
    expect(previewsAllowed({ loaded: false, error })).toBe(false);
    expect(previewsAllowed({ loaded: true, error })).toBe(false);
  });

  it("on a loaded, healthy lobby", () => {
    expect(previewsAllowed({ loaded: true, error: null })).toBe(true);
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
