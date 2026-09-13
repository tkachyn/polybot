import { describe, expect, it } from "vitest";
import { NAV_ROUTE_PATTERNS, isNavTabActive } from "./navigation";

const TABS = Object.keys(NAV_ROUTE_PATTERNS);
const activeTabs = (pathname: string) => TABS.filter((to) => isNavTabActive(to, pathname));

describe("isNavTabActive", () => {
  it("lights each tab on its own route", () => {
    expect(activeTabs("/")).toEqual(["/"]);
    expect(activeTabs("/portfolio")).toEqual(["/portfolio"]);
    expect(activeTabs("/evaluations")).toEqual(["/evaluations"]);
    expect(activeTabs("/resolved")).toEqual(["/resolved"]);
    expect(activeTabs("/wallet")).toEqual(["/wallet"]);
  });

  it("keeps Fights lit on a fight and its standings", () => {
    expect(activeTabs("/fights/sim-00v-99a63e")).toEqual(["/"]);
    expect(activeTabs("/fights/sim-00v-99a63e/standings")).toEqual(["/"]);
  });

  it("tolerates a trailing slash", () => {
    expect(activeTabs("/portfolio/")).toEqual(["/portfolio"]);
  });

  it("lights nothing on an address that isn't a real route", () => {
    for (const path of ["/portfolio/extra/segments", "/wallet/x", "/resolved/2", "/fights", "/fights/a/b", "/leaderboard", "/nope"]) {
      expect(activeTabs(path)).toEqual([]);
    }
  });
});
