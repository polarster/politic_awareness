import { useEffect, useState } from "react";
import type { AxisScore, MatchResult } from "../lib/scoring";
import { buildCardSvg, CARD_WIDTH, svgToPng, type CardParty } from "../lib/shareCard";

interface Props {
  nat: AxisScore[];
  mun: AxisScore[];
  natFirst: AxisScore[] | null;
  munFirst: AxisScore[] | null;
  /** 完成思辨旅程時才有第一直覺可以放 */
  journeyDone: boolean;
  changedCount: number;
  natParties: CardParty[];
  munParties: CardParty[];
  natMatch: MatchResult[];
  cityName: string | null;
}

interface Options {
  national: boolean;
  municipal: boolean;
  first: boolean;
  parties: boolean;
  top: boolean;
}

/** 分享圖卡：先讓使用者勾選要放哪些內容（預設只放全國光譜），在瀏覽器產生 PNG。 */
export function ShareCard(p: Props) {
  const [opt, setOpt] = useState<Options>({ national: true, municipal: false, first: false, parties: false, top: false });
  const [png, setPng] = useState<{ blob: Blob; url: string } | null>(null);
  const [status, setStatus] = useState<"idle" | "busy" | "error">("idle");
  const hasMun = p.mun.some((s) => s.value !== null);
  const nothing = !opt.national && !(opt.municipal && hasMun) && !opt.top;

  useEffect(() => {
    if (nothing) { setPng(null); return; }
    let cancelled = false;
    let made: string | null = null;
    setStatus("busy");
    (async () => {
      try {
        const sections = [];
        if (opt.national) sections.push({ title: "全國議題", you: p.nat, first: opt.first ? p.natFirst : null, parties: opt.parties ? p.natParties : [] });
        if (opt.municipal && hasMun) sections.push({ title: `${p.cityName ?? "雙北"}市政`, you: p.mun, first: opt.first ? p.munFirst : null, parties: opt.parties ? p.munParties : [] });
        const top = opt.top
          ? p.natMatch.filter((m) => m.score !== null).sort((a, b) => b.score! - a.score!).slice(0, 3).map((m) => ({
            label: m.entity.short ?? m.entity.name, color: m.entity.color, badge: m.entity.badge, logo: m.entity.logo,
            percent: Math.round(m.score! * 100),
          }))
          : null;
        const { svg, height } = await buildCardSvg({
          sections, top, topTitle: "最契合的政黨（全國議題）",
          journeyNote: opt.first && p.journeyDone
            ? `虛線圓是第一直覺，實心點是看過不同意見之後（改變了 ${p.changedCount} 題）`
            : null,
        });
        const blob = await svgToPng(svg, CARD_WIDTH, height);
        if (cancelled) return;
        made = URL.createObjectURL(blob);
        setPng((old) => { if (old) URL.revokeObjectURL(old.url); return { blob, url: made! }; });
        setStatus("idle");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opt, p.nat, p.mun, p.natFirst, p.munFirst, p.natMatch]);

  const file = () => new File([png!.blob], "政治光譜.png", { type: "image/png" });
  const canShareFile = typeof navigator !== "undefined" && !!navigator.canShare && !!png && navigator.canShare({ files: [file()] });

  const share = async () => {
    try {
      await navigator.share({ files: [file()], title: "我的政治光譜" });
    } catch { /* 使用者取消 */ }
  };

  const toggle = (k: keyof Options) => setOpt((o) => ({ ...o, [k]: !o[k] }));
  const box = (k: keyof Options, label: string, hint?: string, disabled = false) => (
    <label className={`share-opt ${disabled ? "muted" : ""}`}>
      <input type="checkbox" checked={opt[k] && !disabled} disabled={disabled} onChange={() => toggle(k)} />
      <span>{label}{hint && <span className="muted small">　{hint}</span>}</span>
    </label>
  );

  return (
    <section className="card">
      <span className="eyebrow">分享</span>
      <h2>做成圖卡分享</h2>
      <p className="muted small">
        政治傾向是個人的事，請自己決定要公開多少。圖片只在你的瀏覽器裡產生，不會上傳。
      </p>
      <div className="share-opts">
        {box("national", "全國議題光譜")}
        {box("municipal", "市政光譜", hasMun ? undefined : "（沒有足夠的作答）", !hasMun)}
        {box("first", "第一直覺的位置", p.journeyDone ? "思辨旅程前後的差別" : "（完成思辨旅程後才有）", !p.journeyDone)}
        {box("parties", "光譜上的政黨位置")}
        {box("top", "最契合的前三個政黨")}
      </div>
      {nothing ? (
        <p className="muted small">請至少勾選一項。</p>
      ) : status === "error" ? (
        <p className="error">圖片產生失敗，請換個瀏覽器再試。</p>
      ) : png ? (
        <>
          <img className="share-preview" src={png.url} alt="分享圖卡預覽" />
          <div className="row">
            {canShareFile && <button onClick={share}>分享</button>}
            <a className={canShareFile ? "button-link secondary" : "button-link"} href={png.url} download="政治光譜.png">下載圖片</a>
          </div>
        </>
      ) : (
        <p className="muted small">產生中…</p>
      )}
    </section>
  );
}
