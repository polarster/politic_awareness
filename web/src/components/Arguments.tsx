import { useState } from "react";
import { data } from "../data";
import type { ArgumentSide, ExplainerSource, Question } from "../lib/types";
import { safeHref } from "../lib/url";

const KIND_LABELS: Record<string, string> = {
  gazette: "立法院公報",
  minutes: "議事錄",
  official: "官方文件",
  news: "新聞",
  org: "民間團體",
  research: "研究報告",
  reference: "參考資料",
};

/** 只顯示「來源 n：類型」，不顯示標題（標題常會透露是誰的主張） */
function SourceLinks({ sources }: { sources: (ExplainerSource | ArgumentSide["sources"][number])[] }) {
  return (
    <ul className="arg-sources small">
      {sources.map((s, i) => {
        // 只放行 http(s) 網址；不合格時只顯示「來源 n：類型」純文字
        const href = safeHref(s.url);
        const label = `來源 ${i + 1}：${KIND_LABELS[s.kind] ?? s.kind}`;
        return <li key={i}>{href ? <a href={href} target="_blank" rel="noreferrer">{label}</a> : label}</li>;
      })}
    </ul>
  );
}

/** 「背景說明」：題目說明、名詞解釋、議題背景。內容固定、附出處，不含政黨名稱。 */
export function Background({ question }: { question: Question }) {
  const x = data.explainers?.[question.id];
  const [open, setOpen] = useState(false);
  if (!question.note && !x?.terms.length && !x?.background) return null;
  return (
    <div className="explainer">
      <button className="link" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "收起背景說明" : "背景說明與名詞解釋"}
      </button>
      {open && (
        <div className="note">
          {question.note && <p>{question.note}</p>}
          {x?.background && (
            <>
              <p>{x.background.text}</p>
              <SourceLinks sources={x.background.sources} />
            </>
          )}
          {!!x?.terms.length && (
            <dl className="terms">
              {x.terms.map((t) => (
                <div key={t.term}>
                  <dt>{t.term}</dt>
                  <dd>{t.text}<SourceLinks sources={t.sources} /></dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

export function Side({ title, side, plain }: { title: string; side: ArgumentSide; plain?: string }) {
  const [showPlain, setShowPlain] = useState(false);
  return (
    <div className="arg-side">
      <strong>{title}</strong>
      <p>{side.text}</p>
      {plain && (
        <>
          <button className="link small" onClick={() => setShowPlain((v) => !v)} aria-expanded={showPlain}>
            {showPlain ? "收起白話說明" : "看不太懂？白話一點"}
          </button>
          {showPlain && <p className="plain small">{plain}</p>}
        </>
      )}
      {side.sources.length > 0 ? (
        <SourceLinks sources={side.sources} />
      ) : (
        <p className="muted small">{side.note ?? "查無合適來源"}</p>
      )}
    </div>
  );
}

/** 題目下方的「正面說法／反面說法」。換題時由 key 重設。 */
export function Arguments({ questionId, subtle = false }: { questionId: string; subtle?: boolean }) {
  const a = data.arguments[questionId];
  const [open, setOpen] = useState<{ pro: boolean; con: boolean }>({ pro: false, con: false });
  // subtle：第一輪照直覺作答，只放一個不顯眼的小連結，點了才出現正反說法按鈕
  const [revealed, setRevealed] = useState(!subtle);
  if (!a) return null;
  if (!revealed) {
    return (
      <div className="arguments arguments-subtle">
        <button className="link small muted" onClick={() => setRevealed(true)}>拿不定主意？看看雙方的說法</button>
      </div>
    );
  }
  const toggle = (k: "pro" | "con") => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const onlyOne = open.pro !== open.con;
  return (
    <div className="arguments">
      <div className="row">
        <button className={open.pro ? "" : "secondary"} onClick={() => toggle("pro")} aria-expanded={open.pro}>
          正面說法
        </button>
        <button className={open.con ? "" : "secondary"} onClick={() => toggle("con")} aria-expanded={open.con}>
          反面說法
        </button>
        <span className="muted small">拿不定主意？看看雙方的理由</span>
      </div>
      {open.pro && <Side title="同意的理由" side={a.pro} plain={data.explainers?.[questionId]?.plain.pro} />}
      {open.con && <Side title="不同意的理由" side={a.con} plain={data.explainers?.[questionId]?.plain.con} />}
      {onlyOne && (
        <button className="link small" onClick={() => setOpen({ pro: true, con: true })}>
          也看看另一方的說法
        </button>
      )}
    </div>
  );
}
