import { useState } from "react";
import { pc } from "./Spectrum";

export interface BadgeInfo {
  name: string;
  color?: string;
  badge?: string;
  logo?: string;
}

/** 黨徽圓章：有黨徽圖檔用圖，沒有就用代表色加一個字。滑鼠移上去或點一下會浮出黨名。 */
export function PartyBadge({ info, detail, highlight = false, size = 22, style, align = "center" }: {
  info: BadgeInfo;
  detail?: string;
  highlight?: boolean;
  size?: number;
  style?: React.CSSProperties;
  /** 浮動文字對齊：靠左右邊緣時改成往內展開，避免被切掉 */
  align?: "start" | "center" | "end";
}) {
  const [tip, setTip] = useState(false);
  const label = detail ? `${info.name}：${detail}` : info.name;
  return (
    <button
      type="button"
      className={`badge ${highlight ? "badge-hl" : ""}`}
      style={{ width: size, height: size, ...pc(info.color), ...style }}
      aria-label={label}
      onMouseEnter={() => setTip(true)}
      onMouseLeave={() => setTip(false)}
      onFocus={() => setTip(true)}
      onBlur={() => setTip(false)}
      onClick={() => setTip((t) => !t)}
    >
      {info.logo
        ? <img src={`${import.meta.env.BASE_URL}${info.logo}`} alt="" />
        : <span style={{ fontSize: size * 0.55 }}>{info.badge ?? info.name.slice(0, 1)}</span>}
      {tip && <span className={`badge-tip badge-tip-${align}`} role="tooltip">{label}</span>}
    </button>
  );
}
