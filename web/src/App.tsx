import { useEffect, useState } from "react";
import { BudgetStep } from "./components/BudgetStep";
import { Methodology } from "./components/Methodology";
import { QuestionStep } from "./components/QuestionStep";
import { Results } from "./components/Results";
import { data, municipalQuestions, nationalQuestions } from "./data";
import type { Adjustment, Answer, Answers, BudgetSteps } from "./lib/types";

type Step = "intro" | "national" | "budget" | "municipal" | "results";

interface State {
  version: string;
  step: Step;
  answers: Answers;
  originalAnswers: Answers | null;
  city: string | null;
  budget: BudgetSteps;
  adjustments: Adjustment[];
}

const STORAGE_KEY = "politic-awareness-progress";

function initial(): State {
  return {
    version: data.version, step: "intro", answers: {}, originalAnswers: null,
    city: null, budget: {}, adjustments: [],
  };
}

// 作答進度只存在這個瀏覽器分頁（sessionStorage），不會上傳
function load(): State {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as State;
      if (s.version === data.version) return s;
    }
  } catch { /* ignore */ }
  return initial();
}

export default function App() {
  const [s, setS] = useState<State>(load);
  const [showMethod, setShowMethod] = useState(false);

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  }, [s]);

  useEffect(() => { window.scrollTo(0, 0); }, [s.step, showMethod]);

  const go = (step: Step) => setS((p) => ({
    ...p,
    step,
    originalAnswers: step === "results" && !p.originalAnswers ? p.answers : p.originalAnswers,
  }));
  const setAnswer = (id: string, a: Answer) => setS((p) => ({ ...p, answers: { ...p.answers, [id]: a } }));

  let body: React.ReactNode;
  if (showMethod) {
    body = <Methodology onClose={() => setShowMethod(false)} />;
  } else if (s.step === "intro") {
    body = (
      <section className="card prose">
        <span className="eyebrow">政治光譜自我探索</span>
        <h1>你的政治立場，可能比一個標籤更複雜</h1>
        <p>
          這份問卷約 {nationalQuestions.length + municipalQuestions.length} 題，加上一段雙北市政預算分配，大約 10 分鐘。
          完成後你會看到自己在幾個維度上的位置，以及和各政黨立場的對照。每個政黨立場都附有出處。
        </p>
        <p>
          結果跟你想的不一樣？可以和 Claude 聊聊，它會解釋結果怎麼來的，並在你同意下修正。
        </p>
        <ul className="small muted">
          <li>不需要帳號，所有計算都在你的瀏覽器中完成。</li>
          <li>這不是投票建議，也不評論哪個立場比較好。</li>
        </ul>
        <div className="row">
          <button onClick={() => go("national")}>開始</button>
          <button className="link" onClick={() => setShowMethod(true)}>計算方法與資料來源</button>
        </div>
      </section>
    );
  } else if (s.step === "national") {
    body = (
      <QuestionStep key="national" title="全國議題" questions={nationalQuestions} answers={s.answers}
        onAnswer={setAnswer} onBack={() => go("intro")} onDone={() => go("budget")} />
    );
  } else if (s.step === "budget") {
    body = (
      <BudgetStep city={s.city} steps={s.budget}
        onCity={(c) => setS((p) => ({ ...p, city: c || null }))}
        onStep={(id, v) => setS((p) => ({ ...p, budget: { ...p.budget, [id]: v } }))}
        onBack={() => go("national")} onDone={() => go("municipal")} />
    );
  } else if (s.step === "municipal") {
    body = (
      <QuestionStep key="municipal" title="雙北市政" questions={municipalQuestions} answers={s.answers}
        onAnswer={setAnswer} onBack={() => go("budget")} onDone={() => go("results")} />
    );
  } else {
    body = (
      <Results
        answers={s.answers}
        originalAnswers={s.originalAnswers ?? s.answers}
        budget={s.city ? s.budget : null}
        city={s.city}
        adjustments={s.adjustments}
        onAnswerChange={(id, v, reason) => setS((p) => ({
          ...p,
          answers: { ...p.answers, [id]: { v, imp: p.answers[id]?.imp ?? false } },
          adjustments: [...p.adjustments, { type: "answer_change", question: id, from: p.answers[id]?.v ?? null, to: v, reason }],
        }))}
        onImportanceChange={(id, imp, reason) => setS((p) => ({
          ...p,
          answers: { ...p.answers, [id]: { v: p.answers[id]?.v ?? null, imp } },
          adjustments: [...p.adjustments, { type: "importance_change", question: id, to: imp, reason }],
        }))}
        onSupplementaryAnswer={(id, v) => setS((p) => ({
          ...p,
          answers: { ...p.answers, [id]: { v, imp: false } },
          adjustments: [...p.adjustments, { type: "supplementary_answer", question: id, to: v }],
        }))}
        onRestart={() => setS(initial())}
        onMethodology={() => setShowMethod(true)}
      />
    );
  }

  return (
    <main className="container">
      {body}
      <p className="disclaimer small muted">
        個人 side project · 題庫版本 {data.version} · 不是投票建議
      </p>
    </main>
  );
}
