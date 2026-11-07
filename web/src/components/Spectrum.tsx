import type { AxisScore } from "../lib/scoring";

interface Props {
  you: AxisScore[];
  /** 對照對象（政黨或修正前的你） */
  compare?: { label: string; scores: AxisScore[]; dashed?: boolean } | null;
}

function pct(v: number) {
  return ((v + 2) / 4) * 100;
}

/** 靠近兩端時只把文字標籤往內推（圓點維持在正確位置），避免被切掉 */
function shift(v: number, dy: number) {
  const p = pct(v);
  const dx = p < 12 ? "35%" : p > 88 ? "-35%" : "0";
  return `translate(${dx}, ${dy}px)`;
}

function fmt(v: number) {
  return (v > 0 ? "+" : "") + v.toFixed(1);
}

/** 光譜滑桿：每條軸左右對稱，兩端都是一種立場，中間是 0。 */
export function Spectrum({ you, compare }: Props) {
  const rows = you.filter((s) => s.value !== null);
  if (!rows.length) return <p className="muted">這一層沒有足夠的作答可以計算。</p>;
  return (
    <div className="spectrum">
      {rows.map((s) => {
        const c = compare?.scores.find((x) => x.axis.id === s.axis.id)?.value ?? null;
        return (
          <div key={s.axis.id} className="spec-row">
            <div className="spec-head">
              <span className="spec-name">{s.axis.name}</span>
              <span className="muted small">依 {s.count} 題</span>
            </div>
            <div className="spec-poles small">
              <span>{s.axis.negative_pole}</span>
              <span>{s.axis.positive_pole}</span>
            </div>
            <div className="spec-track"
              role="img"
              aria-label={`${s.axis.name}：你 ${fmt(s.value!)}${compare && c !== null ? `，${compare.label} ${fmt(c)}` : ""}（-2 ${s.axis.negative_pole}，+2 ${s.axis.positive_pole}）`}>
              <div className="spec-mid" />
              <div className="spec-pin spec-you" style={{ left: `${pct(s.value!)}%` }} title={`你：${fmt(s.value!)}`}>
                <span style={{ transform: shift(s.value!, -2) }}>你</span>
              </div>
              {compare && c !== null && (
                <div className={`spec-pin spec-compare ${compare.dashed ? "spec-dashed" : ""}`}
                  style={{ left: `${pct(c)}%` }} title={`${compare.label}：${fmt(c)}`}>
                  <span style={{ transform: shift(c, 2) }}>{compare.label}</span>
                </div>
              )}
            </div>
            {compare && c === null && <p className="muted small spec-nodata">{compare.label}在這條軸沒有立場資料</p>}
          </div>
        );
      })}
    </div>
  );
}
