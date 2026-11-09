import type { ApiMessage, ContentBlock } from "./api";
import type { Discussion } from "./types";

// 對答流程中和畫面無關的部分：工具結果怎麼送回、使用者文字怎麼接在對話後面

export type ToolUse = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export interface Decision {
  label: string;
  result: string;
  /** 系統擋下的不合法工具呼叫（不需要使用者操作就會產生） */
  isError?: boolean;
}

export type Decisions = Record<string, Decision>;

/** 第一則訊息前面會附上作答摘要，使用者自己輸入的文字接在這個標記之後 */
export const USER_TEXT_MARKER = "【使用者訊息】\n";

/** 第一則訊息裡標記討論主題 id 的前綴（api/prompt.py 的 system prompt 寫明它對應討論主題的 id） */
export const TOPIC_MARKER = "【討論主題】";

/** 對話的第一則訊息：作答摘要、討論主題（有的話），最後是使用者自己輸入的文字 */
export function firstMessage(summary: string, text: string, topic: string | null): string {
  return summary + (topic ? `\n\n${TOPIC_MARKER}${topic}` : "") + `\n\n${USER_TEXT_MARKER}${text}`;
}

/**
 * 第一則訊息的文字屬於哪個討論主題：以某個主題的開場白開頭就是那個主題（符合好幾個時取開場白最長的），否則為 null。
 * 主題按鈕送出的就是開場白；送出失敗、開場白放回輸入框之後再送（原樣或在後面補充），也要附上同一個主題，
 * 不然 Claude 不知道要照哪個主題的引導。改寫開頭或換成別的內容，就當成使用者自己的話，不附主題。
 * 按鈕上只顯示主題名稱，自己打的字幾乎不會剛好以開場白開頭；真的照著開場白打，當成同一個主題也沒有問題
 */
export function topicOf(text: string, discussions: readonly Pick<Discussion, "id" | "opening">[]): string | null {
  const t = text.trim();
  let hit: { id: string; len: number } | null = null;
  for (const d of discussions) {
    const opening = d.opening.trim();
    if (opening && t.startsWith(opening) && (!hit || opening.length > hit.len)) hit = { id: d.id, len: opening.length };
  }
  return hit?.id ?? null;
}

/** 模型的工具呼叫全部不合法時，每次使用者操作之後最多自動回送幾次 */
export const MAX_AUTO_RESENDS = 1;

const NO_DECISION: Decision = { label: "", result: "使用者沒有回應這項建議。" };

export function isToolUse(b: ContentBlock): b is ToolUse {
  return b.type === "tool_use";
}

export function toolUses(m: ApiMessage | undefined): ToolUse[] {
  if (!m || m.role !== "assistant" || typeof m.content === "string") return [];
  return m.content.filter(isToolUse);
}

export function toolResults(uses: ToolUse[], decisions: Decisions): ContentBlock[] {
  return uses.map((t) => {
    const d = decisions[t.id] ?? NO_DECISION;
    return { type: "tool_result", tool_use_id: t.id, content: d.result, ...(d.isError ? { is_error: true } : {}) };
  });
}

export type ToolStep =
  | { kind: "wait" }
  | { kind: "send"; message: ApiMessage; autoResends: number }
  | { kind: "hold" };

/**
 * 最後一則 assistant 訊息的工具呼叫都有結果之後，決定下一步：
 * - wait：沒有工具呼叫，或還有建議等使用者回應
 * - send：把所有結果放在同一則 user 訊息送回；autoResends 是送出後的自動回送次數
 * - hold：結果全是系統擋下的錯誤（不需要使用者操作就會送出），而且這次使用者操作後已經自動回送過。
 *   先停下來，等使用者下一則訊息時一起送（見 withUserText），避免模型一直出錯時自動連發 /api/chat
 */
export function nextToolStep(last: ApiMessage | undefined, decisions: Decisions, autoResends: number): ToolStep {
  const uses = toolUses(last);
  if (!uses.length || !uses.every((t) => decisions[t.id])) return { kind: "wait" };
  const automatic = uses.every((t) => decisions[t.id].isError);
  if (automatic && autoResends >= MAX_AUTO_RESENDS) return { kind: "hold" };
  return {
    kind: "send",
    message: { role: "user", content: toolResults(uses, decisions) },
    // 有使用者做的決定，就算是使用者操作，重新計算
    autoResends: automatic ? autoResends + 1 : 0,
  };
}

/** user 訊息裡使用者自己輸入的文字；只有工具結果時回傳 null */
export function userText(m: ApiMessage): string | null {
  if (m.role !== "user") return null;
  if (typeof m.content === "string") {
    const idx = m.content.indexOf(USER_TEXT_MARKER);
    return idx >= 0 ? m.content.slice(idx + USER_TEXT_MARKER.length) : m.content;
  }
  const texts = m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text);
  return texts.length ? texts.join("\n\n") : null;
}

/** 撤回使用者文字後剩下的訊息：還有工具結果就保留，否則回傳 null（整則撤回） */
export function withoutUserText(m: ApiMessage): ApiMessage | null {
  if (typeof m.content === "string") return null;
  const rest = m.content.filter((b) => b.type !== "text");
  return rest.length ? { role: m.role, content: rest } : null;
}

function appendText(m: ApiMessage, text: string): ApiMessage {
  if (typeof m.content === "string") return { role: "user", content: `${m.content}\n\n${text}` };
  const prev = userText(m);
  const rest = m.content.filter((b) => b.type !== "text");
  return { role: "user", content: [...rest, { type: "text", text: prev ? `${prev}\n\n${text}` : text }] };
}

/**
 * 使用者送出文字時，組出要送的完整對話，確保 user／assistant 一定交替：
 * - 上一則 assistant 的工具結果還沒送出（hold）：結果和文字合併成一則 [...tool_result, text]
 * - 上一則 user 訊息沒有成功送出（例如連線失敗）：把文字併進那一則，不要變成連續兩則 user 訊息（後端會回 400）。
 *   畫面上只有那一則只有工具結果時才能打字（已經有文字時要先重試），所以文字一律只有一段輸入
 * - 其他：新增一則文字訊息
 */
export function withUserText(messages: ApiMessage[], content: string, decisions: Decisions): ApiMessage[] {
  const last = messages[messages.length - 1];
  const uses = toolUses(last);
  if (uses.length) {
    return [...messages, { role: "user", content: [...toolResults(uses, decisions), { type: "text", text: content }] }];
  }
  if (last?.role === "user") return [...messages.slice(0, -1), appendText(last, content)];
  return [...messages, { role: "user", content }];
}
