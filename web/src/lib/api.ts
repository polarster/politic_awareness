import { API_BASE } from "../config";
import type { Adjustment, Answers, BudgetSteps } from "./types";

// Anthropic Messages API 的訊息格式（前端只負責保存並原樣送回）
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: string; [k: string]: unknown };

export interface ApiMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ChatResponse {
  content: ContentBlock[];
  stop_reason: string | null;
  usage_percent: number;
}

export class ApiError extends Error {
  /** detail：伺服器回的 JSON detail 原文（不是字串或讀不到時為 null），用來判斷錯誤類型 */
  constructor(public status: number, message: string, public detail: string | null = null) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail: string | null = null;
    try {
      const j = await res.json();
      if (typeof j.detail === "string") detail = j.detail;
    } catch { /* ignore */ }
    throw new ApiError(res.status, detail ?? `伺服器錯誤（${res.status}）`, detail);
  }
  return res.json() as Promise<T>;
}

/** 隨機的 UUID v4。crypto.randomUUID 只在 HTTPS 或 localhost 可用，其他情況用 getRandomValues 組出來。 */
export function newId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// 每段對話一個隨機 id（同一段對話的第一則訊息是同一個物件），只當作 metadata 傳給 Anthropic，
// 讓濫用能歸到單一對話；不含任何個人資訊，也不存檔
const conversationIds = new WeakMap<ApiMessage, string>();

export function conversationIdFor(messages: ApiMessage[]): string | undefined {
  const first = messages[0];
  if (!first) return undefined;
  let id = conversationIds.get(first);
  if (!id) {
    id = newId();
    conversationIds.set(first, id);
  }
  return id;
}

export function postChat(messages: ApiMessage[]): Promise<ChatResponse> {
  return post<ChatResponse>("/api/chat", { messages, conversation_id: conversationIdFor(messages) });
}

export interface LogRecord {
  /** 每一輪作答隨機產生的 UUID：重送同一輪時，伺服器會覆蓋同一筆而不是多存一筆 */
  submission_id: string;
  quiz_version: string;
  city: string | null;
  answers: Answers;
  budget: BudgetSteps | null;
  adjustments: { type: string; question: string; from?: number | null; to: number | boolean | null }[];
  mode: "simple" | "full";
  /** 完整版：每題第一次的選擇 */
  first_answers: Answers | null;
  /** 思辨旅程是否在看過結果之後才進行 */
  journey_after_results: boolean | null;
}

export function postLog(rec: LogRecord): Promise<{ ok: boolean }> {
  return post("/api/log", rec);
}

const UPLOAD_KEY = "politic-awareness-upload";

/** 匿名上傳的狀態，只存在這個分頁（sessionStorage），伺服器不會回傳 */
export interface UploadState {
  /** 這一輪作答的指紋（題庫版本＋第一直覺的答案）；重新作答後通常會不同 */
  round: string;
  /** 這一輪的 submission_id */
  id: string;
  /** 上次成功送出的內容指紋；null 表示還沒送出過 */
  sent: string | null;
}

/** 取得這一輪作答的上傳狀態；換了一輪（或還沒有）就產生新的 submission_id。 */
export function loadUploadState(round: string): UploadState {
  try {
    const raw = sessionStorage.getItem(UPLOAD_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<UploadState>;
      if (s.round === round && typeof s.id === "string" && UUID4.test(s.id)) {
        return { round, id: s.id, sent: typeof s.sent === "string" ? s.sent : null };
      }
    }
  } catch { /* ignore */ }
  const fresh: UploadState = { round, id: newId(), sent: null };
  saveUploadState(fresh);
  return fresh;
}

export function saveUploadState(s: UploadState): void {
  try { sessionStorage.setItem(UPLOAD_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

/** 內容指紋（cyrb53），只用來判斷「送出之後內容有沒有變」，不是安全用途。 */
export function fingerprint(value: unknown): string {
  const str = JSON.stringify(value) ?? "";
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function toLogAdjustments(adj: Adjustment[]): LogRecord["adjustments"] {
  // 只記結構化資料，不記理由文字
  return adj.map((a) =>
    a.type === "answer_change"
      ? { type: a.type, question: a.question, from: a.from, to: a.to }
      : { type: a.type, question: a.question, to: a.to },
  );
}

export async function getUsagePercent(): Promise<number> {
  const res = await fetch(`${API_BASE}/api/usage`);
  if (!res.ok) throw new ApiError(res.status, "無法取得用量");
  const j = (await res.json()) as { percent: number };
  return j.percent;
}
