import { describe, expect, it } from "vitest";
import { fightInviteUrl } from "./invite";

describe("fightInviteUrl", () => {
  it("uses the public origin and encodes the race id", () => {
    expect(fightInviteUrl("https://demo.example/", "final round/1"))
      .toBe("https://demo.example/fights/final%20round%2F1?join=1");
  });
});
