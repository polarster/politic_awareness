/**
 * 從 #/votes/<id> 取出要聚焦的精選表決 id。
 * 網址可能被亂改或被別人貼出來：百分比編碼不合法時不丟例外，
 * 不在 ids 裡的字串（包括 constructor、__proto__ 這類名稱）一律當成找不到，回傳 undefined。
 */
export function parseVoteFocus(hash: string, ids: ReadonlySet<string>): string | undefined {
  const raw = hash.split("/")[2];
  if (!raw) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return ids.has(id) ? id : undefined;
}
