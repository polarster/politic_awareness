import { describe, expect, it } from "vitest";
import {
  axisScores, budgetAgreement, budgetBalance, matchEntity, questionAgreement,
} from "./scoring";
import type { AppData } from "./types";

const data: AppData = {
  version: "t",
  axes: [
    { id: "economy", name: "經濟", negative_pole: "重分配", positive_pole: "市場", layer: "national" },
    { id: "city_priority", name: "市政", negative_pole: "照顧", positive_pole: "成長", layer: "municipal" },
  ],
  questions: [
    { id: "E01", layer: "national", axis: "economy", direction: -1, text: "" },
    { id: "E03", layer: "national", axis: "economy", direction: 1, text: "" },
    { id: "G01", layer: "national", axis: null, direction: 0, text: "" },
  ],
  supplementary: [
    { id: "X01", layer: "national", axis: "economy", direction: -1, text: "" },
    { id: "X13", layer: "national", axis: null, direction: 0, text: "", reflection: true },
  ],
  discussions: [],
  votes: [],
  arguments: {},
  budget: {
    version: "t", start_balance: 0, min_final_balance: 0, steps: [-2, -1, 0, 1, 2],
    cities: [],
    items: [
      { id: "B_HOUSING", kind: "expense", name: "", cost_per_step: 1, axis: "city_priority", direction: -1 },
      { id: "B_TECH", kind: "expense", name: "", cost_per_step: 2, axis: "city_priority", direction: 1 },
      { id: "R_TAX", kind: "revenue", name: "", cost_per_step: 1, axis: null, direction: 0 },
      { id: "S_RES", kind: "surplus", name: "", cost_per_step: 1, axis: null, direction: 0, min_step: 0 },
    ],
  },
  entities: [{ id: "p", type: "party", name: "P" }],
  stances: {
    p: [
      { question: "E01", value: 2, interpretation: "", grade: "A", evidence: [] },
      { question: "G01", value: -2, interpretation: "", grade: "C", evidence: [] },
      { question: "B_HOUSING", value: 1, interpretation: "", grade: "C", evidence: [] },
    ],
  },
};

describe("budgetBalance", () => {
  it("expense 花點數、revenue 得點數、surplus 花點數", () => {
    expect(budgetBalance(data.budget, {})).toBe(0);
    expect(budgetBalance(data.budget, { B_HOUSING: 2 })).toBe(-2);
    expect(budgetBalance(data.budget, { B_TECH: -1 })).toBe(2);
    expect(budgetBalance(data.budget, { B_HOUSING: 2, R_TAX: 2 })).toBe(0);
    expect(budgetBalance(data.budget, { R_TAX: 1, S_RES: 1 })).toBe(0);
  });
});

describe("axisScores", () => {
  it("依方向與重要度加權平均", () => {
    const s = axisScores(data, {
      E01: { v: 2, imp: true }, // 同意重分配題 → -2，權重 2
      E03: { v: 2, imp: false }, // 同意市場題 → +2，權重 1
      G01: { v: 2, imp: false }, // 不計入
    }, null);
    const econ = s.find((x) => x.axis.id === "economy")!;
    expect(econ.value).toBeCloseTo((-4 + 2) / 3);
    expect(econ.count).toBe(2);
  });

  it("不知道不計分；沒作答時為 null", () => {
    const s = axisScores(data, { E01: { v: null, imp: true } }, null);
    expect(s.find((x) => x.axis.id === "economy")!.value).toBeNull();
  });

  it("預算步數計入對應軸", () => {
    const s = axisScores(data, {}, { B_HOUSING: 2, B_TECH: 0 });
    const city = s.find((x) => x.axis.id === "city_priority")!;
    expect(city.value).toBeCloseTo(-1); // (-2 + 0) / 2
  });

  it("可依層級分開計算", () => {
    const s = axisScores(data, { E01: { v: 2, imp: false } }, { B_HOUSING: 2 }, "national");
    expect(s.find((x) => x.axis.id === "economy")!.value).toBeCloseTo(-2);
    expect(s.find((x) => x.axis.id === "city_priority")!.value).toBeNull();
  });

  it("補充題計入維度", () => {
    const s = axisScores(data, { X01: { v: 1, imp: false } }, null);
    expect(s.find((x) => x.axis.id === "economy")!.value).toBeCloseTo(-1);
  });
});

describe("agreement", () => {
  it("題目一致度", () => {
    expect(questionAgreement(2, 2)).toBe(1);
    expect(questionAgreement(-2, 2)).toBe(0);
    expect(questionAgreement(0, 2)).toBe(0.5);
  });
  it("預算只比方向", () => {
    expect(budgetAgreement(2, 1)).toBe(1);
    expect(budgetAgreement(1, 1)).toBe(1);
    expect(budgetAgreement(0, 1)).toBe(0.5);
    expect(budgetAgreement(-1, 1)).toBe(0);
  });
});

describe("matchEntity", () => {
  it("只計算雙方都有值的題目，並回報覆蓋率", () => {
    const r = matchEntity(data, data.entities[0], "national", {
      E01: { v: 2, imp: false }, E03: { v: 1, imp: false }, G01: { v: 0, imp: true },
    }, null);
    // E01: 1（權重 1）、G01: 0.5（權重 2）；E03 對象無立場；X01 未作答不列入
    expect(r.score).toBeCloseTo((1 + 0.5 * 2) / 3);
    expect(r.compared).toBe(2);
    expect(r.total).toBe(3);
  });

  it("反思題不列入比對", () => {
    const r = matchEntity(data, data.entities[0], "national", { X13: { v: 2, imp: false } }, null);
    expect(r.items.some((i) => i.id === "X13")).toBe(false);
  });

  it("市政層納入預算項目", () => {
    const r = matchEntity(data, data.entities[0], "municipal", {}, { B_HOUSING: 1 });
    expect(r.score).toBe(1);
    expect(r.compared).toBe(1);
  });

  it("沒有立場資料時 score 為 null", () => {
    const r = matchEntity({ ...data, stances: {} }, data.entities[0], "national", { E01: { v: 1, imp: false } }, null);
    expect(r.score).toBeNull();
  });
});
