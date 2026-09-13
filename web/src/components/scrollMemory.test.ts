import { describe, expect, it } from "vitest";
import { ScrollMemory, restoreTarget } from "./scrollMemory";

describe("ScrollMemory", () => {
  it("remembers the latest offset per history entry", () => {
    const memory = new ScrollMemory();
    memory.save("a", 120);
    memory.save("b", 1400.4);
    memory.save("a", 300);
    expect(memory.get("a")).toBe(300);
    expect(memory.get("b")).toBe(1400);
    expect(memory.get("c")).toBeUndefined();
  });

  it("ignores values that aren't offsets and clamps negatives", () => {
    const memory = new ScrollMemory();
    memory.save("a", Number.NaN);
    memory.save("b", -12);
    expect(memory.get("a")).toBeUndefined();
    expect(memory.get("b")).toBe(0);
  });

  it("drops the least recently saved entries past its limit", () => {
    const memory = new ScrollMemory(2);
    memory.save("a", 1);
    memory.save("b", 2);
    memory.save("a", 3);
    memory.save("c", 4);
    expect(memory.size).toBe(2);
    expect(memory.get("b")).toBeUndefined();
    expect(memory.get("a")).toBe(3);
    expect(memory.get("c")).toBe(4);
  });
});

describe("restoreTarget", () => {
  const memory = new ScrollMemory();
  memory.save("resolved", 1400);
  memory.save("top", 0);

  it("returns to the saved offset on Back and Forward", () => {
    expect(restoreTarget(memory, "resolved", "POP")).toBe(1400);
  });

  it("leaves a link or a replace where the page renders", () => {
    expect(restoreTarget(memory, "resolved", "PUSH")).toBeNull();
    expect(restoreTarget(memory, "resolved", "REPLACE")).toBeNull();
  });

  it("has nothing to do for an unknown entry or the top", () => {
    expect(restoreTarget(memory, "fresh", "POP")).toBeNull();
    expect(restoreTarget(memory, "top", "POP")).toBeNull();
  });
});
