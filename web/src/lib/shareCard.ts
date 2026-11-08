/**
 * 分享圖卡：在瀏覽器裡把結果畫成 PNG（先組 SVG，再畫到 canvas）。不經過伺服器。
 * 圖卡一律用淺色底，貼到社群上比較一致。
 */
import type { AxisScore } from "./scoring";

export interface CardParty {
  id: string;
  label: string;
  color?: string;
  badge?: string;
  logo?: string;
  scores: AxisScore[];
}

export interface CardInput {
  sections: { title: string; you: AxisScore[]; first?: AxisScore[] | null; parties: CardParty[] }[];
  top?: { label: string; color?: string; badge?: string; logo?: string; percent: number }[] | null;
  topTitle?: string;
  journeyNote?: string | null;
}

const W = 1080;
const PAD = 64;
const FONT = `system-ui, -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
const C = { bg: "#f6f5f1", card: "#ffffff", text: "#1d1d1f", muted: "#6b6b70", line: "#e2e0da", track: "#d9d6ce" };

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const logoCache = new Map<string, string>();

/** 黨徽轉成 data URI（SVG 畫進 canvas 時不能載入外部圖檔） */
async function logoData(path: string): Promise<string | null> {
  if (logoCache.has(path)) return logoCache.get(path)!;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}${path}`);
    if (!res.ok) return null;
    const blob = await res.blob();
    const uri = await new Promise<string>((ok, bad) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.onerror = bad;
      r.readAsDataURL(blob);
    });
    logoCache.set(path, uri);
    return uri;
  } catch {
    return null;
  }
}

function badge(x: number, y: number, r: number, p: { label: string; color?: string; badge?: string }, logo: string | null) {
  const ring = `<circle cx="${x}" cy="${y}" r="${r + 3}" fill="${C.card}"/>`;
  if (logo) {
    return `${ring}<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" stroke="${p.color ?? C.muted}" stroke-width="2"/>`
      + `<image href="${logo}" x="${x - r + 3}" y="${y - r + 3}" width="${2 * r - 6}" height="${2 * r - 6}"/>`;
  }
  return `${ring}<circle cx="${x}" cy="${y}" r="${r}" fill="${p.color ?? C.muted}"/>`
    + `<text x="${x}" y="${y + r * 0.38}" text-anchor="middle" font-size="${r * 1.05}" font-weight="700" fill="#fff">${esc(p.badge ?? p.label.slice(0, 1))}</text>`;
}

