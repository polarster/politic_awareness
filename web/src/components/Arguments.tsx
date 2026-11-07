import { useState } from "react";
import { data } from "../data";
import type { ArgumentSide } from "../lib/types";

const KIND_LABELS: Record<string, string> = {
  gazette: "立法院公報",
  minutes: "議事錄",
  official: "官方文件",
  news: "新聞",
};

function Side({ title, side }: { title: string; side: ArgumentSide }) {
  return (
    <div className="arg-side">
      <strong>{title}</strong>
      <p>{side.text}</p>
      {side.sources.length > 0 ? (
        <ul className="arg-sources small">
          {side.sources.map((s, i) => (
            <li key={i}>
              <span className="tag">{KIND_LABELS[s.kind] ?? s.kind}</span>{" "}
              <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
              {s.speaker && <span className="muted">（{s.speaker}）</span>}
              {s.date && <span className="muted"> · {s.date}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{side.note ?? "查無合適來源"}</p>
      )}
    </div>
  );
}

/** 題目下方的「正面說法／反面說法」。換題時由 key 重設。 */
export function Arguments({ questionId }: { questionId: string }) {
  const a = data.arguments[questionId];
  const [open, setOpen] = useState<{ pro: boolean; con: boolean }>({ pro: false, con: false });
  if (!a) return null;
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
      {open.pro && <Side title="同意的理由" side={a.pro} />}
      {open.con && <Side title="不同意的理由" side={a.con} />}
      {onlyOne && (
        <button className="link small" onClick={() => setOpen({ pro: true, con: true })}>
          也看看另一方的說法
        </button>
      )}
    </div>
  );
}
