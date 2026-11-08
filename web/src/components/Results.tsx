import { useMemo, useState } from "react";
import { data, itemLabel } from "../data";
import { ApiError, fingerprint, loadUploadState, postLog, saveUploadState, toLogAdjustments, type UploadState } from "../lib/api";
import { answerLabel } from "../lib/labels";

import { axisScores, entityAxisScores, matchAll } from "../lib/scoring";
import type { Adjustment, Answers, BudgetSteps, Journey } from "../lib/types";
import { AxisBars } from "./AxisBars";
import { Chat } from "./Chat";
import { FeedbackLink } from "./FeedbackLink";
import { MatchRings } from "./MatchRings";
import { PoliticalMap } from "./PoliticalMap";
import { pc, Spectrum } from "./Spectrum";
import { ShareCard } from "./ShareCard";

interface Props {
  answers: Answers;
  originalAnswers: Answers;
  journey: Journey;
  onStartJourney: () => void;
  journeyAfterResults: boolean;
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
  // 完成思辨旅程後：對照第一輪的答案（第一直覺）；否則只在對答修正後對照修正前
  const full = p.journey === "done";
  const cmpNat = full || adjusted ? natOrig : null;
  const cmpMun = full || adjusted ? munOrig : null;
  const cmpLabel = full ? "第一直覺" : "修正前";

