import type {
  AppData, Answers, Axis, BudgetConfig, BudgetItem, BudgetSteps, Entity, Layer, Question, Stance,
} from "./types";

export const IMPORTANT_WEIGHT = 2;

export function weight(imp: boolean): number {
  return imp ? IMPORTANT_WEIGHT : 1;
}

/** 預算餘額。expense 增加花點數；revenue 增加得點數；surplus 增加花點數。 */
export function budgetBalance(cfg: BudgetConfig, steps: BudgetSteps): number {
  let bal = cfg.start_balance;
  for (const item of cfg.items) {
    const s = steps[item.id] ?? 0;
    const c = s * item.cost_per_step;
    bal += item.kind === "revenue" ? c : -c;
  }
  return bal;
}

export function minStep(cfg: BudgetConfig, item: BudgetItem): number {
  return item.min_step ?? Math.min(...cfg.steps);
}

export interface AxisScore {
  axis: Axis;
  /** -2..2；沒有任何作答時為 null */
  value: number | null;
  count: number;
}

/**
 * 各維度位置 = 維度內「作答 × 方向」的加權平均。
 * 題目（含補充題）依重要度加權；預算項目權重 1，步數本身就是 -2..2。
 */
export function axisScores(
  data: AppData,
  answers: Answers,
  budget: BudgetSteps | null,
  layer?: Layer,
): AxisScore[] {
  const allQ: Question[] = [...data.questions, ...data.supplementary]
    .filter((q) => !layer || q.layer === layer);
  const useBudget = budget && (!layer || layer === "municipal");
  return data.axes.map((axis) => {
    let sum = 0;
    let wsum = 0;
    let count = 0;
    for (const q of allQ) {
      if (q.axis !== axis.id) continue;
      const a = answers[q.id];
      if (!a || a.v === null) continue;
      const w = weight(a.imp);
      sum += w * a.v * q.direction;
      wsum += w;
      count++;
    }
    if (useBudget) {
      for (const item of data.budget.items) {
        if (item.axis !== axis.id) continue;
        const s = budget![item.id] ?? 0;
        sum += s * item.direction;
        wsum += 1;
        count++;
      }
    }
    return { axis, value: wsum > 0 ? sum / wsum : null, count };
  });
}

export interface ItemComparison {
  id: string;
  user: number | null;
  stance: Stance | null;
  /** 0..1；任一方沒有值時為 null */
  agreement: number | null;
  weight: number;
}

export interface MatchResult {
  entity: Entity;
  layer: Layer;
  /** 0..1；沒有可比對的項目時為 null */
  score: number | null;
  compared: number;
  total: number;
  items: ItemComparison[];
}

function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

/** 題目一致度：1 − |差| / 4 */
export function questionAgreement(user: number, entity: number): number {
  return 1 - Math.abs(user - entity) / 4;
}

/** 預算項目只比方向：1 − |sign(使用者) − 對象方向| / 2 */
export function budgetAgreement(userStep: number, entityDir: number): number {
  return 1 - Math.abs(sign(userStep) - entityDir) / 2;
}

export function matchEntity(
  data: AppData,
  entity: Entity,
  layer: Layer,
  answers: Answers,
  budget: BudgetSteps | null,
): MatchResult {
  const stanceMap = new Map((data.stances[entity.id] ?? []).map((s) => [s.question, s]));
  const items: ItemComparison[] = [];

  const qs = [...data.questions, ...data.supplementary].filter((q) => q.layer === layer);
  for (const q of qs) {
    const a = answers[q.id];
    const isSupp = data.supplementary.some((s) => s.id === q.id);
    if (isSupp && !a) continue; // 沒作答的補充題不列入
    if (q.reflection) continue; // 反思題不比對
    const st = stanceMap.get(q.id) ?? null;
    const user = a?.v ?? null;
    const agreement = user !== null && st ? questionAgreement(user, st.value) : null;
    items.push({ id: q.id, user, stance: st, agreement, weight: weight(a?.imp ?? false) });
  }

  if (layer === "municipal" && budget) {
    for (const item of data.budget.items) {
      const st = stanceMap.get(item.id) ?? null;
      const user = budget[item.id] ?? 0;
      const agreement = st ? budgetAgreement(user, st.value) : null;
      items.push({ id: item.id, user, stance: st, agreement, weight: 1 });
    }
  }

  let sum = 0;
  let wsum = 0;
  let compared = 0;
  for (const it of items) {
    if (it.agreement === null) continue;
    sum += it.agreement * it.weight;
    wsum += it.weight;
    compared++;
  }
  return {
    entity, layer, score: wsum > 0 ? sum / wsum : null, compared, total: items.length, items,
  };
}

export function matchAll(
  data: AppData,
  layer: Layer,
  answers: Answers,
  budget: BudgetSteps | null,
): MatchResult[] {
  return data.entities
    .map((e) => matchEntity(data, e, layer, answers, budget))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/** 覆蓋率低於此值時提示結果參考價值有限 */
export const LOW_COVERAGE = 0.5;
