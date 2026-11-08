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
  /** 對照用的你（虛線）：簡單版是對答修正前，完整版是第一直覺 */
  original?: AxisScore[] | null;
  originalLabel?: string;
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
  const totalAxes = you.filter((s) => s.value !== null && (weights[s.axis.id] ?? 1) > 0).length;
  const all = rankByDistance(you, parties, weights);
  // 有資料的軸不到一半的政黨，不列入排名（只靠一兩條軸的距離沒有代表性）
  const ranks = all.filter((r) => r.axes * 2 >= totalAxes);
  const left = all.filter((r) => r.axes * 2 < totalAxes).map((r) => parties.find((p) => p.id === r.id)!.label);
  const byId = new Map(parties.map((p) => [p.id, p]));
  if (ranks.length < 2) {
    return (
      <div className="overall">
        <strong>綜合排名</strong>
        <p className="muted small">這一層的政黨立場資料還太少（多數政黨有資料的軸不到一半），暫不排名。各黨在個別軸上的位置仍標在下方光譜上。</p>
      </div>
    );
  }
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
              <PartyBadge info={badgeOf(p)} detail={`距離 ${r.distance.toFixed(2)}${r.axes < totalAxes ? `（依 ${r.axes}/${totalAxes} 條軸）` : ""}`} size={26} />
              <span className="overall-name">{p.label}{r.axes < totalAxes && <sup className="muted">*</sup>}</span>
              <span className="overall-bar" aria-hidden="true">
                <span style={{ width: `${(r.distance / 4) * 100}%`, ...pc(p.color) }} />
              </span>
              <span className="overall-d">{r.distance.toFixed(2)}</span>
            </li>
          );
        })}
      </ol>
      {(ranks.some((r) => r.axes < totalAxes) || left.length > 0) && (
        <p className="muted small overall-foot">
          {ranks.some((r) => r.axes < totalAxes) && "* 部分軸沒有該黨資料，只用有資料的軸計算。"}
          {left.length > 0 && `${left.join("、")}有資料的軸不到一半，未列入排名。`}
        </p>
      )}
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

