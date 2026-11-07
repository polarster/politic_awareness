import { describe, expect, it } from "vitest";
import { labelWidth, placeLabels } from "./Spectrum";

describe("placeLabels", () => {
  it("同一排的標籤不重疊，而且不超出寬度", () => {
    const names = ["國民黨", "民進黨", "民眾黨", "時代力量", "台灣基進", "綠黨", "社民黨", "小民參", "親民黨", "新黨"];
    const items = names.map((label, i) => ({ id: String(i), label, value: -0.4 + (i % 4) * 0.15 }));
    const width = 320;
    const placed = placeLabels(items, width);
    for (const a of placed) {
      expect(a.left).toBeGreaterThanOrEqual(0);
      expect(a.left + labelWidth(a.label)).toBeLessThanOrEqual(width + 0.001);
      for (const b of placed) {
        if (a === b || a.lane !== b.lane) continue;
        const overlap = a.left < b.left + labelWidth(b.label) && b.left < a.left + labelWidth(a.label);
        expect(overlap).toBe(false);
      }
    }
    expect(new Set(placed.map((p) => p.lane)).size).toBeGreaterThan(1); // 擠在一起時會分到多排
  });
});
