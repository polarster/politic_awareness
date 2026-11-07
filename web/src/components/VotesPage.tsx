import { useEffect, useMemo, useRef, useState } from "react";
import { data, itemLabel } from "../data";
import type { VoteRecord } from "../lib/types";
import { VoteBreakdown, voteDate } from "./VoteBreakdown";

const PAGE = 20;
const MAIN = ["中國國民黨", "民主進步黨", "台灣民眾黨"];

function majority(rec: VoteRecord, party: string): string | null {
  let best: string | null = null, n = 0;
  for (const s of ["贊成者", "反對者", "棄權者"] as const) {
    const c = rec.by_party[s]?.[party] ?? 0;
    if (c > n) { n = c; best = s; }
  }
  return best;
}

/** 三大黨的多數立場不一致 */
function divided(rec: VoteRecord): boolean {
  const sides = MAIN.map((p) => majority(rec, p)).filter(Boolean);
  return new Set(sides).size > 1;
}

function Curated({ focus }: { focus?: string }) {
  const refs = useRef<Record<string, HTMLElement | null>>({});
  useEffect(() => {
    if (focus) refs.current[focus]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus]);
  return (
    <>
      {data.votes.map((c) => (
        <article key={c.id} id={c.id} ref={(el) => { refs.current[c.id] = el; }}
          className={`card vote-card ${focus === c.id ? "vote-focus" : ""}`}>
          <div className="step-head">
            <span className="eyebrow">{voteDate(c.records[0])}</span>
            {!c.scored && <span className="tag">未用於計分</span>}
          </div>
          <h2>{c.title}</h2>
          <p>{c.summary}</p>
          {c.note && <p className="note small">{c.note}</p>}
          {!!c.questions?.length && (
            <p className="small muted">相關題目：{c.questions.map((q) => `「${itemLabel(q)}」`).join("、")}</p>
          )}
          <VoteBreakdown rec={c.records[0]} />
          {c.records.slice(1).map((r) => (
            <details key={r.id} className="small">
              <summary>同一案的另一次表決：{r.item}</summary>
              <VoteBreakdown rec={r} compact />
            </details>
          ))}
        </article>
      ))}
    </>
  );
}

function Archive() {
  const [all, setAll] = useState<VoteRecord[] | null>(null);
  const [error, setError] = useState(false);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState<"all" | "10" | "11">("all");
  const [hideProcedural, setHideProcedural] = useState(true);
  const [onlyDivided, setOnlyDivided] = useState(false);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}ly-votes.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: VoteRecord[]) => setAll(j))
      .catch(() => setError(true));
  }, []);

  const filtered = useMemo(() => {
    if (!all) return [];
    const kw = q.trim();
    return all
      .filter((v) => term === "all" || String(v.term) === term)
      .filter((v) => !hideProcedural || !v.procedural)
      .filter((v) => !onlyDivided || divided(v))
      .filter((v) => {
        if (!kw) return true;
        if (v.short_title.includes(kw) || v.item.includes(kw) || v.agenda_title.includes(kw)) return true;
        // 也可以用立委姓名搜尋
        return Object.values(v.names).some((list) => list.some(([n]) => n.includes(kw)));
      })
      .sort((a, b) => voteDate(b).localeCompare(voteDate(a)) || b.no - a.no);
  }, [all, q, term, hideProcedural, onlyDivided]);

  useEffect(() => setPage(1), [q, term, hideProcedural, onlyDivided]);

  if (error) return <p className="error">無法載入表決資料。</p>;
  if (!all) return <p className="muted">載入中…</p>;

  const shown = filtered.slice(0, page * PAGE);
  const kw = q.trim();
  return (
    <section className="card">
      <div className="filters">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="搜尋法案名稱或立委姓名，例如：核、基本工資、沈伯洋" aria-label="搜尋表決" />
        <div className="row small">
          <label>屆別
            <select value={term} onChange={(e) => setTerm(e.target.value as typeof term)}>
              <option value="all">全部</option>
              <option value="11">第 11 屆（2024–）</option>
              <option value="10">第 10 屆（2020–2024）</option>
            </select>
          </label>
          <label><input type="checkbox" checked={hideProcedural} onChange={(e) => setHideProcedural(e.target.checked)} /> 隱藏程序性表決</label>
          <label><input type="checkbox" checked={onlyDivided} onChange={(e) => setOnlyDivided(e.target.checked)} /> 只看三大黨立場不同的</label>
        </div>
        <p className="muted small">共 {filtered.length} 筆（全部 {all.length} 筆）</p>
      </div>
      <ol className="vote-list">
        {shown.map((v) => {
          const personVote = kw
            ? (["贊成者", "反對者", "棄權者"] as const).find((s) => v.names[s]?.some(([n]) => n.includes(kw)))
            : undefined;
          return (
            <li key={v.id}>
              <button className="vote-row" onClick={() => setOpen(open === v.id ? null : v.id)} aria-expanded={open === v.id}>
                <span className="muted small">{voteDate(v)}</span>
                <span className="vote-title">{v.short_title}</span>
                <span className="small muted">{v.item}</span>
                <span className="vote-chips small">
                  {MAIN.map((p) => {
                    const m = majority(v, p);
                    if (!m) return null;
                    return <span key={p} className={`chip chip-${m}`}>{p.replace("中國", "").replace("民主進步黨", "民進黨").replace("台灣", "")}：{m[0]}</span>;
                  })}
                  {personVote && <span className="chip chip-person">{kw}：{personVote[0]}</span>}
                </span>
              </button>
              {open === v.id && (
                <div className="vote-detail">
                  {v.agenda_title && v.agenda_title !== v.short_title && <p className="small muted">議程：{v.agenda_title}</p>}
                  <VoteBreakdown rec={v} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {shown.length < filtered.length && (
        <button className="secondary" onClick={() => setPage((p) => p + 1)}>顯示更多</button>
      )}
    </section>
  );
}

export function VotesPage({ focus, onBack }: { focus?: string; onBack: () => void }) {
  const [tab, setTab] = useState<"curated" | "all">("curated");
  return (
    <>
      <section className="card prose">
        <span className="eyebrow">民眾有知的權利</span>
        <h1>立法院怎麼投票？</h1>
        <p>
          這裡的每一筆表決都來自<strong>立法院議事錄的記名表決紀錄</strong>，附上每位立委的投票與公報原文連結。
          黨籍依立法院公開的委員資料比對。
        </p>
        <p className="small muted">
          資料來源：立法院議事暨公報資訊網；經 g0v 立法院 API 取得議事錄文字檔後整理。
          整理方式可能有誤，請以公報原文為準，發現錯誤歡迎回報。
        </p>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "curated"} className={tab === "curated" ? "" : "secondary"} onClick={() => setTab("curated")}>
            和題目相關的表決
          </button>
          <button role="tab" aria-selected={tab === "all"} className={tab === "all" ? "" : "secondary"} onClick={() => setTab("all")}>
            全部記名表決
          </button>
          <button className="link" onClick={onBack}>返回</button>
        </div>
      </section>
      {tab === "curated" ? <Curated focus={focus} /> : <Archive />}
    </>
  );
}