function Row({ score, parties, highlightId, original, originalLabel = "修正前", weight, onWeight, showRank, totalParties }: {
  score: AxisScore; parties: SpectrumParty[]; highlightId?: string | null; original?: number | null; originalLabel?: string;
  weight: number; onWeight?: (w: number) => void; showRank: boolean; totalParties: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const axisId = score.axis.id;
  const withValue = parties
    .map((p) => ({ id: p.id, label: p.label, color: p.color, value: p.scores.find((s) => s.axis.id === axisId)?.value ?? null }))
    .filter((p): p is { id: string; label: string; color: string | undefined; value: number } => p.value !== null);
  const noData = parties.filter((p) => !withValue.some((w) => w.id === p.id)).map((p) => p.label);
  // 黨徽直接放在軌道上；太近時往下錯開一排，用短線連回原位置
  const placed = width ? placeLabels(withValue, width, () => BADGE) : [];
  const info = new Map(parties.map((p) => [p.id, p]));
  const lanes = placed.reduce((m, p) => Math.max(m, p.lane + 1), 0);
  const you = score.value!;
  const youShift = pct(you) < 10 ? "35%" : pct(you) > 90 ? "-35%" : "0";

  return (
    <div className={`spec-row ${weight === 0 ? "spec-off" : ""}`}>
      <div className="spec-head">
        <span className="spec-name">{score.axis.name}<span className="muted small">　依 {score.count} 題</span></span>
        {onWeight && withValue.length > 0 && (
          <span className="weight small" role="radiogroup" aria-label={`${score.axis.name}的權重`}>
            <span className="muted">權重</span>
            {WEIGHTS.map((w) => (
              <button key={w} role="radio" aria-checked={weight === w} className={weight === w ? "on" : ""}
                onClick={() => onWeight(w)}>{w === 0 ? "0" : `×${w}`}</button>
            ))}
          </span>
        )}
      </div>
      <div ref={ref} className="spec-area" style={{ paddingBottom: lanes > 1 ? (lanes - 1) * LANE_H : 0 }}>
        <div className="spec-track" role="img"
          aria-label={`${score.axis.name}：你 ${fmt(you)}；`
            + withValue.map((p) => `${p.label} ${fmt(p.value)}`).join("、")
            + `（-2 ${score.axis.negative_pole}，+2 ${score.axis.positive_pole}）`}>
          <div className="spec-mid" />
          {original != null && (
            <span className="spec-move" style={{ left: `${pct(Math.min(original, you))}%`, width: `${Math.abs(pct(original) - pct(you))}%` }} />
          )}
          {original != null && (
            <div className="spec-pin spec-you spec-dashed spec-nolabel" style={{ left: `${pct(original)}%` }} title={`${originalLabel}的你：${fmt(original)}`} />
          )}
          <div className="spec-pin spec-you" style={{ left: `${pct(you)}%` }} title={`你：${fmt(you)}`}>
            <span style={{ transform: `translate(${youShift}, -2px)` }}>你</span>
          </div>
        </div>
        {placed.map((p) => {
          const party = info.get(p.id)!;
          return (
            <div key={p.id}>
              {p.lane > 0 && (
                <span className={`spec-leader ${p.id === highlightId ? "hl" : ""}`}
                  style={{ left: p.x, top: 6, height: p.lane * LANE_H, ...pc(p.color) }} />
              )}
              <PartyBadge
                info={{ name: party.label, color: party.color, badge: party.badge, logo: party.logo }}
                detail={fmt(p.value)}
                highlight={p.id === highlightId}
                size={BADGE}
                align={p.x < 50 ? "start" : p.x > width - 80 ? "end" : "center"}
                style={{ position: "absolute", left: Math.min(Math.max(p.x - BADGE / 2, -4), width - BADGE + 4), top: 6 - BADGE / 2 + p.lane * LANE_H }}
              />
            </div>
          );
        })}
      </div>
      <div className="spec-poles small">
        <span>{score.axis.negative_pole}</span>
        <span>{score.axis.positive_pole}</span>
      </div>
      {showRank && withValue.length > 0 && (
        <div className="spec-rank small">
          <span className="muted">和你的距離（近 → 遠）</span>
          <RankStrip
            ranks={withValue.map((p) => ({ id: p.id, distance: Math.abs(p.value - you) })).sort((a, b) => a.distance - b.distance)}
            parties={parties} highlightId={highlightId} />
          {weight === 0 && <span className="muted">（權重 0：不列入綜合排名）</span>}
        </div>
      )}
      {totalParties > 0 && (withValue.length === 0
        ? <p className="muted small spec-nodata">這條軸目前沒有政黨資料。</p>
        : noData.length > 0 && <p className="muted small spec-nodata">無資料：{noData.join("、")}</p>)}
    </div>
  );
}

/** 光譜滑桿：每條軸左右對稱，兩端都是一種立場，中間是 0；所有有資料的政黨同時標示。 */
export function Spectrum({ you, parties, highlightId, original, originalLabel = "修正前", weights = {}, onWeight }: Props) {
  const [showRank, setShowRank] = useState(false);
  const rows = you.filter((s) => s.value !== null);
  if (!rows.length) return <p className="muted">這一層沒有足夠的作答可以計算。</p>;
  const anyMoved = rows.some((s) => {
    const o = original?.find((x) => x.axis.id === s.axis.id)?.value ?? null;
    return o !== null && Math.abs(o - s.value!) > 0.005;
  });
  return (
    <div className="spectrum">
      {parties.length > 0 && <OverallRank you={you} parties={parties} weights={weights} highlightId={highlightId} />}
      <div className="spec-legend small">
        <span><i className="lg-you" />你</span>
        {anyMoved && <span><i className="lg-orig" />{originalLabel}</span>}
        {parties.length > 0 && <span className="muted">黨徽：各政黨的位置（點一下看名稱）</span>}
        {parties.length > 0 && (
          <label className="spec-rank-toggle">
            <input type="checkbox" checked={showRank} onChange={(e) => setShowRank(e.target.checked)} />
            顯示每條軸的距離排序
          </label>
        )}
      </div>
      {rows.map((s) => {
        const o = original?.find((x) => x.axis.id === s.axis.id)?.value ?? null;
        const moved = o !== null && Math.abs(o - s.value!) > 0.005;
        return (
          <Row key={s.axis.id} score={s} parties={parties} highlightId={highlightId} original={moved ? o : null} originalLabel={originalLabel}
            weight={weights[s.axis.id] ?? 1} showRank={showRank} totalParties={parties.length}
            onWeight={onWeight ? (w) => onWeight(s.axis.id, w) : undefined} />
        );
      })}
    </div>
  );
}
