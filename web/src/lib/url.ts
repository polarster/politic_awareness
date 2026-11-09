/**
 * 資料裡的外部連結只放行 http(s)。
 * javascript:、data:、相對路徑或無法解析的字串一律回傳 undefined，呼叫端就不輸出連結。
 * 回傳的是解析後的網址，檢查的和瀏覽器實際開啟的是同一個。
 */
export function safeHref(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}
