import { data } from "../data";
import { STEP_LABELS } from "../lib/labels";
import { budgetBalance, minStep } from "../lib/scoring";
import type { BudgetItem, BudgetKind, BudgetSteps } from "../lib/types";

interface Props {
  city: string | null;
  onCity: (c: string) => void;
  steps: BudgetSteps;
  onStep: (id: string, s: number) => void;
  onDone: () => void;
  onBack: () => void;
}

const GROUPS: { kind: BudgetKind; title: string; hint: string }[] = [
  { kind: "expense", title: "支出", hint: "增加會花點數，減少會得到點數" },
  { kind: "revenue", title: "籌錢", hint: "增加會得到點數，減少會花點數" },
  { kind: "surplus", title: "結餘", hint: "增加會花點數" },
];

function delta(item: BudgetItem, s: number): number {
  const c = s * item.cost_per_step;
  return item.kind === "revenue" ? c : -c;
}

export function BudgetStep({ city, onCity, steps, onStep, onDone, onBack }: Props) {
  const cfg = data.budget;
  const balance = budgetBalance(cfg, steps);
  const ok = balance >= cfg.min_final_balance;

  if (!city) {
    return (
      <section className="card">
        <span className="eyebrow">雙北市政</span>
        <h2 className="question">你住在（或比較關心）哪個城市？</h2>
        <p className="muted">接下來要請你分配市政預算。兩市的預算結構不同，所以先選城市。</p>
        <div className="options">
          {cfg.cities.map((c) => (
            <button key={c.id} className="option" onClick={() => onCity(c.id)}>{c.name}</button>
          ))}
        </div>
        <div className="nav"><button className="secondary" onClick={onBack}>上一步</button></div>
      </section>
    );
  }

  const cityName = cfg.cities.find((c) => c.id === city)?.name;

  return (
    <section className="card">
      <div className="step-head">
        <span className="eyebrow">{cityName}預算分配</span>
        <button className="link" onClick={() => onCity("")}>換城市</button>
      </div>
      <p className="muted">
        每個項目從「維持現況」開始。想多做某件事，就要從別的地方挪錢、加稅或借錢。
        最後餘額必須 ≥ 0 才能送出。
      </p>

      <div className={`balance ${ok ? "" : "balance-bad"}`} aria-live="polite">
        餘額：<strong>{balance > 0 ? "+" : ""}{balance}</strong> 點
        {!ok && <span>（超支了，請減少支出或增加收入）</span>}
      </div>

      {GROUPS.map((g) => (
        <div key={g.kind} className="budget-group">
          <h3>{g.title} <span className="muted small">{g.hint}</span></h3>
          {cfg.items.filter((i) => i.kind === g.kind).map((item) => {
            const cur = steps[item.id] ?? 0;
            return (
              <div key={item.id} className="budget-row">
                <div className="budget-name">
                  {item.name}
                  {item.detail && <div className="muted small">{item.detail}</div>}
                </div>
                <div className="stepper" role="radiogroup" aria-label={item.name}>
                  {cfg.steps.filter((s) => s >= minStep(cfg, item)).map((s) => {
                    const d = delta(item, s);
                    return (
                      <button
                        key={s}
                        role="radio"
                        aria-checked={cur === s}
                        className={`step ${cur === s ? "selected" : ""}`}
                        onClick={() => onStep(item.id, s)}
                        title={`${STEP_LABELS[s]}（${d > 0 ? "+" : ""}${d} 點）`}
                      >
                        {STEP_LABELS[s]}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ))}

      <div className="nav">
        <button className="secondary" onClick={onBack}>上一步</button>
        <button onClick={onDone} disabled={!ok}>下一步</button>
      </div>
    </section>
  );
}
