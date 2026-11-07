import type React from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { rankByDistance, type AxisScore } from "../lib/scoring";
import { PartyBadge } from "./PartyBadge";

export interface SpectrumParty {
  id: string;
  label: string;
  color?: string;
  badge?: string;
  logo?: string;
  scores: AxisScore[];
}

/** 依底色亮度決定文字用黑或白 */
/** 以 CSS 變數 --pc 傳入政黨色，讓樣式表可以在暗色模式調亮 */
export function pc(color?: string): React.CSSProperties {
  return color ? ({ "--pc": color } as React.CSSProperties) : {};
}

export function textOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#111" : "#fff";
}

interface Props {
  you: AxisScore[];
  parties: SpectrumParty[];
  /** 強調的政黨（橘色） */
  highlightId?: string | null;
  /** 對答修正前的你（虛線） */
  original?: AxisScore[] | null;
  /** 各軸權重（0–3），只影響距離排序 */
  weights?: Record<string, number>;
  onWeight?: (axisId: string, w: number) => void;
}

const WEIGHTS = [0, 1, 2, 3];

function badgeOf(p: SpectrumParty) {
  return { name: p.label, color: p.color, badge: p.badge, logo: p.logo };
}

/** 距離排序：由近到遠的黨徽列，下面標距離 */
function RankStrip({ ranks, parties, highlightId, size = 22 }: {
  ranks: { id: string; distance: number }[]; parties: SpectrumParty[]; highlightId?: string | null; size?: number;
}) {
  const byId = new Map(parties.map((p) => [p.id, p]));
  return (
    <ol className="rank-strip">
      {ranks.map((r) => {
        const p = byId.get(r.id)!;
        return (
          <li key={r.id}>
            <PartyBadge info={badgeOf(p)} detail={`距離 ${r.distance.toFixed(1)}`} highlight={r.id === highlightId} size={size} />
            <span className="rank-d">{r.distance.toFixed(1)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** 所有議題加權後的總排名 */
function OverallRank({ you, parties, weights, highlightId }: {
  you: AxisScore[]; parties: SpectrumParty[]; weights: Record<string, number>; highlightId?: string | null;
}) {
  const ranks = rankByDistance(you, parties, weights);
  const totalAxes = you.filter((s) => s.value !== null && (weights[s.axis.id] ?? 1) > 0).length;
  if (!ranks.length) return null;
  const byId = new Map(parties.map((p) => [p.id, p]));
  return (
    <div className="overall">
      <div className="overall-head">
        <strong>綜合來看，和你最接近 → 最遠</strong>
        <span className="muted small">依下方各議題的權重加權平均；距離 0 表示完全相同，4 表示在兩個極端</span>
      </div>
      <ol className="overall-list">
        {ranks.map((r, i) => {
          const p = byId.get(r.id)!;
          return (
            <li key={r.id} className={r.id === highlightId ? "hl" : ""}>
              <span className="overall-no">{i + 1}</span>
              <PartyBadge info={badgeOf(p)} detail={`距離 ${r.distance.toFixed(2)}`} size={26} />
              <span className="overall-name">{p.label}</span>
              <span className="overall-bar" aria-hidden="true">
                <span style={{ width: `${(r.distance / 4) * 100}%`, ...pc(p.color) }} />
              </span>
              <span className="overall-d">{r.distance.toFixed(2)}</span>
              {r.axes < totalAxes && <span className="muted small overall-cov">依 {r.axes}/{totalAxes} 條軸</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const LANE_H = 28;
const GAP = 4;
const BADGE = 24;

function pct(v: number) {
  return ((v + 2) / 4) * 100;
}

function fmt(v: number) {
  return (v > 0 ? "+" : "") + v.toFixed(1);
}

/** 估計標籤寬度（中文字約 12.5px，含左右內距） */
export function labelWidth(s: string) {
  return [...s].reduce((w, ch) => w + (/[\u0000-ÿ]/.test(ch) ? 7 : 12.5), 0) + 18;
}

interface Placed {
  id: string;
  label: string;
  color?: string;
  value: number;
  x: number;        // 圓點位置（px）
  left: number;     // 標籤左緣（px）
  lane: number;
}

/** 依位置由左到右，把標籤放進第一個不重疊的排，避免互相遮住 */
export function placeLabels(
  items: { id: string; label: string; color?: string; value: number }[],
  width: number,
  itemWidth: (label: string) => number = labelWidth,
): Placed[] {
  const lanes: number[] = [];
  return [...items]
    .sort((a, b) => a.value - b.value)
    .map((it) => {
      const x = (pct(it.value) / 100) * width;
      const w = itemWidth(it.label);
      const left = Math.min(Math.max(x - w / 2, 0), Math.max(width - w, 0));
      let lane = lanes.findIndex((right) => left >= right + GAP);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(0);
      }
      lanes[lane] = left + w;
      return { ...it, x, left, lane };
    });
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function Row({ score, parties, highlightId, original, weight, onWeight }: {
  score: AxisScore; parties: SpectrumParty[]; highlightId?: string | null; original?: number | null;
  weight: number; onWeight?: (w: number) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const axisId = score.axis.id;
  const withValue = parties
    .map((p) => ({ id: p.id, label: p.label, color: p.color, value: p.scores.find((s) => s.axis.id === axisId)?.value ?? null }))
    .filter((p): p is { id: string; label: string; color: string | undefined; value: number } => p.value !== null);
  const noData = parties.filter((p) => !withValue.some((w) => w.id === p.id)).map((p) => p.label);
  const placed = width ? placeLabels(withValue, width, () => BADGE) : [];
  const info = new Map(parties.map((p) => [p.id, p]));
  const lanes = placed.reduce((m, p) => Math.max(m, p.lane + 1), 0);
  const you = score.value!;
  const youShift = pct(you) < 10 ? "35%" : pct(you) > 90 ? "-35%" : "0";

  return (
    <div className={`spec-row ${weight === 0 ? "spec-off" : ""}`}>
      <div className="spec-head">
        <span className="spec-name">{score.axis.name}<span className="muted small">　依 {score.count} 題</span></span>
        {onWeight && parties.length > 0 && (
          <span className="weight small" role="radiogroup" aria-label={`${score.axis.name}的權重`}>
            <span className="muted">權重</span>
            {WEIGHTS.map((w) => (
              <button key={w} role="radio" aria-checked={weight === w} className={weight === w ? "on" : ""}
                onClick={() => onWeight(w)}>{w === 0 ? "0" : `×${w}`}</button>
            ))}
          </span>
        )}
      </div>
      <div className="spec-poles small">
        <span>{score.axis.negative_pole}</span>
        <span>{score.axis.positive_pole}</span>
      </div>
      <div ref={ref} className="spec-area">
        <div className="spec-track" role="img"
          aria-label={`${score.axis.name}：你 ${fmt(you)}；`
            + withValue.map((p) => `${p.label} ${fmt(p.value)}`).join("、")
            + `（-2 ${score.axis.negative_pole}，+2 ${score.axis.positive_pole}）`}>
          <div className="spec-mid" />
          {placed.map((p) => (
            <span key={p.id} className={`spec-dot ${p.id === highlightId ? "spec-dot-hl" : ""}`}
              style={{ left: p.x, ...pc(p.color) }} title={`${p.label}：${fmt(p.value)}`} />
          ))}
          {original != null && (
            <div className="spec-pin spec-you spec-dashed" style={{ left: `${pct(original)}%` }} title={`修正前的你：${fmt(original)}`}>
              <span>修正前</span>
            </div>
          )}
          <div className="spec-pin spec-you" style={{ left: `${pct(you)}%` }} title={`你：${fmt(you)}`}>
            <span style={{ transform: `translate(${youShift}, -2px)` }}>你</span>
          </div>
        </div>
        <div className="spec-labels" style={{ height: lanes * LANE_H + (lanes ? 6 : 0) }}>
          {placed.map((p) => {
            const party = info.get(p.id)!;
            return (
              <div key={p.id}>
                <span className={`spec-leader ${p.id === highlightId ? "hl" : ""}`}
                  style={{ left: p.x, height: p.lane * LANE_H + 6, ...pc(p.color) }} />
                <PartyBadge
                  info={{ name: party.label, color: party.color, badge: party.badge, logo: party.logo }}
                  detail={fmt(p.value)}
                  highlight={p.id === highlightId}
                  size={BADGE}
                  style={{ position: "absolute", left: p.left, top: p.lane * LANE_H + 6 }}
                />
              </div>
            );
          })}
        </div>
      </div>
      {withValue.length > 0 && (
        <div className="spec-rank small">
          <span className="muted">和你的距離（近 → 遠）</span>
          <RankStrip
            ranks={withValue.map((p) => ({ id: p.id, distance: Math.abs(p.value - you) })).sort((a, b) => a.distance - b.distance)}
            parties={parties} highlightId={highlightId} />
          {weight === 0 && <span className="muted">（權重 0：不列入綜合排名）</span>}
        </div>
      )}
      {noData.length > 0 && <p className="muted small spec-nodata">無資料：{noData.join("、")}</p>}
    </div>
  );
}

/** 光譜滑桿：每條軸左右對稱，兩端都是一種立場，中間是 0；所有有資料的政黨同時標示。 */
export function Spectrum({ you, parties, highlightId, original, weights = {}, onWeight }: Props) {
  const rows = you.filter((s) => s.value !== null);
  if (!rows.length) return <p className="muted">這一層沒有足夠的作答可以計算。</p>;
  return (
    <div className="spectrum">
      {parties.length > 0 && <OverallRank you={you} parties={parties} weights={weights} highlightId={highlightId} />}
      {rows.map((s) => {
        const o = original?.find((x) => x.axis.id === s.axis.id)?.value ?? null;
        const moved = o !== null && Math.abs(o - s.value!) > 0.005;
        return (
          <Row key={s.axis.id} score={s} parties={parties} highlightId={highlightId} original={moved ? o : null}
            weight={weights[s.axis.id] ?? 1}
            onWeight={onWeight ? (w) => onWeight(s.axis.id, w) : undefined} />
        );
      })}
    </div>
  );
}
