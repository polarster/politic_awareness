const env = import.meta.env;

export const API_BASE: string = env.VITE_API_BASE ?? "";

const FORM_URL: string = env.VITE_FEEDBACK_FORM_URL ?? "";
const ENTRY_TARGET: string = env.VITE_FEEDBACK_ENTRY_TARGET ?? "";
const ENTRY_KIND: string = env.VITE_FEEDBACK_ENTRY_KIND ?? "";

export type FeedbackKind = "立場標錯" | "題目措辭偏頗" | "一般意見";

/** 建立預先填好欄位的 Google Form 連結；未設定時回傳 null。 */
export function feedbackUrl(kind: FeedbackKind, target?: string): string | null {
  if (!FORM_URL) return null;
  const u = new URL(FORM_URL);
  u.searchParams.set("usp", "pp_url");
  if (ENTRY_KIND) u.searchParams.set(`entry.${ENTRY_KIND}`, kind);
  if (ENTRY_TARGET && target) u.searchParams.set(`entry.${ENTRY_TARGET}`, target);
  return u.toString();
}
