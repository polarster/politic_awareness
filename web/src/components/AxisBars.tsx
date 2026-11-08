import type { AxisScore } from "../lib/scoring";

interface Props {
  scores: AxisScore[];
  /** 對答修正前的位置；有修正時以淡色標記顯示 */
  original?: AxisScore[];
  originalLabel?: string;
}

function pct(v: number): number {
  return ((v + 2) / 4) * 100;
}

export function AxisBars({ scores, original, originalLabel = "修正前" }: Props) {
  const shown = scores.filter((s) => s.value !== null);
  if (!shown.length) return <p className="muted">這一層沒有足夠的作答可以計算。</p>;
  return (
    <div className="axes">
      {shown.map((s) => {
        const o = original?.find((x) => x.axis.id === s.axis.id)?.value ?? null;
        const moved = o !== null && Math.abs(o - s.value!) > 0.005;
        return (
          <div key={s.axis.id} className="axis">
            <div className="axis-name">
              {s.axis.name}
              <span className="muted small">（依 {s.count} 題）</span>
            </div>
            <div className="axis-track" role="img"
              aria-label={`${s.axis.name}：${s.value!.toFixed(2)}，-2 為${s.axis.negative_pole}，+2 為${s.axis.positive_pole}`}>
              <div className="axis-mid" />
              {moved && <div className="axis-dot axis-dot-orig" style={{ left: `${pct(o!)}%` }} title={originalLabel} />}
              <div className="axis-dot" style={{ left: `${pct(s.value!)}%` }} />
            </div>
            <div className="axis-poles small">
              <span>{s.axis.negative_pole}</span>
              <span>{s.axis.positive_pole}</span>
            </div>
          </div>
        );
      })}
      {original && <p className="muted small">{originalLabel === "修正前" ? "空心圓點是與 Claude 對答修正前的位置。" : `空心圓點是${originalLabel}的位置。`}</p>}
    </div>
  );
}
