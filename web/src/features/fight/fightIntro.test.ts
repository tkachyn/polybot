import { describe, expect, it } from "vitest";
import { fightIntroSeenKey, shouldOpenFightIntro } from "./fightIntroState";

describe("fight intro", () => {
  it("opens once the fight is live and has not been watched", () => {
    expect(shouldOpenFightIntro("live", false)).toBe(true);
    expect(shouldOpenFightIntro("live", true)).toBe(false);
    expect(shouldOpenFightIntro("upcoming", false)).toBe(false);
    expect(shouldOpenFightIntro("resolved", false)).toBe(false);
  });

  it("stores each fight independently", () => {
    expect(fightIntroSeenKey("fight-1")).toBe("sm.fightIntro.fight-1");
    expect(fightIntroSeenKey("fight-2")).not.toBe(fightIntroSeenKey("fight-1"));
  });
});
