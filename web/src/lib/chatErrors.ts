import { ApiError, type ApiMessage } from "./api";
import { userText, withoutUserText } from "./chatFlow";

// /api/chat 失敗時要怎麼復原。依狀態碼加上後端（api/app.py）實際回的 detail 文字判斷，
// 後端改了訊息文字時，chatErrors.test.ts 會比對 app.py 的原文而失敗，提醒這裡一起更新

/**
 * - retry：暫時性的錯誤（連線失敗、5xx、使用的人比較多、上一則還在處理中、請求太頻繁），保留「重試」
 * - restart：這段對話已經不能再繼續（格式錯誤、對話太長、輪數已達上限），要「重新開始對話」
 * - rephrase：Claude 無法回應這則訊息，或這一則太長，撤回文字放回輸入框讓使用者改寫
 * - later：用量額度用完、對答功能暫停，請使用者稍後再來，不提供會立刻再送一次的按鈕
 * - reload：題庫已經更新（或登入已過期），要重新整理頁面
 */
export type ChatErrorKind = "retry" | "restart" | "rephrase" | "later" | "reload";

export interface ChatError {
  kind: ChatErrorKind;
  /** 顯示給使用者的說明 */
  message: string;
}

/** 題庫版本和伺服器不一致（後端的原文：「題庫已經更新，…請重新整理頁面…」） */
const STALE_QUIZ = /題庫已經?更新|重新整理頁面/;

/**
 * 依狀態碼與 detail 分類。status 為 null 表示沒有收到回應（連線失敗）；
 * detail 是伺服器回的 JSON detail 原文，沒有時為 null。
 */
export function classifyChatError(status: number | null, detail: string | null): ChatError {
  if (status === null) return { kind: "retry", message: "連線失敗，請檢查網路連線後再試一次。" };
  const d = detail ?? "";
  if (status >= 400 && status < 500 && STALE_QUIZ.test(d)) {
    return { kind: "reload", message: "題目資料已更新，請重新整理頁面。" };
  }
  // 對外模式的登入閘道（auth-plugin.ts）：登入過期時 /api 回 401「請先登入」
  if (status === 401) return { kind: "reload", message: "登入已過期，請重新整理頁面後再登入。" };
  const message = detail || `伺服器錯誤（${status}）`;
  // 409：Claude 拒絕回應，「請換個方式說說看」
  if (status === 409) return { kind: "rephrase", message };
  // 413 有兩種：「這則訊息太長了，請縮短一點再送出。」可以改寫；「這段對話太長了，請重新開始一段對話。」不行
  if (status === 413 && d.includes("這則訊息太長")) return { kind: "rephrase", message };
  if (status === 400 || status === 413 || status === 422) {
    return { kind: "restart", message: detail || "這段對話無法繼續，請重新開始一段對話。" };
  }
  if (status === 429) {
    // 「這段對話已達…上限，請重新開始一段對話。」
    if (d.includes("重新開始")) return { kind: "restart", message };
    // 「Claude 對答的用量已達這 5 小時的上限，請稍後再來。」「你在這 5 小時內的對答用量已達上限，請稍後再來。」
    if (d.includes("用量已達")) return { kind: "later", message };
  }
  // 帳號暫停等：「對答功能暫時休息中，請稍後再來。」立刻重試也沒用
  if (status === 503 && d.includes("暫時休息")) return { kind: "later", message };
  // 其他（「目前使用的人比較多」「上一則訊息還在處理中」「請求太頻繁」、5xx 等）都是暫時的
  return { kind: "retry", message };
}

/** postChat 丟出的例外：ApiError 用狀態碼與 detail 分類，其他（fetch 失敗、回應不是 JSON）當成連線失敗 */
export function chatErrorOf(e: unknown): ChatError {
  return e instanceof ApiError ? classifyChatError(e.status, e.detail) : classifyChatError(null, null);
}

export interface Recovery {
  /** 失敗之後畫面上的對話 */
  messages: ApiMessage[];
  /** 撤回後要放回輸入框的使用者文字；沒有撤回時為 null */
  restoredText: string | null;
  error: ChatError;
}