export async function buildCardSvg(input: CardInput): Promise<{ svg: string; height: number }> {
  const logos = new Map<string, string | null>();
  const all = [...input.sections.flatMap((s) => s.parties), ...(input.top ?? [])];
  await Promise.all(all.filter((p) => p.logo).map(async (p) => logos.set(p.logo!, await logoData(p.logo!))));
  const logoOf = (p: { logo?: string }) => (p.logo ? logos.get(p.logo) ?? null : null);

  const parts: string[] = [];
  let y = PAD;
  parts.push(`<text x="${PAD}" y="${y + 52}" font-size="56" font-weight="800" fill="${C.text}">我的政治光譜</text>`);
  y += 84;
  parts.push(`<text x="${PAD}" y="${y + 26}" font-size="26" fill="${C.muted}">每條軸的兩端都是一種價值取向，沒有好壞之分</text>`);
  y += 60;

  const x0 = PAD + 20;
  const x1 = W - PAD - 20;
  const px = (v: number) => x0 + ((v + 2) / 4) * (x1 - x0);

  for (const sec of input.sections) {
    const rows = sec.you.filter((s) => s.value !== null);
    if (!rows.length) continue;
    y += 20;
    parts.push(`<text x="${PAD}" y="${y + 36}" font-size="36" font-weight="800" fill="${C.text}">${esc(sec.title)}</text>`);
    y += 64;
    for (const s of rows) {
      const ty = y + 92; // 軌道的 y
      // 黨徽太近時往下錯開成好幾排，用細線連回軌道上的位置
      const R = 20;
      const placed = sec.parties
        .map((p) => ({ p, v: p.scores.find((x) => x.axis.id === s.axis.id)?.value }))
        .filter((d): d is { p: CardParty; v: number } => d.v != null)
        .sort((a, b) => a.v - b.v);
      const lanes: number[] = [];
      const laid = placed.map((d) => {
        const x = px(d.v);
        let lane = lanes.findIndex((right) => x - R >= right + 4);
        if (lane === -1) { lane = lanes.length; lanes.push(0); }
        lanes[lane] = x + R;
        return { ...d, x, lane };
      });
      const extra = Math.max(0, lanes.length - 1) * 46;
      parts.push(`<text x="${PAD}" y="${y + 30}" font-size="30" font-weight="700" fill="${C.text}">${esc(s.axis.name)}</text>`);
      parts.push(`<text x="${PAD}" y="${ty + 62 + extra}" font-size="24" fill="${C.muted}">${esc(s.axis.negative_pole)}</text>`);
      parts.push(`<text x="${W - PAD}" y="${ty + 62 + extra}" font-size="24" text-anchor="end" fill="${C.muted}">${esc(s.axis.positive_pole)}</text>`);
      parts.push(`<rect x="${x0}" y="${ty - 5}" width="${x1 - x0}" height="10" rx="5" fill="${C.track}"/>`);
      parts.push(`<rect x="${px(0) - 1.5}" y="${ty - 16}" width="3" height="32" fill="${C.muted}"/>`);
      for (const d of laid.filter((d) => d.lane > 0)) {
        parts.push(`<line x1="${d.x}" y1="${ty}" x2="${d.x}" y2="${ty + d.lane * 46}" stroke="${d.p.color ?? C.muted}" stroke-width="2"/>`);
      }
      for (const d of [...laid].sort((a, b) => b.lane - a.lane)) {
        parts.push(badge(d.x, ty + d.lane * 46, R, d.p, logoOf(d.p)));
      }
      const f = sec.first?.find((x) => x.axis.id === s.axis.id)?.value;
      if (f != null && Math.abs(f - s.value!) > 0.005) {
        parts.push(`<line x1="${px(f)}" y1="${ty}" x2="${px(s.value!)}" y2="${ty}" stroke="${C.text}" stroke-width="3" stroke-dasharray="6 5"/>`);
        parts.push(`<circle cx="${px(f)}" cy="${ty}" r="15" fill="${C.card}" stroke="${C.text}" stroke-width="3" stroke-dasharray="5 4"/>`);
      }
      const yx = Math.min(Math.max(px(s.value!), x0 + 20), x1 - 20);
      parts.push(`<circle cx="${px(s.value!)}" cy="${ty}" r="19" fill="${C.text}" stroke="${C.card}" stroke-width="4"/>`);
      parts.push(`<text x="${yx}" y="${ty - 30}" text-anchor="middle" font-size="26" font-weight="800" fill="${C.text}">你</text>`);
      y += 182 + extra;
    }
  }

  if (input.journeyNote) {
    parts.push(`<circle cx="${PAD + 15}" cy="${y + 14}" r="12" fill="${C.card}" stroke="${C.text}" stroke-width="3" stroke-dasharray="5 4"/>`);
    parts.push(`<text x="${PAD + 40}" y="${y + 23}" font-size="24" fill="${C.muted}">${esc(input.journeyNote)}</text>`);
    y += 56;
  }

  if (input.top?.length) {
    y += 20;
    parts.push(`<text x="${PAD}" y="${y + 36}" font-size="36" font-weight="800" fill="${C.text}">${esc(input.topTitle ?? "最契合的政黨")}</text>`);
    y += 70;
    input.top.forEach((t, i) => {
      const cy = y + 30;
      parts.push(`<text x="${PAD}" y="${cy + 12}" font-size="32" font-weight="800" fill="${C.muted}">${i + 1}</text>`);
      parts.push(badge(PAD + 70, cy, 26, t, logoOf(t)));
      parts.push(`<text x="${PAD + 116}" y="${cy + 11}" font-size="32" font-weight="700" fill="${C.text}">${esc(t.label)}</text>`);
      parts.push(`<text x="${W - PAD}" y="${cy + 11}" font-size="32" font-weight="700" text-anchor="end" fill="${C.text}">${t.percent}%</text>`);
      y += 76;
    });
  }

  y += 30;
  parts.push(`<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="${C.line}" stroke-width="2"/>`);
  y += 48;
  parts.push(`<text x="${PAD}" y="${y}" font-size="26" font-weight="700" fill="${C.text}">政治光譜自我探索</text>`);
  parts.push(`<text x="${W - PAD}" y="${y}" font-size="22" text-anchor="end" fill="${C.muted}">結果只反映問卷作答，不是投票建議</text>`);
  const height = y + PAD - 10;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family='${FONT}'>`
    + `<rect width="${W}" height="${height}" fill="${C.bg}"/>`
    + `<rect x="24" y="24" width="${W - 48}" height="${height - 48}" rx="32" fill="${C.card}"/>`
    + parts.join("") + `</svg>`;
  return { svg, height };
}

export async function svgToPng(svg: string, width: number, height: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
    return await new Promise<Blob>((ok, bad) => canvas.toBlob((b) => (b ? ok(b) : bad(new Error("無法產生圖片"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const CARD_WIDTH = W;
