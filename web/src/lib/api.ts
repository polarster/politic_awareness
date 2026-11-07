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
  constructor(public status: number, message: string) {
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
    let msg = `伺服器錯誤（${res.status}）`;
    try {
      const j = await res.json();
      if (typeof j.detail === "string") msg = j.detail;
    } catch { /* ignore */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export function postChat(messages: ApiMessage[]): Promise<ChatResponse> {
  return post<ChatResponse>("/api/chat", { messages });
}

export interface LogRecord {
  quiz_version: string;
  city: string | null;
  answers: Answers;
  budget: BudgetSteps | null;
  adjustments: { type: string; question: string; from?: number | null; to: number | boolean | null }[];
}

export function postLog(rec: LogRecord): Promise<{ ok: boolean }> {
  return post("/api/log", rec);
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
