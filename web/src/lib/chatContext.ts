import { data, itemLabel, questionById } from "../data";
import { answerLabel, STEP_LABELS } from "./labels";
import { axisScores, matchAll } from "./scoring";
import type { Answers, BudgetSteps } from "./types";

function fmt(v: number | null): string {
  return v === null ? "無資料" : (v >= 0 ? "+" : "") + v.toFixed(2);
}

/** 目前各維度位置的文字摘要（給 Claude 看）。 */
export function positionSummary(answers: Answers, budget: BudgetSteps | null): string {
  const lines: string[] = [];
  for (const layer of ["national", "municipal"] as const) {
    const scores = axisScores(data, answers, budget, layer).filter((s) => s.value !== null);
    if (!scores.length) continue;
    lines.push(layer === "national" ? "全國層：" : "市政層：");
    for (const s of scores) {
      lines.push(
        `- ${s.axis.name}（${s.axis.id}）：${fmt(s.value)}`
        + `（-2=${s.axis.negative_pole}，+2=${s.axis.positive_pole}，依 ${s.count} 題）`,
      );
    }
  }
  return lines.join("\n");
}

/** 對話開始時附在第一則訊息中的作答摘要。 */
export function stateSummary(
  answers: Answers,
  budget: BudgetSteps | null,
  cityName: string | null,
): string {
  const lines: string[] = ["【使用者的作答】"];
  for (const [id, a] of Object.entries(answers)) {
    const q = questionById.get(id);
    if (!q) continue;
    lines.push(`- ${id}「${q.text}」：${answerLabel(a.v)}${a.v !== null ? `（${a.v}）` : ""}${a.imp ? "，標記為重要" : ""}`);
  }
  if (budget) {
    lines.push("", `【市政預算分配（${cityName ?? "未選城市"}）】`);
    for (const item of data.budget.items) {
      const s = budget[item.id] ?? 0;
      lines.push(`- ${item.id} ${item.name}：${STEP_LABELS[s]}（${s}）`);
    }
  }
  lines.push("", "【目前各維度位置】", positionSummary(answers, budget));

  const top = matchAll(data, "national", answers, budget).filter((m) => m.score !== null).slice(0, 3);
  lines.push("", "【全國層契合度前三名】");
  if (top.length) {
    for (const m of top) {
      lines.push(`- ${m.entity.name}：${Math.round(m.score! * 100)}%（比對 ${m.compared}/${m.total} 題）`);
    }
  } else {
    lines.push("- 目前尚無政黨立場資料，無法計算契合度。");
  }
  return lines.join("\n");
}

export { itemLabel };
