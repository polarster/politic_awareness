export const ANSWER_OPTIONS: { v: number | null; label: string }[] = [
  { v: -2, label: "非常不同意" },
  { v: -1, label: "不同意" },
  { v: 0, label: "中立" },
  { v: 1, label: "同意" },
  { v: 2, label: "非常同意" },
  { v: null, label: "不知道 / 無意見" },
];

export function answerLabel(v: number | null | undefined): string {
  if (v === undefined) return "未作答";
  return ANSWER_OPTIONS.find((o) => o.v === v)?.label ?? String(v);
}

export const STEP_LABELS: Record<number, string> = {
  [-2]: "大減", [-1]: "減", 0: "維持", 1: "增", 2: "大增",
};

export const BUDGET_DIR_LABELS: Record<number, string> = { [-1]: "減少", 0: "維持", 1: "增加" };

export const GRADE_LABELS: Record<string, string> = {
  A: "A 記名表決",
  B: "B 提案／連署／質詢",
  C: "C 政見／聲明／發言",
};

export const EVIDENCE_KIND_LABELS: Record<string, string> = {
  vote: "表決", bill: "提案", interpellation: "質詢", platform: "政見／黨綱",
  statement: "聲明", interview: "訪談", debate: "辯論", social_interview: "社群訪談",
};
