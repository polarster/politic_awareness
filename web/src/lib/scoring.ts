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

/** 議題（軸）權重：0–3，沒設定時為 1；不屬於任何軸的題目不受影響。 */
function axisWeight(axis: string | null, axisWeights?: Record<string, number>): number {
  if (!axis || !axisWeights) return 1;
  return axisWeights[axis] ?? 1;
}

export function matchEntity(
  data: AppData,
  entity: Entity,
  layer: Layer,
  answers: Answers,
  budget: BudgetSteps | null,
  axisWeights?: Record<string, number>,
): MatchResult {
  const stanceMap = new Map((data.stances[entity.id] ?? []).map((s) => [s.question, s]));
  const items: ItemComparison[] = [];

  const qs = [...data.questions, ...data.supplementary].filter((q) => q.layer === layer);
  for (const q of qs) {
    const a = answers[q.id];
    const isSupp = data.supplementary.some((s) => s.id === q.id);
    if (isSupp && !a) continue; // 沒作答的補充題不列入
    if (q.reflection) continue; // 反思題不比對
    const aw = axisWeight(q.axis, axisWeights);
    if (aw <= 0) continue; // 議題權重 0：不列入
    const st = stanceMap.get(q.id) ?? null;
    const user = a?.v ?? null;
    const agreement = user !== null && st ? questionAgreement(user, st.value) : null;
    items.push({ id: q.id, user, stance: st, agreement, weight: weight(a?.imp ?? false) * aw });
  }

  if (layer === "municipal" && budget) {
    for (const item of data.budget.items) {
      const aw = axisWeight(item.axis, axisWeights);
      if (aw <= 0) continue;
      const st = stanceMap.get(item.id) ?? null;
      const user = budget[item.id] ?? 0;
      const agreement = st ? budgetAgreement(user, st.value) : null;
      items.push({ id: item.id, user, stance: st, agreement, weight: aw });
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
  axisWeights?: Record<string, number>,
): MatchResult[] {
  return data.entities
    .map((e) => matchEntity(data, e, layer, answers, budget, axisWeights))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/** 覆蓋率低於此值時提示結果參考價值有限 */
export const LOW_COVERAGE = 0.5;

/**
 * 政黨在各軸上的位置：該軸上有立場資料的題目（含預算項目）的「立場 × 方向」平均。
 * 沒有資料的軸為 null。
 */
export function entityAxisScores(data: AppData, entity: Entity, layer: Layer): AxisScore[] {
  const stances = data.stances[entity.id] ?? [];
  const byId = new Map(stances.map((s) => [s.question, s.value]));
  const qs = [...data.questions, ...data.supplementary].filter((q) => q.layer === layer && !q.reflection);
  return data.axes.map((axis) => {
    let sum = 0;
    let count = 0;
    for (const q of qs) {
      if (q.axis !== axis.id) continue;
      const v = byId.get(q.id);
      if (v === undefined) continue;
      sum += v * q.direction;
      count++;
    }
    if (layer === "municipal") {
      for (const b of data.budget.items) {
        if (b.axis !== axis.id) continue;
        const v = byId.get(b.id);
        if (v === undefined) continue;
        sum += v * 2 * b.direction; // 預算立場只有方向（-1/0/1），換算到 -2..2
        count++;
      }
    }
    return { axis, value: count ? sum / count : null, count };
  });
}

export interface DistanceRank {
  id: string;
  /** 加權平均距離，0（完全相同）到 4（兩個極端） */
  distance: number;
  /** 用到的軸數（雙方都有值、且權重 > 0） */
  axes: number;
}

/**
 * 依各軸距離 |你 − 政黨| 的加權平均排序（近 → 遠）。
 * 權重 0 的軸不計；某政黨在某軸沒有資料時，那條軸對它不計。
 */
export function rankByDistance(
  you: AxisScore[],
  parties: { id: string; scores: AxisScore[] }[],
  weights: Record<string, number>,
): DistanceRank[] {
  const out: DistanceRank[] = [];
  for (const p of parties) {
    let sum = 0;
    let wsum = 0;
    let axes = 0;
    for (const y of you) {
      if (y.value === null) continue;
      const w = weights[y.axis.id] ?? 1;
      if (w <= 0) continue;
      const v = p.scores.find((s) => s.axis.id === y.axis.id)?.value ?? null;
      if (v === null) continue;
      sum += w * Math.abs(y.value - v);
      wsum += w;
      axes++;
    }
    if (wsum > 0) out.push({ id: p.id, distance: sum / wsum, axes });
  }
  return out.sort((a, b) => a.distance - b.distance);
}
