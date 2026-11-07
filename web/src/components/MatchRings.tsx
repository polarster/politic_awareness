import { LOW_COVERAGE, type MatchResult } from "../lib/scoring";
import { MatchDetail } from "./MatchList";

interface Props {
  matches: MatchResult[];
  open: string | null;
  onOpen: (id: string | null) => void;
  compareId?: string | null;
  onCompare?: (id: string | null) => void;
}

const RR = 30;
const CIRC = 2 * Math.PI * RR;

function Ring({ value }: { value: number }) {
  return (
    <svg viewBox="0 0 80 80" className="ring" aria-hidden="true">
      <circle cx="40" cy="40" r={RR} className="ring-track" />
      <circle cx="40" cy="40" r={RR} className="ring-value"
        strokeDasharray={`${CIRC * value} ${CIRC}`} transform="rotate(-90 40 40)" />
      <text x="40" y="45" textAnchor="middle" className={value >= 0.995 ? "ring-text ring-text-sm" : "ring-text"}>{Math.round(value * 100)}%</text>
    </svg>
  );
}

/** 政黨契合度卡片：圓環顯示百分比；點開看逐題對照。 */
export function MatchRings({ matches, open, onOpen, compareId, onCompare }: Props) {
  const withData = matches.filter((m) => m.score !== null);
  if (!withData.length) {
    return <p className="muted">立場資料還在整理中，完成後會出現在這裡。</p>;
  }
  const opened = withData.find((m) => m.entity.id === open);
  return (
    <>
      <div className="ring-grid">
        {withData.map((m) => {
          const low = m.compared / Math.max(m.total, 1) < LOW_COVERAGE;
          const isOpen = open === m.entity.id;
          return (
            <div key={m.entity.id} className={`ring-card ${isOpen ? "ring-card-open" : ""}`}>
              <button className="ring-main" onClick={() => onOpen(isOpen ? null : m.entity.id)} aria-expanded={isOpen}
                aria-label={`${m.entity.name} 契合度 ${Math.round(m.score! * 100)}%，比對 ${m.compared}/${m.total} 題`}>
                <Ring value={m.score!} />
                <span className="ring-name">{m.entity.short ?? m.entity.name}</span>
                <span className="muted small">比對 {m.compared}/{m.total} 題</span>
                {low && <span className="tag">資料偏少</span>}
              </button>
              {onCompare && (
                <button className="link small" onClick={() => onCompare(compareId === m.entity.id ? null : m.entity.id)}>
                  {compareId === m.entity.id ? "取消對照" : "在圖上對照"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {opened && (
        <div className="ring-detail">
          <h4>{opened.entity.name}：逐題對照</h4>
          <MatchDetail m={opened} />
        </div>
      )}
    </>
  );
}
