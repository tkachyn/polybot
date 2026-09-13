import { describe, expect, it } from "vitest";
import { fightRouteView } from "./route";

describe("fight route", () => {
  it("shows the fight while the lobby has it", () => {
    const here = { raceId: "race-1", fightNotFound: false, archive: "idle" as const };
    expect(fightRouteView({ ...here, fightStatus: null })).toBe("loading");
    expect(fightRouteView({ ...here, fightStatus: "live" })).toBe("live");
    expect(fightRouteView({ ...here, fightStatus: "upcoming" })).toBe("live");
    expect(fightRouteView({ ...here, fightStatus: "resolved" })).toBe("resolved");
  });

  it("falls back to the stored final report once the fight has left the lobby", () => {
    const gone = { raceId: "race-1", fightNotFound: true, fightStatus: null };
    expect(fightRouteView({ ...gone, archive: "idle" })).toBe("archive_loading");
    expect(fightRouteView({ ...gone, archive: "loading" })).toBe("archive_loading");
    expect(fightRouteView({ ...gone, archive: "ready" })).toBe("archived");
    // A failed lookup is not "not found": the report may exist, so it offers a retry.
    expect(fightRouteView({ ...gone, archive: "error" })).toBe("archive_error");
  });

  it("says not found only when neither the fight nor its report exists", () => {
    expect(fightRouteView({ raceId: "race-1", fightNotFound: true, fightStatus: null, archive: "not_found" })).toBe("not_found");
    expect(fightRouteView({ raceId: undefined, fightNotFound: false, fightStatus: null, archive: "idle" })).toBe("not_found");
    expect(fightRouteView({ raceId: "", fightNotFound: false, fightStatus: null, archive: "idle" })).toBe("not_found");
  });
});
