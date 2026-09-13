import { describe, expect, it } from "vitest";
import { pickActiveHost } from "./viewerLayer";

describe("pickActiveHost", () => {
  it("lays the viewer over the newest visible host", () => {
    const grid = { name: "grid", concealed: false, order: 1 };
    const focus = { name: "focus", concealed: false, order: 2 };
    expect(pickActiveHost([grid, focus])?.name).toBe("focus");
    expect(pickActiveHost([focus, grid])?.name).toBe("focus");
  });

  it("skips a concealed host, so the grid pane under the focus view gives it up", () => {
    const grid = { name: "grid", concealed: true, order: 1 };
    const focus = { name: "focus", concealed: false, order: 2 };
    expect(pickActiveHost([grid, focus])?.name).toBe("focus");
    expect(pickActiveHost([grid])).toBeNull();
    expect(pickActiveHost([{ ...grid, concealed: false }])?.name).toBe("grid");
  });

  it("has no host to show without hosts", () => {
    expect(pickActiveHost([])).toBeNull();
  });
});
