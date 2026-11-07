import { useMemo, useState } from "react";
import { data, itemLabel } from "../data";
import { postLog, toLogAdjustments } from "../lib/api";
import { answerLabel } from "../lib/labels";
import { axisScores, matchAll } from "../lib/scoring";
import type { Adjustment, Answers, BudgetSteps } from "../lib/types";
import { AxisBars } from "./AxisBars";
import { Chat } from "./Chat";
import { FeedbackLink } from "./FeedbackLink";
import { MatchList } from "./MatchList";

interface Props {
  answers: Answers;
  originalAnswers: Answers;
  budget: BudgetSteps | null;
  city: string | null;
  adjustments: Adjustment[];
  onAnswerChange: (id: string, v: number, reason: string) => void;
  onImportanceChange: (id: string, imp: boolean, reason: string) => void;
  onSupplementaryAnswer: (id: string, v: number | null) => void;
  onRestart: () => void;
  onMethodology: () => void;
}

export function Results(p: Props) {
  const cityName = data.budget.cities.find((c) => c.id === p.city)?.name ?? null;
  const adjusted = p.adjustments.length > 0;

  const nat = useMemo(() => axisScores(data, p.answers, p.budget, "national"), [p.answers, p.budget]);
  const mun = useMemo(() => axisScores(data, p.answers, p.budget, "municipal"), [p.answers, p.budget]);
  const natOrig = useMemo(() => axisScores(data, p.originalAnswers, p.budget, "national"), [p.originalAnswers, p.budget]);
  const munOrig = useMemo(() => axisScores(data, p.originalAnswers, p.budget, "municipal"), [p.originalAnswers, p.budget]);
  const natMatch = useMemo(() => matchAll(data, "national", p.answers, p.budget), [p.answers, p.budget]);
  const munMatch = useMemo(() => matchAll(data, "municipal", p.answers, p.budget), [p.answers, p.budget]);

  return (
    <>
      <section className="card">
        <span className="eyebrow">結果</span>
        <h2>你在各維度上的位置</h2>
        <p className="muted small">
          每條軸的兩端代表兩種不同的價值取向，沒有哪一端比較好。結果只反映你在這份問卷上的作答。
        </p>
        <h3>全國議題</h3>
        <AxisBars scores={nat} original={adjusted ? natOrig : undefined} />
        <h3>{cityName ?? "雙北"}市政</h3>
        <AxisBars scores={mun} original={adjusted ? munOrig : undefined} />
      </section>

      <section className="card">
        <h2>和政黨的契合度</h2>
        <p className="muted small">
          點開可以看逐題對照，以及每個立場的出處與證據等級。全國層與市政層分開計算。
        </p>
        <h3>全國議題</h3>
        <MatchList matches={natMatch} />
        <h3>市政</h3>
        <MatchList matches={munMatch} />
      </section>

      <section className="card">
        <span className="eyebrow">和 Claude 聊聊</span>
        <h2>結果跟你想的不一樣？</h2>
        <p className="muted small">
          你可以告訴 Claude 你的想法。它會解釋結果是怎麼算出來的，必要時問你幾題補充題，或建議你修改某題的作答。
          它不會告訴你該支持誰。
        </p>
        <Chat
          answers={p.answers}
          budget={p.budget}
          cityName={cityName}
          onAnswerChange={p.onAnswerChange}
          onImportanceChange={p.onImportanceChange}
          onSupplementaryAnswer={p.onSupplementaryAnswer}
        />
        {adjusted && (
          <div className="adjustments">
            <h3>對答中做過的修正</h3>
            <ul>
              {p.adjustments.map((a, i) => (
                <li key={i} className="small">
                  {a.type === "answer_change" && <>修改「{itemLabel(a.question)}」：{answerLabel(a.from)} → {answerLabel(a.to)}。理由：{a.reason}</>}
                  {a.type === "importance_change" && <>「{itemLabel(a.question)}」{a.to ? "標記為重要" : "取消重要"}。理由：{a.reason}</>}
                  {a.type === "supplementary_answer" && <>補充題「{itemLabel(a.question)}」：{answerLabel(a.to)}</>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <UploadOptIn {...p} />

      <section className="card footer-actions">
        <FeedbackLink kind="一般意見" label="給我們意見" />
        <button className="link" onClick={p.onMethodology}>計算方法與資料來源</button>
        <button className="secondary" onClick={p.onRestart}>重新作答</button>
      </section>
    </>
  );
}

function UploadOptIn(p: Props) {
  const [checked, setChecked] = useState(false);
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const send = async () => {
    setStatus("sending");
    try {
      await postLog({
        quiz_version: data.version,
        city: p.city,
        answers: p.answers,
        budget: p.budget,
        adjustments: toLogAdjustments(p.adjustments),
      });
      setStatus("done");
    } catch {
      setStatus("error");
    }
  };
  return (
    <section className="card">
      <h3>匿名提供作答（自由選擇）</h3>
      <p className="muted small">
        只會傳送：作答與重要度標記、預算分配、對答中做過的修正（不含文字）、題庫版本、送出時間（只到小時）。
        不記錄 IP、cookie、瀏覽器資訊或對話內容。目前不會公開任何統計。
      </p>
      {status === "done" ? (
        <p>已送出，謝謝！</p>
      ) : (
        <>
          <label className="important">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            我願意匿名提供作答，協助改善題目
          </label>
          <button onClick={send} disabled={!checked || status === "sending"}>
            {status === "sending" ? "送出中…" : "送出"}
          </button>
          {status === "error" && <p className="error">送出失敗，請稍後再試。</p>}
        </>
      )}
    </section>
  );
}