/**
 * 送出 next 失敗之後，對話要怎麼處理：
 * - rephrase、later：撤回使用者這段文字、放回輸入框（同一則裡的工具結果留著，之後和下一段文字合併成一則送出）。
 *   不留下送不出去的文字，輸入框就不會因此鎖住，使用者可以改寫或之後再送
 * - rephrase 但沒有文字可以撤回（只有工具結果）：改成 retry，保留「重試」
 * - 其他：對話原樣保留，畫面依類型顯示「重試」「重新開始對話」或「重新整理頁面」
 * 第一則訊息之外的撤回不會換掉第一則訊息物件，conversation_id 不變。
 * 第一則被撤回時只放回使用者的文字（主題按鈕送出的是開場白），再送出時 topicOf 會附回同一個討論主題
 */
export function recoverFromError(next: ApiMessage[], error: ChatError): Recovery {
  const last = next[next.length - 1];
  const typed = last ? userText(last) : null;
  if ((error.kind === "rephrase" || error.kind === "later") && last && typed !== null) {
    const rest = withoutUserText(last);
    return {
      messages: rest ? [...next.slice(0, -1), rest] : next.slice(0, -1),
      restoredText: typed,
      error: { ...error, message: `${error.message}剛才的訊息已放回輸入框。` },
    };
  }
  if (error.kind === "rephrase") return { messages: next, restoredText: null, error: { ...error, kind: "retry" } };
  return { messages: next, restoredText: null, error };
}

// 以下是錯誤在畫面上的處理（Chat.tsx 照這些函式顯示按鈕、鎖住輸入框、放回文字），抽出來才能用單元測試保護

/** 錯誤訊息旁邊的按鈕 */
export type ErrorAction = "retry" | "restart" | "reload";

export const ACTION_LABELS: Record<ErrorAction, string> = {
  retry: "重試",
  restart: "重新開始對話",
  reload: "重新整理頁面",
};

/**
 * 錯誤訊息旁邊要顯示哪個按鈕，沒有按鈕時為 null：
 * - retry：把畫面上的對話原樣再送一次，所以最後一則必須是還沒得到回覆的 user 訊息
 * - restart、reload：重新開始對話、重新整理頁面
 * - later、rephrase：不提供會立刻再送一次的按鈕（文字已經放回輸入框，稍後或改寫後由使用者自己送出）
 */
export function errorAction(error: ChatError | null, last: ApiMessage | undefined): ErrorAction | null {
  switch (error?.kind) {
    case "retry":
      return last?.role === "user" ? "retry" : null;
    case "restart":
      return "restart";
    case "reload":
      return "reload";
    default:
      return null;
  }
}

/** 這段對話不能再繼續、或要重新整理頁面：要先處理錯誤，輸入框不能再打字 */
export function inputBlocked(error: ChatError | null): boolean {
  return error?.kind === "restart" || error?.kind === "reload";
}

/** 輸入框的提示文字：鎖住時說明要先做什麼 */
export function inputHint(s: { waitingForTools: boolean; unsentText: boolean; error: ChatError | null }): string {
  if (s.waitingForTools) return "請先回應上面的建議";
  if (s.error?.kind === "restart") return `請先按「${ACTION_LABELS.restart}」`;
  if (s.error?.kind === "reload") return "請先重新整理頁面";
  if (s.unsentText) return `上一則訊息還沒送出，請先按「${ACTION_LABELS.retry}」`;
  return "例如：我很在意兒童貧窮，對財團也沒有好感，這會怎麼影響我的結果？";
}

/**
 * 按「重新開始對話」之後輸入框的內容：把沒送出的那段使用者文字放回去，可以在新的對話裡再送一次。
 * 第一則只放回使用者自己打的字（不含作答摘要）；主題按鈕送出的開場白也原樣放回，再送出時會附上同一個主題（見 topicOf）。
 * 輸入框已經有字、或沒有使用者文字（只有工具結果）時維持原樣
 */
export function restartInput(messages: ApiMessage[], current: string): string {
  const last = messages[messages.length - 1];
  const typed = last ? userText(last) : null;
  return current.trim() || typed === null ? current : typed;
}
