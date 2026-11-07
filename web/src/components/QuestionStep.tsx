import { useState } from "react";
import { ANSWER_OPTIONS } from "../lib/labels";
import type { Answer, Answers, Question } from "../lib/types";
import { FeedbackLink } from "./FeedbackLink";

interface Props {
  title: string;
  questions: Question[];
  answers: Answers;
  onAnswer: (id: string, a: Answer) => void;
  onDone: () => void;
  onBack: () => void;
}

export function QuestionStep({ title, questions, answers, onAnswer, onDone, onBack }: Props) {
  const firstUnanswered = questions.findIndex((q) => !(q.id in answers));
  const [idx, setIdx] = useState(firstUnanswered === -1 ? 0 : firstUnanswered);
  const [showNote, setShowNote] = useState(false);
  const q = questions[idx];
  const cur = answers[q.id];
  // 作答前就可以先勾「重要」；已作答的題目以作答紀錄為準
  const [pendingImp, setPendingImp] = useState(false);
  const imp = cur ? cur.imp : pendingImp;
  const answeredCount = questions.filter((x) => x.id in answers).length;

  const go = (next: number) => {
    setShowNote(false);
    setPendingImp(false);
    if (next < 0) onBack();
    else if (next >= questions.length) onDone();
    else setIdx(next);
  };

  const choose = (v: number | null) => {
    onAnswer(q.id, { v, imp });
    window.setTimeout(() => go(idx + 1), 150);
  };

  return (
    <section className="card">
      <div className="step-head">
        <span className="eyebrow">{title}</span>
        <span className="muted">{idx + 1} / {questions.length}</span>
      </div>
      <div className="progress"><div style={{ width: `${(answeredCount / questions.length) * 100}%` }} /></div>

      <h2 className="question">{q.text}</h2>
      {q.note && (
        <button className="link" onClick={() => setShowNote((s) => !s)}>
          {showNote ? "收起背景說明" : "背景說明"}
        </button>
      )}
      {showNote && <p className="note">{q.note}</p>}

      <label className={`important important-top ${imp ? "important-on" : ""}`}>
        <input
          type="checkbox"
          checked={imp}
          onChange={(e) => (cur ? onAnswer(q.id, { v: cur.v, imp: e.target.checked }) : setPendingImp(e.target.checked))}
        />
        <span>
          這題對我很重要
          <span className="muted small">先想想這個議題對你的份量，重要的題目計分時權重加倍</span>
        </span>
      </label>

      <div className="options" role="radiogroup" aria-label="同意程度">
        {ANSWER_OPTIONS.map((o) => (
          <button
            key={String(o.v)}
            role="radio"
            aria-checked={cur?.v === o.v && cur !== undefined}
            className={`option ${o.v === null ? "option-unknown" : ""} ${cur !== undefined && cur.v === o.v ? "selected" : ""}`}
            onClick={() => choose(o.v)}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className="nav">
        <button className="secondary" onClick={() => go(idx - 1)}>上一題</button>
        <FeedbackLink kind="題目措辭偏頗" target={q.id} label="這題措辭有問題？" />
        <button className="secondary" onClick={() => go(idx + 1)} disabled={!cur}>
          {idx === questions.length - 1 ? "完成" : "下一題"}
        </button>
      </div>
    </section>
  );
}
