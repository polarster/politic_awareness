import { useEffect } from "react";
import { getUsagePercent } from "../lib/api";

const POLL_MS = 10_000;

/** 定期更新全站 5 小時用量百分比；分頁在背景時暫停。 */
export function useUsagePolling(onPercent: (p: number) => void) {
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const p = await getUsagePercent();
        if (!stopped) onPercent(p);
      } catch { /* 後端無法連線時保留舊值 */ }
    };
    void tick();
    const id = window.setInterval(tick, POLL_MS);
    const onVis = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [onPercent]);
}

export function UsageMeter({ percent }: { percent: number | null }) {
  if (percent === null) return null;
  const full = percent >= 100;
  return (
    <div className={`usage ${full ? "usage-full" : ""}`}>
      <div className="usage-label small">
        <span>目前 5 小時全站用量</span>
        <span>{percent}%</span>
      </div>
      <div className="usage-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
        aria-label="目前 5 小時全站用量">
        <div style={{ width: `${percent}%` }} />
      </div>
      {full && <p className="small">用量已達上限，請稍後再來。</p>}
    </div>
  );
}
