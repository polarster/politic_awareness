import { useEffect, useState } from "react";
import { BudgetStep } from "./components/BudgetStep";
import { Methodology } from "./components/Methodology";
import { QuestionStep } from "./components/QuestionStep";
import { ReflectStep } from "./components/ReflectStep";
import { Results } from "./components/Results";
import { VotesPage } from "./components/VotesPage";
import { data, municipalQuestions, nationalQuestions } from "./data";
import { isTunnelHost } from "./lib/host";
import { parseVoteFocus } from "./lib/route";
import type { Adjustment, Answer, Answers, BudgetSteps, Journey } from "./lib/types";

type Step = "intro" | "national" | "budget" | "municipal" | "choose" | "reflect" | "results";

interface State {
  version: string;
  step: Step;
  answers: Answers;
  /** 第一輪完成時的答案（第一直覺）；之後的對答修正與思辨旅程都不會改動它 */
  originalAnswers: Answers | null;
  /** 第二輪「思辨旅程」：none 未開始、doing 進行中、done 已完成 */
  journey: Journey;
  /** 是否在看過結果之後才開始思辨旅程（可能受結果影響，資料上分開標記） */
  journeyAfterResults: boolean;
  city: string | null;
  budget: BudgetSteps;
  adjustments: Adjustment[];
}

const STORAGE_KEY = "politic-awareness-progress";
/** #/votes/<id> 只接受這些精選表決 id，其他一律當成找不到 */
const VOTE_IDS: ReadonlySet<string> = new Set(data.votes.map((v) => v.id));

function initial(): State {
  return {
    version: data.version, step: "intro", answers: {}, originalAnswers: null, journey: "none", journeyAfterResults: false,
    city: null, budget: {}, adjustments: [],
  };
}

// 作答進度只存在這個瀏覽器分頁（sessionStorage），不會上傳
function load(): State {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as State;
      if (s.version === data.version) return { ...initial(), ...s };
    }
  } catch { /* ignore */ }
  return initial();
}

export default function App() {
  const [s, setS] = useState<State>(load);
  const [showMethod, setShowMethod] = useState(false);
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const votesRoute = hash.startsWith("#/votes");
  const voteFocus = votesRoute ? parseVoteFocus(hash, VOTE_IDS) : undefined;

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  }, [s]);

  useEffect(() => { if (!voteFocus) window.scrollTo(0, 0); }, [s.step, showMethod, votesRoute, voteFocus]);

  const go = (step: Step) => setS((p) => ({
    ...p,
    step,
    // 第一輪結束（進入選擇或結果頁）時，記下第一直覺
    originalAnswers: (step === "choose" || step === "results") && !p.originalAnswers ? p.answers : p.originalAnswers,
  }));
  const setAnswer = (id: string, a: Answer) => setS((p) => ({ ...p, answers: { ...p.answers, [id]: a } }));
  // 思辨旅程的題目：有正反說法、而且第一輪答過的政策題
  const first = s.originalAnswers ?? s.answers;
  const reflectQuestionsFor = (a: Answers) => data.questions.filter((q) => data.arguments[q.id] && q.id in a);
  const reflectQuestions = reflectQuestionsFor(first);

  let body: React.ReactNode;
  if (votesRoute) {
    body = <VotesPage focus={voteFocus} onBack={() => { window.location.hash = ""; }} />;
  } else if (showMethod) {
    body = <Methodology onClose={() => setShowMethod(false)} />;
  } else if (s.step === "intro") {
    body = (
      <>
      <section className="card prose">
        <span className="eyebrow">政治光譜自我探索</span>
        <h1>你的政治立場，可能比一個標籤更複雜</h1>
        <p>
          這份問卷約 {nationalQuestions.length + municipalQuestions.length} 題，加上一段雙北市政預算分配，大約 10 分鐘。
          完成後你會看到自己在幾個維度上的位置，以及和各政黨立場的對照。每個政黨立場都附有出處。
        </p>
        <p>
          <strong>請照第一直覺快速作答</strong>，不用想太久。看完結果後，可以再進行「思辨旅程」：
          看看和你不同方向的說法，比較你的第一直覺和深思之後有什麼不同。
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
      <section className="card">
        <span className="eyebrow">民眾有知的權利</span>
        <h2>立法院怎麼投票？</h2>
        <p className="small">看看各黨、每位立委在重要法案上的記名表決，全部附立法院公報原文。</p>
        <a className="button-link" href="#/votes">查看立院投票紀錄</a>
      </section>
      </>
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
        onAnswer={setAnswer} onBack={() => go("budget")} onDone={() => go(reflectQuestionsFor(s.answers).length ? "choose" : "results")} />
    );
  } else if (s.step === "choose") {
    body = (
      <section className="card prose">
        <span className="eyebrow">第一輪完成</span>
        <h2>要先進行「思辨旅程」嗎？</h2>
        <p>
          你剛剛的答案就是你的<strong>第一直覺</strong>。接下來 {reflectQuestions.length} 題，每題會先給你看和你不同方向的說法（附立法院公報等出處），
          再讓你決定要不要調整。最後你會看到第一直覺和深思之後的差別。約 10 分鐘，可以隨時跳過剩下的題目。
        </p>
        <p className="muted small">
          建議在看結果之前進行：先看到「最接近哪個政黨」，可能會影響你怎麼看這些論點。
        </p>
        <div className="row">
          <button onClick={() => setS((p) => ({ ...p, step: "reflect", journey: "doing" }))}>開始思辨旅程</button>
          <button className="secondary" onClick={() => go("results")}>直接看結果</button>
        </div>
      </section>
    );
  } else if (s.step === "reflect" && reflectQuestions.length) {
    body = (
      <ReflectStep questions={reflectQuestions} first={first} answers={s.answers} onAnswer={setAnswer}
        onDone={() => setS((p) => ({ ...p, step: "results", journey: "done" }))} />
    );
  } else {
    body = (
      <Results
        answers={s.answers}
        originalAnswers={s.originalAnswers ?? s.answers}
        journey={s.journey}
        onStartJourney={() => setS((p) => ({ ...p, step: "reflect", journey: p.journey === "done" ? "done" : "doing", journeyAfterResults: true }))}
        journeyAfterResults={s.journeyAfterResults}
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
      <nav className="topnav small">
        <a href="#" onClick={(e) => { e.preventDefault(); window.location.hash = ""; setShowMethod(false); }}>政治光譜自我探索</a>
        <a href="#/votes">立院投票紀錄</a>
      </nav>
      {body}
      <p className="disclaimer small muted">
        個人 side project · 題庫版本 {data.version} · 不是投票建議
      </p>
      {/* 對外模式（經 Cloudflare Tunnel）才有登入閘道與 /__logout；本機開發時不顯示 */}
      {isTunnelHost(window.location.hostname) && (
        <form className="disclaimer small" method="post" action="/__logout">
          <button type="submit" className="link">登出</button>
        </form>
      )}
    </main>
  );
}
