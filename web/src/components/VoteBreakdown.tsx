import { useState } from "react";
import type { VoteRecord, VoteSide } from "../lib/types";

const SIDES: VoteSide[] = ["贊成者", "反對者", "棄權者"];
const PARTY_ORDER = ["中國國民黨", "民主進步黨", "台灣民眾黨", "時代力量", "台灣基進", "親民黨", "無黨籍", "無黨團結聯盟"];

export function sideLabel(rec: VoteRecord, side: VoteSide): string {
  if (rec.kind === "override") {
    return side === "贊成者" ? "贊成維持原決議" : side === "反對者" ? "反對維持原決議" : "棄權";
  }
  return side === "贊成者" ? "贊成" : side === "反對者" ? "反對" : "棄權";
}

function parties(rec: VoteRecord): string[] {
  const set = new Set<string>();
  for (const s of SIDES) for (const p of Object.keys(rec.by_party[s] ?? {})) set.add(p);
  return [...set].sort((a, b) => {
    const ia = PARTY_ORDER.indexOf(a), ib = PARTY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

export function voteDate(rec: VoteRecord): string {
  return rec.dates?.[0] ?? "";
}

/** 各黨的贊成／反對／棄權人數；可展開逐人名單。 */
export function VoteBreakdown({ rec, compact = false }: { rec: VoteRecord; compact?: boolean }) {
  const [showNames, setShowNames] = useState(false);
  const ps = parties(rec);
  return (
    <div className="vote-breakdown">
      <table className="vote-table">
        <thead>
          <tr>
            <th>政黨</th>
            {SIDES.map((s) => <th key={s}>{sideLabel(rec, s)}</th>)}
          </tr>
        </thead>
        <tbody>
          {ps.map((p) => {
            const counts = SIDES.map((s) => rec.by_party[s]?.[p] ?? 0);
            const total = counts.reduce((a, b) => a + b, 0) || 1;
            return (
              <tr key={p}>
                <td>{p === "?" ? "未比對到黨籍" : p}</td>
                {counts.map((c, i) => (
                  <td key={i} className={`vote-cell vote-${i}`}>
                    {c > 0 && <span className="vote-bar" style={{ width: `${(c / total) * 100}%` }} />}
                    <span className="vote-num">{c || "–"}</span>
                  </td>
                ))}
              </tr>
            );
          })}
          <tr className="vote-total">
            <td>合計</td>
            <td>{rec.counts.贊成}</td><td>{rec.counts.反對}</td><td>{rec.counts.棄權}</td>
          </tr>
        </tbody>
      </table>
      <div className="row small">
        <button className="link" onClick={() => setShowNames((v) => !v)}>
          {showNames ? "收起逐人名單" : "看每位立委怎麼投"}
        </button>
        <a href={rec.source_url} target="_blank" rel="noreferrer">立法院公報原文</a>
        {!compact && <span className="muted">出席 {rec.counts.出席} 人</span>}
      </div>
      {showNames && (
        <div className="vote-names">
          {SIDES.filter((s) => rec.names[s]?.length).map((s) => (
            <div key={s}>
              <strong>{sideLabel(rec, s)}（{rec.names[s].length}）</strong>
              {ps.filter((p) => rec.names[s].some(([, pp]) => pp === p)).map((p) => (
                <p key={p} className="small">
                  <span className="muted">{p === "?" ? "未比對到黨籍" : p}：</span>
                  {rec.names[s].filter(([, pp]) => pp === p).map(([n]) => n).join("、")}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
