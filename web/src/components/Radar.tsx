import { useState } from "react";
import type { AxisScore } from "../lib/scoring";

interface Props {
  you: AxisScore[];
  /** 對照的政黨（或修正前的你） */
  compare?: { label: string; scores: AxisScore[]; dashed?: boolean } | null;
  title: string;
}

const SIZE = 360;
const C = SIZE / 2;
const R = 104;
const RINGS = [-2, -1, 0, 1, 2];

function radius(v: number) {
  return ((v + 2) / 4) * R;
}

function point(i: number, n: number, v: number) {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const r = radius(v);
  return [C + r * Math.cos(a), C + r * Math.sin(a)] as const;
}

function fmt(v: number | null) {
  return v === null ? "無資料" : (v > 0 ? "+" : "") + v.toFixed(1);
}

/** 雷達圖：每條軸由圓心（-2 端）往外（+2 端）。 */
export function Radar({ you, compare, title }: Props) {
  const axes = you.filter((s) => s.value !== null).map((s) => s.axis);
  const [hover, setHover] = useState<number | null>(null);
  const n = axes.length;
  if (n < 3) return null;

  const val = (scores: AxisScore[] | undefined, id: string) =>
    scores?.find((s) => s.axis.id === id)?.value ?? null;

  const poly = (scores: AxisScore[]) =>
    axes.map((a, i) => point(i, n, val(scores, a.id) ?? 0).join(",")).join(" ");

  const ring = (v: number) => axes.map((_, i) => point(i, n, v).join(",")).join(" ");

  return (
    <figure className="radar">
      <svg viewBox={`-70 -6 ${SIZE + 140} ${SIZE + 6}`} role="img" aria-label={`${title}雷達圖`}>
        {RINGS.map((v) => (
          <polygon key={v} points={ring(v)} className={v === 0 ? "radar-ring radar-ring-mid" : "radar-ring"} />
        ))}
        {axes.map((_, i) => {
          const [x, y] = point(i, n, 2);
          return <line key={i} x1={C} y1={C} x2={x} y2={y} className="radar-spoke" />;
        })}

        {compare && (
          <polygon points={poly(compare.scores)} className={`radar-shape radar-compare ${compare.dashed ? "radar-dashed" : ""}`} />
        )}
        <polygon points={poly(you)} className="radar-shape radar-you" />

        {compare && axes.map((a, i) => {
          const v = val(compare.scores, a.id);
          if (v === null) return null;
          const [x, y] = point(i, n, v);
          return <circle key={`c${i}`} cx={x} cy={y} r={4} className="radar-dot radar-dot-compare" />;
        })}
        {axes.map((a, i) => {
          const [x, y] = point(i, n, val(you, a.id)!);
          return <circle key={`y${i}`} cx={x} cy={y} r={hover === i ? 6 : 4.5} className="radar-dot radar-dot-you" />;
        })}

        {axes.map((a, i) => {
          const [lx, ly] = point(i, n, 3.05);
          const anchor = Math.abs(lx - C) < 8 ? "middle" : lx > C ? "start" : "end";
          return (
            <g key={`l${i}`}>
              <text x={lx} y={ly} textAnchor={anchor} className="radar-label">{a.name}</text>
              <text x={lx} y={ly + 17} textAnchor={anchor} className="radar-sublabel">外：{a.positive_pole}</text>
            </g>
          );
        })}

        {/* 擴大的感應區 */}
        {axes.map((_, i) => {
          const [x, y] = point(i, n, val(you, axes[i].id)!);
          return (
            <circle key={`h${i}`} cx={x} cy={y} r={18} className="radar-hit"
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              onClick={() => setHover(hover === i ? null : i)} />
          );
        })}
      </svg>

      {hover !== null && (
        <div className="radar-tip small" role="status">
          <strong>{axes[hover].name}</strong>
          <div>你：{fmt(val(you, axes[hover].id))}</div>
          {compare && <div>{compare.label}：{fmt(val(compare.scores, axes[hover].id))}</div>}
          <div className="muted">-2 {axes[hover].negative_pole} ↔ +2 {axes[hover].positive_pole}</div>
        </div>
      )}

      <figcaption className="radar-legend small">
        <span><i className="key key-you" />你</span>
        {compare && <span><i className={`key key-compare ${compare.dashed ? "key-dashed" : ""}`} />{compare.label}</span>}
        <span className="muted">越靠外圈越接近「外」那一端；虛線圈是中間（0）</span>
      </figcaption>
    </figure>
  );
}
