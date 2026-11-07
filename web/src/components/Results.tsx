import { useMemo, useState } from "react";
import { data, itemLabel } from "../data";
import { postLog, toLogAdjustments } from "../lib/api";
import { answerLabel } from "../lib/labels";
import { axisScores, entityAxisScores, matchAll } from "../lib/scoring";
import type { Adjustment, Answers, BudgetSteps } from "../lib/types";
import { AxisBars } from "./AxisBars";
import { Chat } from "./Chat";
import { FeedbackLink } from "./FeedbackLink";
import { MatchRings } from "./MatchRings";
import { PoliticalMap } from "./PoliticalMap";
import { pc, Spectrum } from "./Spectrum";

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
  const [compareId, setCompareId] = useState<string | null>(null);
  const [openNat, setOpenNat] = useState<string | null>(null);
  const [openMun, setOpenMun] = useState<string | null>(null);
  const [showNumbers, setShowNumbers] = useState(false);
  // 是否顯示政黨位置：記在這個瀏覽器（只是個人偏好）
  const [showParties, setShowPartiesState] = useState<boolean>(() => {
    try { return localStorage.getItem("show-parties") !== "0"; } catch { return true; }
  });
  const setShowParties = (v: boolean) => {
    setShowPartiesState(v);
    try { localStorage.setItem("show-parties", v ? "1" : "0"); } catch { /* ignore */ }
  };

  const partiesWithData = data.entities.filter((e) => (data.stances[e.id] ?? []).length > 0);
  const spectrumParties = (layer: "national" | "municipal") =>
    showParties
      ? partiesWithData.map((e) => ({ id: e.id, label: e.short ?? e.name, color: e.color, scores: entityAxisScores(data, e, layer) }))
      : [];

  return (
    <>
      <section className="card">
        <span className="eyebrow">結果</span>
        <h2>你在各維度上的位置</h2>
        <p className="muted small">
          每條軸的兩端代表兩種不同的價值取向，沒有哪一端比較好。結果只反映你在這份問卷上的作答。
        </p>
        {partiesWithData.length > 0 && (
          <label className="switch small">
            <input type="checkbox" role="switch" checked={showParties} onChange={(e) => setShowParties(e.target.checked)} />
            <span className="switch-ui" aria-hidden="true" />
            顯示政黨位置
          </label>
        )}
        {showParties && partiesWithData.length > 0 && (
          <div className="compare-chips small" role="group" aria-label="對照政黨">
            <span className="muted">強調政黨：</span>
            <button className={compareId === null ? "chip-btn on" : "chip-btn"} onClick={() => setCompareId(null)}>
              不強調
            </button>
            {partiesWithData.map((e) => (
              <button key={e.id} className={compareId === e.id ? "chip-btn on" : "chip-btn"}
                style={pc(e.color)}
                onClick={() => setCompareId(compareId === e.id ? null : e.id)}>
                {e.short ?? e.name}
              </button>
            ))}
          </div>
        )}
        <div className="viz-option">
          <span className="tag">呈現方式 A：光譜滑桿</span>
          <div className="radar-pair">
            <div>
              <h3>全國議題</h3>
              <Spectrum you={nat} parties={spectrumParties("national")} highlightId={compareId} original={adjusted ? natOrig : null} />
            </div>
            <div>
              <h3>{cityName ?? "雙北"}市政</h3>
              <Spectrum you={mun} parties={spectrumParties("municipal")} highlightId={compareId} original={adjusted ? munOrig : null} />
            </div>
          </div>
        </div>
        <div className="viz-option">
          <span className="tag">呈現方式 B：政治地圖</span>
          <h3>全國議題</h3>
          <PoliticalMap
            defaultX="economy"
            defaultY="identity"
            points={[
              { id: "you", label: "你", scores: nat, kind: "you" },
              ...(showParties ? partiesWithData : []).map((e) => ({
                id: e.id,
                label: e.short ?? e.name,
                color: e.color,
                scores: entityAxisScores(data, e, "national"),
                kind: (compareId === e.id ? "highlight" : "party") as "highlight" | "party",
              })),
            ]}
          />
        </div>
        <p className="muted small">兩端都是一種價值取向，沒有好壞之分；越靠某一端，代表越傾向那一端。政黨的位置依它在各題有出處的立場計算。</p>
        <button className="link small" onClick={() => setShowNumbers((v) => !v)} aria-expanded={showNumbers}>
          {showNumbers ? "收起詳細數值" : "看詳細數值"}
        </button>
        {showNumbers && (
          <>
            <h4>全國議題</h4>
            <AxisBars scores={nat} original={adjusted ? natOrig : undefined} />
            <h4>市政</h4>
            <AxisBars scores={mun} original={adjusted ? munOrig : undefined} />
          </>
        )}
      </section>

      <section className="card">
        <h2>和政黨的契合度</h2>
        <p className="muted small">
          點政黨卡片看逐題對照，以及每個立場的出處與證據等級。全國層與市政層分開計算。
        </p>
        <h3>全國議題</h3>
        <MatchRings matches={natMatch} open={openNat} onOpen={setOpenNat} compareId={compareId} onCompare={setCompareId} />
        <h3>市政</h3>
        <MatchRings matches={munMatch} open={openMun} onOpen={setOpenMun} />
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
        <a href="#/votes">立院投票紀錄</a>
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
