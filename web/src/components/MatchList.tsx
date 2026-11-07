import { useState } from "react";
import { budgetItemById, itemLabel } from "../data";
import {
  answerLabel, BUDGET_DIR_LABELS, EVIDENCE_KIND_LABELS, GRADE_LABELS, STEP_LABELS,
} from "../lib/labels";
import { LOW_COVERAGE, type MatchResult } from "../lib/scoring";
import type { Evidence } from "../lib/types";
import { FeedbackLink } from "./FeedbackLink";

function evidenceUrl(e: Evidence): string {
  if (e.timestamp == null) return e.url;
  try {
    const u = new URL(e.url);
    u.searchParams.set("t", String(e.timestamp));
    return u.toString();
  } catch {
    return e.url;
  }
}

function userLabel(id: string, v: number | null): string {
  return budgetItemById.has(id) ? STEP_LABELS[v ?? 0] : answerLabel(v);
}

function stanceLabel(id: string, v: number): string {
  return budgetItemById.has(id) ? BUDGET_DIR_LABELS[v] : answerLabel(v);
}

function Detail({ m }: { m: MatchResult }) {
  return (
    <table className="compare">
      <thead>
        <tr><th>題目</th><th>你</th><th>{m.entity.short ?? m.entity.name}</th></tr>
      </thead>
      <tbody>
        {m.items.map((it) => (
          <tr key={it.id}>
            <td>{itemLabel(it.id)}</td>
            <td>{userLabel(it.id, it.user)}</td>
            <td>
              {it.stance ? (
                <details>
                  <summary>
                    {stanceLabel(it.id, it.stance.value)}
                    <span className={`grade grade-${it.stance.grade}`}>{it.stance.grade}</span>
                  </summary>
                  <p className="small"><strong>判斷依據：</strong>{it.stance.interpretation}</p>
                  <ul className="evidence">
                    {it.stance.evidence.map((e, i) => (
                      <li key={i}>
                        <span className="muted small">
                          {GRADE_LABELS[e.grade]} · {EVIDENCE_KIND_LABELS[e.kind] ?? e.kind}
                          {e.date ? ` · ${e.date}` : ""}{e.venue ? ` · ${e.venue}` : ""}
                        </span>
                        {e.quote && <blockquote>「{e.quote}」</blockquote>}
                        {e.context && <p className="muted small">前後語境：{e.context}</p>}
                        <a href={evidenceUrl(e)} target="_blank" rel="noreferrer">{e.title ?? "出處連結"}</a>
                      </li>
                    ))}
                  </ul>
                  <FeedbackLink kind="立場標錯" target={`${m.entity.id}:${it.id}`} label="這個立場標錯了？" />
                </details>
              ) : (
                <span className="muted">查無資料</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function MatchList({ matches }: { matches: MatchResult[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const withData = matches.filter((m) => m.score !== null);
  if (!withData.length) {
    return (
      <p className="muted">
        政黨與政治人物的立場資料還在整理中。每一筆立場都需要附上出處（表決紀錄、政見、訪談等），完成後就會出現在這裡。
      </p>
    );
  }
  return (
    <ol className="matches">
      {withData.map((m) => {
        const coverage = m.compared / Math.max(m.total, 1);
        const isOpen = open === m.entity.id;
        return (
          <li key={m.entity.id}>
            <button className="match-row" onClick={() => setOpen(isOpen ? null : m.entity.id)} aria-expanded={isOpen}>
              <span className="match-name">{m.entity.name}</span>
              <span className="match-bar"><span style={{ width: `${m.score! * 100}%` }} /></span>
              <span className="match-score">{Math.round(m.score! * 100)}%</span>
            </button>
            <div className="muted small">
              比對 {m.compared}/{m.total} 題
              {coverage < LOW_COVERAGE && "（可比對的題目偏少，結果參考價值有限）"}
            </div>
            {isOpen && <Detail m={m} />}
          </li>
        );
      })}
    </ol>
  );
}
