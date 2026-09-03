import { describe, it, expect } from "vitest";
import { getSpeedGrade, ALL_GRADES } from "../../src/grade";

describe("getSpeedGrade", () => {
  it("returns Kachow! for 500+ TPS", () => {
    expect(getSpeedGrade(500).label).toBe("Kachow!");
    expect(getSpeedGrade(1800).label).toBe("Kachow!");
    // Cerebras routinely exceeds 2000 tok/s — must still be top tier
    expect(getSpeedGrade(2602.2).label).toBe("Kachow!");
    expect(getSpeedGrade(4999).label).toBe("Kachow!");
    expect(getSpeedGrade(500).tier).toBe(1);
  });

  it("returns Ludicrous Speed for 200-499 TPS", () => {
    expect(getSpeedGrade(200).label).toBe("Ludicrous Speed");
    expect(getSpeedGrade(499).label).toBe("Ludicrous Speed");
  });

  it("returns Warp Drive for 100-199 TPS", () => {
    expect(getSpeedGrade(100).label).toBe("Warp Drive");
    expect(getSpeedGrade(199).label).toBe("Warp Drive");
  });

  it("returns Cruising for 50-99 TPS", () => {
    expect(getSpeedGrade(50).label).toBe("Cruising");
    expect(getSpeedGrade(99).label).toBe("Cruising");
  });

  it("returns Rush Hour for <50 TPS", () => {
    expect(getSpeedGrade(49).label).toBe("Rush Hour");
    expect(getSpeedGrade(1).label).toBe("Rush Hour");
    expect(getSpeedGrade(0.5).label).toBe("Rush Hour");
  });

  it("returns boundary values correctly", () => {
    expect(getSpeedGrade(49.9).label).toBe("Rush Hour");
    expect(getSpeedGrade(50).label).toBe("Cruising");
    expect(getSpeedGrade(99.9).label).toBe("Cruising");
    expect(getSpeedGrade(100).label).toBe("Warp Drive");
  });

  it("every grade has required fields", () => {
    for (const grade of ALL_GRADES) {
      expect(grade.label).toBeTruthy();
      expect(grade.emoji).toBeTruthy();
      expect(grade.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(grade.tier).toBeGreaterThan(0);
    }
  });

  it("tiers are sequential 1 through N", () => {
    const tiers = ALL_GRADES.map((g) => g.tier);
    expect(tiers).toEqual([1, 2, 3, 4, 5]);
  });
});
