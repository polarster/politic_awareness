import { useState } from "react";
import type { AxisScore } from "../lib/scoring";

interface Point {
  id: string;
  label: string;
  scores: AxisScore[];
  kind: "you" | "party" | "highlight";
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
  if (axes.length < 2 || !xId || !yId) return null;
  const xa = axes.find((a) => a.id === xId)!;
  const ya = axes.find((a) => a.id === yId)!;
  const val = (p: Point, id: string) => p.scores.find((s) => s.axis.id === id)?.value ?? null;

  const plotted = points.map((p) => ({ p, x: val(p, xId), y: val(p, yId) }));
  const missing = plotted.filter((d) => d.p.kind !== "you" && (d.x === null || d.y === null)).map((d) => d.p.label);
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

        {plotted
          .filter((d) => d.x !== null && d.y !== null)
          .sort((a, b) => (a.p.kind === "you" ? 1 : 0) - (b.p.kind === "you" ? 1 : 0))
          .map(({ p, x, y }) => {
            const cx = coord(x!);
            const cy = coord(-y!); // 直軸 +2 在上方
            return (
              <g key={p.id} className={`pmap-pt pmap-${p.kind}`}>
                <title>{`${p.label}：${xa.name} ${x!.toFixed(1)}，${ya.name} ${y!.toFixed(1)}`}</title>
                <circle cx={cx} cy={cy} r={p.kind === "you" ? 9 : 6} />
                <text x={cx} y={cy - (p.kind === "you" ? 14 : 11)} textAnchor="middle" className="pmap-label">{p.label}</text>
              </g>
            );
          })}
      </svg>
      {missing.length > 0 && (
        <figcaption className="muted small">{missing.join("、")}在這兩條軸中至少一條沒有立場資料，因此未標示。</figcaption>
      )}
    </figure>
  );
}
