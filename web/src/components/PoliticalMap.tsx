import { useState } from "react";
import type { AxisScore } from "../lib/scoring";
import { pc } from "./Spectrum";

interface Point {
  id: string;
  label: string;
  color?: string;
  badge?: string;
  logo?: string;
  scores: AxisScore[];
  kind: "you" | "you-first" | "party" | "highlight";
}

interface Props {
  points: Point[];
  defaultX: string;
  defaultY: string;
}

const S = 300;      // 繪圖區邊長
const PAD = 34;

function coord(v: number) {
  return PAD + ((v + 2) / 4) * S;
}

/** 二維政治地圖：任選兩條軸當 X、Y，你與各政黨都是地圖上的一個點。 */
export function PoliticalMap({ points, defaultX, defaultY }: Props) {
  const axes = points.find((p) => p.kind === "you")!.scores.filter((s) => s.value !== null).map((s) => s.axis);
  const [xId, setX] = useState(axes.some((a) => a.id === defaultX) ? defaultX : axes[0]?.id);
  const [yId, setY] = useState(axes.some((a) => a.id === defaultY) ? defaultY : axes[1]?.id);
  const [tip, setTip] = useState<string | null>(null);
  if (axes.length < 2 || !xId || !yId) return null;
  const xa = axes.find((a) => a.id === xId)!;
  const ya = axes.find((a) => a.id === yId)!;
  const val = (p: Point, id: string) => p.scores.find((s) => s.axis.id === id)?.value ?? null;

  const plotted = points.map((p) => ({ p, x: val(p, xId), y: val(p, yId) }));
  const missing = plotted.filter((d) => d.p.kind !== "you" && d.p.kind !== "you-first" && (d.x === null || d.y === null)).map((d) => d.p.label);
  const W = S + PAD * 2;

  return (
    <figure className="pmap">
      <div className="pmap-controls small">
        <label>橫軸
          <select value={xId} onChange={(e) => setX(e.target.value)}>
            {axes.filter((a) => a.id !== yId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label>直軸
          <select value={yId} onChange={(e) => setY(e.target.value)}>
            {axes.filter((a) => a.id !== xId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      </div>
      <svg viewBox={`0 0 ${W} ${W + 8}`} role="img" aria-label={`政治地圖：橫軸${xa.name}，直軸${ya.name}`}>
        <rect x={PAD} y={PAD} width={S} height={S} rx={14} className="pmap-bg" />
        {[-1, 1].map((v) => (
          <g key={v}>
            <line x1={coord(v)} y1={PAD} x2={coord(v)} y2={PAD + S} className="pmap-grid" />
            <line x1={PAD} y1={coord(v)} x2={PAD + S} y2={coord(v)} className="pmap-grid" />
          </g>
        ))}
        <line x1={coord(0)} y1={PAD} x2={coord(0)} y2={PAD + S} className="pmap-axis" />
        <line x1={PAD} y1={coord(0)} x2={PAD + S} y2={coord(0)} className="pmap-axis" />

        {/* 四邊的立場名稱放在繪圖區外：直軸 +2 在上 */}
        <text x={coord(0)} y={PAD - 10} textAnchor="middle" className="pmap-pole">▲ {ya.positive_pole}</text>
        <text x={coord(0)} y={PAD + S + 20} textAnchor="middle" className="pmap-pole">▼ {ya.negative_pole}</text>
        <text x={PAD} y={PAD + S + 20} className="pmap-pole">◀ {xa.negative_pole}</text>
        <text x={PAD + S} y={PAD + S + 20} textAnchor="end" className="pmap-pole">{xa.positive_pole} ▶</text>

        {/* 完整版：第一直覺 → 現在的箭頭 */}
        {(() => {
          const a = plotted.find((d) => d.p.kind === "you-first");
          const b = plotted.find((d) => d.p.kind === "you");
          if (!a || !b || a.x === null || a.y === null || b.x === null || b.y === null) return null;
          if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01) return null;
          return <line x1={coord(a.x)} y1={coord(-a.y)} x2={coord(b.x)} y2={coord(-b.y)} className="pmap-move" />;
        })()}
        {plotted
          .filter((d) => d.x !== null && d.y !== null)
          .filter((d, _, all) => d.p.kind !== "you-first" || !all.some((o) => o.p.kind === "you" && Math.abs(o.x! - d.x!) < 0.01 && Math.abs(o.y! - d.y!) < 0.01))
          .sort((a, b) => (a.p.kind === "you" ? 1 : 0) - (b.p.kind === "you" ? 1 : 0))
          .map(({ p, x, y }) => {
            const cx = coord(x!);
            const cy = coord(-y!); // 直軸 +2 在上方
            const text = `${p.label}：${xa.name} ${x!.toFixed(1)}，${ya.name} ${y!.toFixed(1)}`;
            if (p.kind === "you-first") {
              return (
                <g key={p.id} className="pmap-pt pmap-first">
                  <title>{text}</title>
                  <circle cx={cx} cy={cy} r={8} />
                  <text x={cx} y={cy + 22} textAnchor="middle" className="pmap-label">{p.label}</text>
                </g>
              );
            }
            if (p.kind === "you") {
              return (
                <g key={p.id} className="pmap-pt pmap-you">
                  <title>{text}</title>
                  <circle cx={cx} cy={cy} r={9} />
                  <text x={cx} y={cy - 14} textAnchor="middle" className="pmap-label">你</text>
                </g>
              );
            }
            const r = p.kind === "highlight" ? 14 : 12;
            return (
              <g key={p.id} className={`pmap-pt pmap-${p.kind}`} style={pc(p.color)} tabIndex={0} role="button"
                aria-label={text}
                onMouseEnter={() => setTip(p.id)} onMouseLeave={() => setTip(null)}
                onFocus={() => setTip(p.id)} onBlur={() => setTip(null)}
                onClick={() => setTip(tip === p.id ? null : p.id)}>
                <circle cx={cx} cy={cy} r={r} />
                {p.logo
                  ? <image href={`${import.meta.env.BASE_URL}${p.logo}`} x={cx - r + 2} y={cy - r + 2} width={2 * r - 4} height={2 * r - 4} />
                  : <text x={cx} y={cy + 4.5} textAnchor="middle" className="pmap-badge-text">{p.badge ?? p.label.slice(0, 1)}</text>}
              </g>
            );
          })}
      </svg>
      {tip && (() => {
        const d = plotted.find((q) => q.p.id === tip);
        if (!d || d.x === null || d.y === null) return null;
        return (
          <span className="badge-tip pmap-tip" role="tooltip"
            style={{ left: `${(coord(d.x) / W) * 100}%`, top: `${(coord(-d.y) / (W + 8)) * 100}%` }}>
            {d.p.label}：{xa.name} {d.x.toFixed(1)}，{ya.name} {d.y.toFixed(1)}
          </span>
        );
      })()}
      {missing.length > 0 && (
        <figcaption className="muted small">{missing.join("、")}在這兩條軸中至少一條沒有立場資料，因此未標示。</figcaption>
      )}
    </figure>
  );
}