  const [compareId, setCompareId] = useState<string | null>(null);
  const [layerTab, setLayerTab] = useState<"national" | "municipal">("national");
  const [openNat, setOpenNat] = useState<string | null>(null);
  const [openMun, setOpenMun] = useState<string | null>(null);
  const [showNumbers, setShowNumbers] = useState(false);
  // 是否顯示政黨位置：記在這個瀏覽器（只是個人偏好）
  const [showParties, setShowPartiesState] = useState<boolean>(() => {
    try { return localStorage.getItem("show-parties") !== "0"; } catch { return true; }
  });
  // 各議題權重（0–3），只影響距離排序；記在這個瀏覽器
  const [weights, setWeights] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem("axis-weights-v2") ?? "{}"); } catch { return {}; }
  });
  // 權重以「層級:軸」為鍵，全國層與市政層分開設定
  const weightsFor = (layer: string) =>
    Object.fromEntries(Object.entries(weights).filter(([k]) => k.startsWith(layer + ":")).map(([k, v]) => [k.slice(layer.length + 1), v]));
  const setWeight = (layer: string) => (id: string, w: number) => {
    setWeights((prev) => {
      const next = { ...prev, [`${layer}:${id}`]: w };
      try { localStorage.setItem("axis-weights-v2", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  const natMatch = useMemo(() => matchAll(data, "national", p.answers, p.budget, weightsFor("national")).filter((m) => m.entity.type === "party"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.answers, p.budget, weights]);
  const munMatch = useMemo(() => matchAll(data, "municipal", p.answers, p.budget, weightsFor("municipal")).filter((m) => m.entity.type === "party"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.answers, p.budget, weights]);
  const setShowParties = (v: boolean) => {
    setShowPartiesState(v);
    try { localStorage.setItem("show-parties", v ? "1" : "0"); } catch { /* ignore */ }
  };

  // 目前只顯示政黨；政治人物（type: person）的呈現與「個人＋政黨」的計算方式待討論
  const partiesWithData = data.entities.filter((e) => e.type === "party" && (data.stances[e.id] ?? []).length > 0);
  const spectrumParties = (layer: "national" | "municipal") =>
    showParties
      ? partiesWithData.map((e) => ({ id: e.id, label: e.short ?? e.name, color: e.color, badge: e.badge, logo: e.logo, scores: entityAxisScores(data, e, layer) }))
      : [];

  return (
    <>
      {!full && (
        <section className="card journey-cta">
          <span className="eyebrow">還可以進行：思辨旅程</span>
          <h2>想看看另一方怎麼說嗎？</h2>
          <p className="small">
            每一題會先給你看和你不同方向的說法，再讓你決定要不要調整答案，最後比較第一直覺和深思之後的差別。約 10 分鐘，可以隨時跳過。
          </p>
          <p className="muted small">你已經看過結果了，請盡量依論點本身判斷，不必考慮結果會更接近哪個政黨。</p>
          <button onClick={p.onStartJourney}>{p.journey === "doing" ? "繼續思辨旅程" : "開始思辨旅程"}</button>
        </section>
      )}
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
                <i className="chip-badge">{e.badge ?? (e.short ?? e.name).slice(0, 1)}</i>
                {e.short ?? e.name}
              </button>
            ))}
          </div>
        )}
        <div className="viz-option">
          <span className="tag">呈現方式 A：光譜滑桿</span>
          <div className="layer-tabs" role="tablist" aria-label="議題層級">
            <button role="tab" aria-selected={layerTab === "national"} className={layerTab === "national" ? "on" : ""} onClick={() => setLayerTab("national")}>全國議題</button>
            <button role="tab" aria-selected={layerTab === "municipal"} className={layerTab === "municipal" ? "on" : ""} onClick={() => setLayerTab("municipal")}>{cityName ?? "雙北"}市政</button>
          </div>
          {layerTab === "national" ? (
            <Spectrum you={nat} parties={spectrumParties("national")} highlightId={compareId} original={cmpNat} originalLabel={cmpLabel} weights={weightsFor("national")} onWeight={setWeight("national")} />
          ) : (
            <Spectrum you={mun} parties={spectrumParties("municipal")} highlightId={compareId} original={cmpMun} originalLabel={cmpLabel} weights={weightsFor("municipal")} onWeight={setWeight("municipal")} />
          )}
        </div>
        <div className="viz-option">
          <span className="tag">呈現方式 B：政治地圖</span>
          <h3>全國議題</h3>
          <PoliticalMap
            defaultX="market"
            defaultY="welfare"
            points={[
              ...(full ? [{ id: "you-first", label: "第一直覺", scores: natOrig, kind: "you-first" as const }] : []),
              { id: "you", label: "你", scores: nat, kind: "you" },
              ...(showParties ? partiesWithData : []).map((e) => ({
                id: e.id,
                label: e.short ?? e.name,
                color: e.color,
                badge: e.badge,
                logo: e.logo,
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
            <AxisBars scores={nat} original={cmpNat ?? undefined} originalLabel={cmpLabel} />
            <h4>市政</h4>
            <AxisBars scores={mun} original={cmpMun ?? undefined} originalLabel={cmpLabel} />
          </>
        )}
      </section>

      {full && <IntuitionCompare answers={p.answers} intuition={p.originalAnswers} firstAnswers={p.originalAnswers} budget={p.budget}
        weightsNat={weightsFor("national")} weightsMun={weightsFor("municipal")} />}

      <section className="card">
        <h2>和政黨的契合度</h2>
        <p className="muted small">
          點政黨卡片看逐題對照，以及每個立場的出處與證據等級。全國層與市政層分開計算。
          上方各議題的權重（0–3）也會套用在這裡。
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

      <ShareCard
        nat={nat} mun={mun} natFirst={full ? natOrig : null} munFirst={full ? munOrig : null}
        journeyDone={full}
        changedCount={data.questions.filter((q) => p.originalAnswers[q.id] && p.answers[q.id]
          && (p.originalAnswers[q.id].v !== p.answers[q.id].v || p.originalAnswers[q.id].imp !== p.answers[q.id].imp)).length}
        natParties={partiesWithData.map((e) => ({ id: e.id, label: e.short ?? e.name, color: e.color, badge: e.badge, logo: e.logo, scores: entityAxisScores(data, e, "national") }))}
        munParties={partiesWithData.map((e) => ({ id: e.id, label: e.short ?? e.name, color: e.color, badge: e.badge, logo: e.logo, scores: entityAxisScores(data, e, "municipal") }))}
        natMatch={natMatch}
        cityName={cityName}
      />

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
  const done = p.journey === "done";
  const record = {
    quiz_version: data.version,
    city: p.city,
    answers: p.answers,
    budget: p.budget,
    adjustments: toLogAdjustments(p.adjustments),
    mode: done ? ("full" as const) : ("simple" as const),
    first_answers: done ? p.originalAnswers : null,
    journey_after_results: done ? p.journeyAfterResults : null,
  };
  const content = fingerprint(record);
  // 每一輪作答（題庫版本＋第一直覺的答案）一個 submission_id，存在 sessionStorage：
  // 切到其他頁面或重新整理後回來，還記得已經送出過；再送一次只會覆蓋同一筆
  const round = fingerprint([data.version, p.originalAnswers]);
  const [upload, setUpload] = useState<UploadState>(() => loadUploadState(round));
  if (upload.round !== round) setUpload(loadUploadState(round));
  const [checked, setChecked] = useState(false);
  const [status, setStatus] = useState<"idle" | "sending" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const sentBefore = upload.sent !== null;
  const upToDate = upload.sent === content;

  const send = async () => {
    setStatus("sending");
    setError(null);
    try {
      await postLog({ ...record, submission_id: upload.id });
      const next = { ...upload, sent: content };
      saveUploadState(next);
      setUpload(next);
      setStatus("idle");
    } catch (e) {
      setStatus("error");
      setError(e instanceof ApiError ? e.message : null);
    }
  };
  return (
    <section className="card">
      <h3>匿名提供作答（自由選擇）</h3>
      <p className="muted small">
        會傳送：你選的城市與預算分配、各題作答與重要度標記（含和 Claude 對答時回答的補充題）、對答中套用的修正（只有題號和選項，不含理由文字）、題庫版本，
        以及一組隨機的送出編號（只用來讓重複送出時覆蓋同一筆，不會連到你的身分）；完成思辨旅程時，另含第一輪的答案，以及是不是看過結果才進行。
        伺服器只記收到的日期，本站程式不記錄你的 IP、cookie、瀏覽器資訊或對話文字。
        因為不記名，送出後無法個別刪除；使用的人還不多時，匿名的程度有限。目前不會公開任何統計。
      </p>
      {upToDate ? (
        <p>已送出，謝謝！</p>
      ) : sentBefore ? (
        <>
          <p className="small">送出之後你又調整過作答。要更新已送出的資料嗎？會覆蓋原本那一筆，不會多一筆。</p>
          <button onClick={send} disabled={status === "sending"}>
            {status === "sending" ? "送出中…" : "更新已送出的資料"}
          </button>
        </>
      ) : (
        <>
          <label className="important">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            我願意匿名提供作答，協助改善題目
          </label>
          <button onClick={send} disabled={!checked || status === "sending"}>
            {status === "sending" ? "送出中…" : "送出"}
          </button>
        </>
      )}
      {status === "error" && <p className="error">{error ?? "送出失敗，請稍後再試。"}</p>}
    </section>
  );
}

/** 完整版：第一直覺 vs 看過其他意見後 */
function IntuitionCompare({ answers, intuition, firstAnswers, budget, weightsNat, weightsMun }: {
  answers: Answers; intuition: Answers; firstAnswers: Answers; budget: BudgetSteps | null;
  weightsNat: Record<string, number>; weightsMun: Record<string, number>;
}) {
  const changed = data.questions.filter((q) => {
    const f = firstAnswers[q.id];
    const a = answers[q.id];
    return f && a && (f.v !== a.v || f.imp !== a.imp);
  });
  const rows = (["national", "municipal"] as const).map((layer) => {
    const w = layer === "national" ? weightsNat : weightsMun;
    const now = matchAll(data, layer, answers, budget, w).filter((m) => m.entity.type === "party");
    const first = new Map(matchAll(data, layer, intuition, budget, w).map((m) => [m.entity.id, m.score]));
    return { layer, list: now.filter((m) => m.score !== null).map((m) => ({ e: m.entity, now: m.score, first: first.get(m.entity.id) ?? null })) };
  });
  const pctOf = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
  return (
    <section className="card">
      <span className="eyebrow">思辨旅程</span>
      <h2>第一直覺 vs 看過其他意見後</h2>
      <p className="muted small">
        上方光譜與地圖上的虛線圓點是你的第一直覺，實心點是現在（看過其他意見、以及和 Claude 對答修正後）的位置。
        改變或不改變都很正常，這裡只是讓你看見差異。
      </p>
      {changed.length === 0 ? (
        <p>看過其他意見後，你沒有改變任何一題的答案。</p>
      ) : (
        <>
          <h3>改變的題目（{changed.length} 題）</h3>
          <ul className="change-list small">
            {changed.map((q) => {
              const f = firstAnswers[q.id];
              const a = answers[q.id];
              return (
                <li key={q.id}>
                  {q.text}
                  <br />
                  <span className="muted">
                    {f.v !== a.v && <>{answerLabel(f.v)} → <strong>{answerLabel(a.v)}</strong></>}
                    {f.v !== a.v && f.imp !== a.imp && "；"}
                    {f.imp !== a.imp && (a.imp ? "改為標記重要" : "取消標記重要")}
                  </span>
                </li>
              );
            })}
          </ul>
          <h3>和政黨的契合度變化</h3>
          {rows.map(({ layer, list }) => (
            <div key={layer}>
              <h4>{layer === "national" ? "全國議題" : "市政"}</h4>
              <div className="match-delta small">
                {list.map(({ e, now, first }) => {
                  const d = now !== null && first !== null ? Math.round(now * 100) - Math.round(first * 100) : null;
                  return (
                    <div key={e.id} style={{ display: "contents" }}>
                      <span>{e.short ?? e.name}</span>
                      <span className="muted">第一直覺 {pctOf(first)} → 現在 {pctOf(now)}</span>
                      <span>{d === null || d === 0 ? "±0" : d > 0 ? `+${d}` : d}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
