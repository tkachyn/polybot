import { describe, expect, it } from "vitest";
import { AGENT_PALETTE, FALLBACK_AGENT_COLORS, agentColor, agentMonogram, agentStyle, agentVisual, rosterVisuals, withAlpha } from "./agents";

describe("agent identity", () => {
  it("uses the handoff colours and monograms", () => {
    expect(agentVisual("gpt")).toMatchObject({ color: "#7fd1c1", monogram: "GP", known: true });
    expect(agentVisual("claude")).toMatchObject({ color: "#e8c07a", monogram: "CL" });
    expect(agentVisual("gemini")).toMatchObject({ color: "#79a8e8", monogram: "GE" });
    expect(agentVisual({ key: "GROK", name: "Grok 4.1" })).toMatchObject({ color: "#b39ae0", monogram: "GR" });
  });

  it("derives 12% fill and 33% border", () => {
    const v = agentVisual("gpt");
    expect(v.fill).toBe("rgba(127, 209, 193, 0.12)");
    expect(v.border).toBe("rgba(127, 209, 193, 0.33)");
    expect(withAlpha("#fff", 0.5)).toBe("rgba(255, 255, 255, 0.5)");
  });

  it("gives unknown keys a deterministic fallback", () => {
    const a = agentColor("mistral");
    expect(agentColor("mistral")).toBe(a);
    expect(FALLBACK_AGENT_COLORS).toContain(a);
    expect(Object.values(AGENT_PALETTE).map((p) => p.color)).not.toContain(a);
    expect(agentMonogram("x-1", "Mistral Large")).toBe("MI");
    expect(agentMonogram("??")).toBe("?");
  });

  it("keeps roster colours distinct", () => {
    const visuals = rosterVisuals([{ key: "gpt" }, { key: "a1" }, { key: "a2" }, { key: "a3" }]);
    expect(visuals[0]?.color).toBe("#7fd1c1");
    expect(new Set(visuals.map((v) => v.color)).size).toBe(4);
  });

  it("exposes CSS custom properties", () => {
    expect(agentStyle("claude")).toMatchObject({ "--agent-color": "#e8c07a" });
  });
});
