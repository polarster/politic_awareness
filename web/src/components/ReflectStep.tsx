import { useState } from "react";
import { data } from "../data";
import { ANSWER_OPTIONS, answerLabel } from "../lib/labels";
import type { Answer, Answers, Question } from "../lib/types";
import { Background, Side } from "./Arguments";

interface Props {
  /** 有正反說法、而且第一輪答過的題目 */
  questions: Question[];
  /** 第一輪的答案（不會被改動） */
  first: Answers;
  answers: Answers;
  onAnswer: (id: string, a: Answer) => void;
  onDone: () => void;
}

const SIDE_TITLE = { pro: "同意的理由", con: "不同意的理由" } as const;

/** 第二輪「思辨旅程」：每題先看和第一輪答案不同方向的說法，再決定要不要調整。不顯示任何政黨資訊。 */
export function ReflectStep({ questions, first, answers, onAnswer, onDone }: Props) {
  const [idx, setIdx] = useState(0);
  const [showSame, setShowSame] = useState(false);
  const q = questions[idx];
  const args = data.arguments[q.id]!;
  const f = first[q.id];
  const cur = answers[q.id] ?? f;

  // 第一輪選同意 → 看反面；不同意 → 看正面；中立或不知道 → 兩邊都看
  const other: ("pro" | "con")[] = f.v == null || f.v === 0 ? ["pro", "con"] : f.v > 0 ? ["con"] : ["pro"];
  const same: ("pro" | "con")[] = f.v == null || f.v === 0 ? [] : f.v > 0 ? ["pro"] : ["con"];

  const go = (next: number) => {
    setShowSame(false);
    if (next >= questions.length) onDone();
    else if (next >= 0) setIdx(next);
    window.scrollTo(0, 0);
  };

  // 點選項（包括原答案）就記下並進到下一題，和第一輪一樣
  const choose = (v: number | null) => {
    onAnswer(q.id, { v, imp: cur.imp });
    window.setTimeout(() => go(idx + 1), 150);
  };

  return (
    <section className="card">
      <div className="step-head">
        <span className="eyebrow">思辨旅程（第二輪）</span>
        <span className="muted">{idx + 1} / {questions.length}</span>
      </div>
      <div className="progress"><div style={{ width: `${((idx + 1) / questions.length) * 100}%` }} /></div>

      <h2 className="question">{q.text}</h2>
      <Background key={`bg-${q.id}`} question={q} />

      <div className="reflect" key={q.id}>
        <p className="small">
          你第一輪選了「{answerLabel(f.v)}」。
          {other.length === 2 ? "這是雙方的理由：" : `這是${other[0] === "con" ? "不同意" : "同意"}這個說法的人提出的理由：`}
        </p>
        {other.map((k) => <Side key={k} title={SIDE_TITLE[k]} side={args[k]} plain={data.explainers?.[q.id]?.plain[k]} />)}
        {same.length > 0 && (
          <>
            <button className="link small" onClick={() => setShowSame((v) => !v)} aria-expanded={showSame}>
              {showSame ? "收起" : "也看看"}和你同方向的說法
            </button>
            {showSame && same.map((k) => <Side key={k} title={SIDE_TITLE[k]} side={args[k]} plain={data.explainers?.[q.id]?.plain[k]} />)}
          </>
        )}
        <p className="reflect-ask">看完之後，再選一次你的答案（可以和第一輪一樣）。請依論點本身判斷。</p>
      </div>

      <label className={`important important-top ${cur.imp ? "important-on" : ""}`}>
        <input type="checkbox" checked={cur.imp} onChange={(e) => onAnswer(q.id, { v: cur.v, imp: e.target.checked })} />
        <span>這題對我很重要</span>
      </label>

      <div key={`options-${q.id}`} className="options" role="radiogroup" aria-label="同意程度">
        {ANSWER_OPTIONS.map((o) => (
          <button key={String(o.v)} role="radio" aria-checked={cur.v === o.v}
            className={`option ${o.v === null ? "option-unknown" : ""} ${cur.v === o.v ? "selected" : ""}`}
            onClick={() => choose(o.v)}>
            {o.label}{o.v === f.v && <span className="muted small">（第一輪）</span>}
          </button>
        ))}
      </div>

      <div className="nav">
        <button className="secondary" onClick={() => go(idx - 1)} disabled={idx === 0}>上一題</button>
        <button className="link small" onClick={onDone}>跳過剩下的，看結果</button>
        <button onClick={() => go(idx + 1)}>
          {idx === questions.length - 1 ? "完成，看結果" : "下一題"}
        </button>
      </div>
    </section>
  );
}
