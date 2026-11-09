import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { data } from "../data";
import { ApiError, conversationIdFor, postChat, type ApiMessage } from "./api";
import {
  ACTION_LABELS, chatErrorOf, classifyChatError, errorAction, inputBlocked, inputHint, recoverFromError, restartInput,
  type ChatError, type ChatErrorKind, type ErrorAction,
} from "./chatErrors";
import { TOPIC_MARKER, USER_TEXT_MARKER, firstMessage, topicOf, userText } from "./chatFlow";

// 後端實際回的 detail（api/app.py；f-string 的部分以預設值 MAX_USER_TURNS=20、5 小時代入，src 是原始碼裡的寫法）
const CASES: { status: number; detail: string; kind: ChatErrorKind; src?: string }[] = [
  // 對話已經不能再繼續：重新開始對話
  { status: 400, detail: "對話格式錯誤，請重新開始一段對話。", kind: "restart" },
  { status: 400, detail: "這則訊息無法處理，請重新開始一段對話。", kind: "restart" },
  { status: 413, detail: "這段對話太長了，請重新開始一段對話。", kind: "restart" },
  { status: 422, detail: "對話格式錯誤，請重新開始一段對話。", kind: "restart" },
  { status: 429, detail: "這段對話已達上限，請重新開始一段對話。", kind: "restart" },
  {
    status: 429, detail: "這段對話已達 20 則訊息的上限，請重新開始一段對話。", kind: "restart",
    src: "這段對話已達 {MAX_USER_TURNS} 則訊息的上限，請重新開始一段對話。",
  },
  // 暫時性的錯誤：重試
  { status: 503, detail: "目前使用的人比較多，請稍後再試。", kind: "retry" },
  { status: 429, detail: "上一則訊息還在處理中，請等回覆出現後再送出。", kind: "retry" },
  { status: 429, detail: "請求太頻繁，請稍後再試。", kind: "retry" },
  { status: 502, detail: "Claude 暫時無法回應，請稍後再試。", kind: "retry" },
  { status: 502, detail: "無法連線到 Claude，請稍後再試。", kind: "retry" },
  { status: 502, detail: "Claude 沒有產生回覆，請再試一次。", kind: "retry" },
  // 用量額度用完、對答功能暫停：稍後再來
  {
    status: 429, detail: "Claude 對答的用量已達這 5 小時的上限，請稍後再來。", kind: "later",
    src: "Claude 對答的用量已達這 {WINDOW_TEXT}的上限，請稍後再來。",
  },
  {
    status: 429, detail: "你在這 5 小時內的對答用量已達上限，請稍後再來。", kind: "later",
    src: "你在這 {WINDOW_TEXT}內的對答用量已達上限，請稍後再來。",
  },
  { status: 503, detail: "對答功能暫時休息中，請稍後再來。", kind: "later" },
  // 這一則不能送：撤回文字讓使用者改寫
  { status: 409, detail: "Claude 無法回應這則訊息，請換個方式說說看。", kind: "rephrase" },
  { status: 413, detail: "這則訊息太長了，請縮短一點再送出。", kind: "rephrase" },
  // 題庫版本和伺服器不一致（後端目前只有 /api/log 會檢查，原文如下）
  { status: 400, detail: "題庫已經更新，這份作答無法送出。請重新整理頁面後再作答。", kind: "reload" },
];

describe("classifyChatError", () => {
  it.each(CASES)("$status「$detail」→ $kind", ({ status, detail, kind }) => {
    const e = classifyChatError(status, detail);
    expect(e.kind).toBe(kind);
    // 題庫版本過期改用固定說明，其他照後端的文字顯示
    expect(e.message).toBe(kind === "reload" ? "題目資料已更新，請重新整理頁面。" : detail);
  });

  it("測試用的文字都和後端原始碼一致（後端改了文字時要一起更新分類）", () => {
    const appPy = readFileSync(new URL("../../../api/app.py", import.meta.url), "utf8");
    for (const c of CASES) expect(appPy, c.detail).toContain(c.src ?? c.detail);
    // 對外模式的登入閘道：登入過期時 /api 回 401「請先登入」
    const gate = readFileSync(new URL("../../auth-plugin.ts", import.meta.url), "utf8");
    expect(gate).toContain('JSON.stringify({ detail: "請先登入" })');
  });

  it("題庫已更新不論是哪個 4xx 都要重新整理頁面", () => {
    for (const status of [400, 409, 412, 422]) {
      expect(classifyChatError(status, "題庫已經更新，請重新整理頁面。").kind, String(status)).toBe("reload");
    }
  });

  it("登入過期（401）要重新整理頁面", () => {
    expect(classifyChatError(401, "請先登入")).toEqual({ kind: "reload", message: "登入已過期，請重新整理頁面後再登入。" });
  });

  it("沒有回應（連線失敗）、沒有 detail 的 5xx 與不認得的狀態碼都可以重試", () => {
    expect(classifyChatError(null, null)).toEqual({ kind: "retry", message: "連線失敗，請檢查網路連線後再試一次。" });
    expect(classifyChatError(500, null)).toEqual({ kind: "retry", message: "伺服器錯誤（500）" });
    expect(classifyChatError(504, null).kind).toBe("retry");
    expect(classifyChatError(404, null).kind).toBe("retry");
    expect(classifyChatError(429, null).kind).toBe("retry");
  });

  it("沒有 detail 的 400／413／422 也要重新開始，並附上說明", () => {
    for (const status of [400, 413, 422]) {
      expect(classifyChatError(status, null)).toEqual({ kind: "restart", message: "這段對話無法繼續，請重新開始一段對話。" });
    }
  });

  it("chatErrorOf：ApiError 依狀態碼與 detail 分類，其他例外（fetch 失敗）當成連線失敗，不顯示英文訊息", () => {
    expect(chatErrorOf(new ApiError(429, "x", "你在這 5 小時內的對答用量已達上限，請稍後再來。")).kind).toBe("later");
    // 分類看 detail 原文，不看 message（沒有 detail 時 message 是前端自己組的「伺服器錯誤（…）」）
    expect(chatErrorOf(new ApiError(429, "請重新開始一段對話", null)).kind).toBe("retry");
    const net = chatErrorOf(new TypeError("Failed to fetch"));
    expect(net.kind).toBe("retry");
    expect(net.message).not.toMatch(/fetch/i);
    expect(chatErrorOf(new SyntaxError("Unexpected token <")).kind).toBe("retry");
  });
});

describe("postChat 的錯誤帶著 detail 原文", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("JSON detail 放進 ApiError.detail；不是 JSON 時 detail 為 null", async () => {
    const detail = "這段對話已達上限，請重新開始一段對話。";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail }), { status: 429 })));
    const e1 = await postChat([{ role: "user", content: "嗨" }]).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ApiError);
    expect(e1).toMatchObject({ status: 429, detail, message: detail });
    expect(chatErrorOf(e1).kind).toBe("restart");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })));
    const e2 = await postChat([{ role: "user", content: "嗨" }]).catch((e: unknown) => e);
    expect(e2).toMatchObject({ status: 502, detail: null, message: "伺服器錯誤（502）" });
    expect(chatErrorOf(e2).kind).toBe("retry");
  });
});

const first: ApiMessage = { role: "user", content: `作答摘要\n\n${USER_TEXT_MARKER}我想聊聊核能` };
const reply: ApiMessage = {
  role: "assistant",
  content: [{ type: "tool_use", id: "toolu_1", name: "propose_answer_change", input: { question_id: "E01", new_value: 1 } }],
};
const results = [{ type: "tool_result", tool_use_id: "toolu_1", content: "使用者拒絕修改 E01。" }];
const err = (kind: ChatErrorKind, message = "說明。"): ChatError => ({ kind, message });

describe("recoverFromError", () => {
  it("用量用完：撤回使用者的文字放回輸入框，工具結果留著；不會留下鎖住輸入框的未送出文字", () => {
    const next: ApiMessage[] = [first, reply, { role: "user", content: [...results, { type: "text", text: "為什麼？" }] }];
    const r = recoverFromError(next, err("later", "你在這 5 小時內的對答用量已達上限，請稍後再來。"));
    expect(r.restoredText).toBe("為什麼？");
    expect(r.messages).toEqual([first, reply, { role: "user", content: results }]);
    expect(userText(r.messages[r.messages.length - 1])).toBeNull();
    expect(r.error).toEqual({ kind: "later", message: "你在這 5 小時內的對答用量已達上限，請稍後再來。剛才的訊息已放回輸入框。" });
    // 第一則訊息還是同一個物件：conversation_id 不變
    expect(r.messages[0]).toBe(first);
    expect(conversationIdFor(r.messages)).toBe(conversationIdFor(next));
  });

  it("第一則就失敗時整則撤回（只放回使用者自己打的字，不含作答摘要）；之後重送是新的對話", () => {
    const r = recoverFromError([first], err("rephrase"));
    expect(r.messages).toEqual([]);
    expect(r.restoredText).toBe("我想聊聊核能");
    const resent: ApiMessage = { role: "user", content: `作答摘要\n\n${USER_TEXT_MARKER}${r.restoredText}` };
    expect(conversationIdFor([resent])).not.toBe(conversationIdFor([first]));
  });

  it("只有工具結果、沒有文字可以撤回時：用量用完照樣不給重試，Claude 拒絕回應則改成可以重試", () => {
    const next: ApiMessage[] = [first, reply, { role: "user", content: results }];
    const later = recoverFromError(next, err("later"));
    expect(later).toEqual({ messages: next, restoredText: null, error: err("later") });
    const rephrase = recoverFromError(next, err("rephrase"));
    expect(rephrase.messages).toBe(next);
    expect(rephrase.error.kind).toBe("retry");
  });

  it("重試、重新開始對話、重新整理頁面：對話原樣保留", () => {
    const next: ApiMessage[] = [first, reply, { role: "user", content: [...results, { type: "text", text: "為什麼？" }] }];
    for (const kind of ["retry", "restart", "reload"] as const) {
      const r = recoverFromError(next, err(kind));
      expect(r.messages, kind).toBe(next);
      expect(r.restoredText, kind).toBeNull();
      expect(r.error, kind).toEqual(err(kind));
    }
  });
});

// ── 錯誤在畫面上的處理：Chat.tsx 照 recoverFromError、errorAction、inputBlocked、inputHint、restartInput 顯示 ──

const ACTIONS: Record<ChatErrorKind, ErrorAction | null> = {
  retry: "retry", restart: "restart", reload: "reload", later: null, rephrase: null,
};

describe("errorAction／inputBlocked／inputHint／restartInput", () => {
  const u: ApiMessage = { role: "user", content: "嗨" };
  const a: ApiMessage = { role: "assistant", content: "你好" };

  it("按鈕文字", () => {
    expect(ACTION_LABELS).toEqual({ retry: "重試", restart: "重新開始對話", reload: "重新整理頁面" });
  });

  it("errorAction：重試要有還沒得到回覆的 user 訊息；稍後再來、改寫後再送都沒有按鈕", () => {
    expect(errorAction(null, u)).toBeNull();
    expect(errorAction(err("retry"), u)).toBe("retry");
    expect(errorAction(err("retry"), a)).toBeNull();
    expect(errorAction(err("retry"), undefined)).toBeNull();
    for (const last of [u, a, undefined]) {
      for (const kind of ["restart", "reload", "later", "rephrase"] as const) {
        expect(errorAction(err(kind), last), kind).toBe(ACTIONS[kind]);
      }
    }
  });

  it("inputBlocked：只有重新開始對話、重新整理頁面時鎖住輸入框", () => {
    expect(inputBlocked(null)).toBe(false);
    const kinds: ChatErrorKind[] = ["retry", "restart", "rephrase", "later", "reload"];
    expect(kinds.filter((k) => inputBlocked(err(k)))).toEqual(["restart", "reload"]);
  });

  it("inputHint：鎖住時說明要先做什麼", () => {
    const base = { waitingForTools: false, unsentText: false, error: null };
    expect(inputHint(base)).toMatch(/^例如：/);
    expect(inputHint({ ...base, waitingForTools: true })).toBe("請先回應上面的建議");
    expect(inputHint({ ...base, error: err("restart") })).toBe("請先按「重新開始對話」");
    expect(inputHint({ ...base, error: err("reload") })).toBe("請先重新整理頁面");
    expect(inputHint({ ...base, unsentText: true, error: err("retry") })).toBe("上一則訊息還沒送出，請先按「重試」");
    expect(inputHint({ ...base, error: err("later") })).toMatch(/^例如：/);
    expect(inputHint({ ...base, error: err("rephrase") })).toMatch(/^例如：/);
  });

  it("restartInput：放回還沒送出的使用者文字（第一則不含作答摘要）；輸入框有字或沒有文字可放回時維持原樣", () => {
    expect(restartInput([first], "")).toBe("我想聊聊核能");
    expect(restartInput([first], "  ")).toBe("我想聊聊核能");
    expect(restartInput([first], "新打的字")).toBe("新打的字");
    expect(restartInput([first, reply, { role: "user", content: [...results, { type: "text", text: "為什麼？" }] }], "")).toBe("為什麼？");
    expect(restartInput([first, reply, { role: "user", content: results }], "")).toBe("");
    expect(restartInput([], "")).toBe("");
  });
});

describe("每一種後端錯誤送出失敗後，畫面上的按鈕、輸入框與放回的文字", () => {
  /** 送出 next 失敗、loading 結束之後畫面上的狀態（和 Chat.tsx 用同樣的函式判斷） */
  function screenAfter(next: ApiMessage[], e: unknown) {
    const r = recoverFromError(next, chatErrorOf(e));
    const last = r.messages[r.messages.length - 1];
    const unsentText = last?.role === "user" && userText(last) !== null;
    return {
      r,
      action: errorAction(r.error, last),
      locked: unsentText || inputBlocked(r.error),
      hint: inputHint({ waitingForTools: false, unsentText, error: r.error }),
      input: r.restoredText ?? "",
    };
  }

  const SCENARIOS: { name: string; next: ApiMessage[]; typed: string | null }[] = [
    { name: "第一則", next: [first], typed: "我想聊聊核能" },
    { name: "對話中的文字", next: [first, reply, { role: "user", content: [...results, { type: "text", text: "為什麼？" }] }], typed: "為什麼？" },
    { name: "自動送出的工具結果", next: [first, reply, { role: "user", content: results }], typed: null },
  ];

  it.each(CASES)("$status「$detail」", ({ status, detail, kind }) => {
    for (const { name, next, typed } of SCENARIOS) {
      const s = screenAfter(next, new ApiError(status, detail, detail));
      const ctx = `${name}：${JSON.stringify({ action: s.action, locked: s.locked, hint: s.hint, input: s.input })}`;
      // 輸入框鎖住時，一定有按鈕可以處理，不會卡住只能整頁重新整理
      if (s.locked) expect(s.action, ctx).not.toBeNull();
      if (kind === "restart" || kind === "reload") {
        expect(s.action, ctx).toBe(kind);
        expect(s.locked, ctx).toBe(true);
        expect(s.hint, ctx).toBe(kind === "restart" ? "請先按「重新開始對話」" : "請先重新整理頁面");
        expect(s.r.messages, ctx).toBe(next);
        // 重新開始後放回沒送出的文字
        if (kind === "restart") expect(restartInput(s.r.messages, ""), ctx).toBe(typed ?? "");
      } else if (kind === "retry" || (kind === "rephrase" && typed === null)) {
        // 暫時性的錯誤；只有工具結果、沒有文字可撤回的 rephrase 也改成重試
        expect(s.action, ctx).toBe("retry");
        expect(s.r.messages, ctx).toBe(next);
        expect(s.locked, ctx).toBe(typed !== null);
        if (typed !== null) expect(s.hint, ctx).toBe("上一則訊息還沒送出，請先按「重試」");
      } else {
        // later、rephrase：沒有會立刻再送一次的按鈕；文字撤回、放回輸入框，輸入框可以用
        expect(s.action, ctx).toBeNull();
        expect(s.locked, ctx).toBe(false);
        expect(s.input, ctx).toBe(typed ?? "");
        if (typed !== null) expect(s.r.error.message, ctx).toBe(`${detail}剛才的訊息已放回輸入框。`);
        else expect(s.r.messages, ctx).toBe(next);
      }
    }
  });
});

describe("從討論主題開始的對話：第一則撤回或重新開始後再送出，仍附上同一個主題", () => {
  const summary = "【使用者的作答】\n- N01「測試題」：同意（1）";
  const topics = data.discussions;
  /** 和 Chat.tsx 一樣組第一則：按主題按鈕時帶 discussionId，打字送出時沒有 */
  const send1 = (text: string, discussionId?: string): ApiMessage =>
    ({ role: "user", content: firstMessage(summary, text.trim(), discussionId ?? topicOf(text, topics)) });

  it("第一則的格式：作答摘要、【討論主題】、使用者文字；system prompt 也寫明這個標記", () => {
    const m = firstMessage(summary, "我想聊聊", "T_X");
    expect(m).toBe(`${summary}\n\n${TOPIC_MARKER}T_X\n\n${USER_TEXT_MARKER}我想聊聊`);
    expect(userText({ role: "user", content: m })).toBe("我想聊聊");
    expect(firstMessage(summary, "我想聊聊", null)).toBe(`${summary}\n\n${USER_TEXT_MARKER}我想聊聊`);
    const promptPy = readFileSync(new URL("../../../api/prompt.py", import.meta.url), "utf8");
    expect(promptPy).toContain(`${TOPIC_MARKER}（對應下方討論主題的 id）`);
  });

  it("topicOf：開場白原樣、前後有空白或在後面補充都算那個主題；改寫開頭或別的內容不算", () => {
    expect(topics.length).toBeGreaterThan(0);
    for (const d of topics) {
      expect(topicOf(d.opening, topics), d.id).toBe(d.id);
      expect(topicOf(`  ${d.opening}\n`, topics), d.id).toBe(d.id);
      expect(topicOf(`${d.opening}我自己也有這種感覺。`, topics), d.id).toBe(d.id);
      expect(topicOf(d.opening.slice(2), topics), d.id).toBeNull();
    }
    expect(topicOf("我想問核能政策", topics)).toBeNull();
    expect(topicOf("", topics)).toBeNull();
  });

  it("topicOf：空白的開場白不算；符合好幾個時取開場白最長的", () => {
    const list = [{ id: "EMPTY", opening: "  " }, { id: "A", opening: "我想聊聊" }, { id: "B", opening: "我想聊聊：沉默" }];
    expect(topicOf("隨便說說", list)).toBeNull();
    expect(topicOf("我想聊聊：沉默的多數", list)).toBe("B");
    expect(topicOf("我想聊聊別的", list)).toBe("A");
  });

  it.each(CASES.filter((c) => c.kind === "later" || c.kind === "rephrase"))(
    "第一則被撤回（$status「$detail」）→ 開場白放回輸入框 → 直接送出：和第一次送的一樣",
    ({ status, detail }) => {
      for (const d of topics) {
        const sent = send1(d.opening, d.id);
        expect(sent.content, d.id).toContain(`\n\n${TOPIC_MARKER}${d.id}\n\n`);
        const r = recoverFromError([sent], classifyChatError(status, detail));
        expect(r.messages, d.id).toEqual([]); // 回到主題選單
        expect(r.restoredText, d.id).toBe(d.opening.trim());
        const again = send1(r.restoredText ?? "");
        expect(again, d.id).toEqual(sent);
        // 新的第一則訊息物件：是新的一段對話
        expect(conversationIdFor([again])).not.toBe(conversationIdFor([sent]));
        // 在後面補充也是同一個主題；換成別的內容就不附主題
        expect(send1(`${r.restoredText}我自己也有這種感覺。`).content, d.id).toContain(`\n\n${TOPIC_MARKER}${d.id}\n\n`);
        expect(send1("我想問核能政策").content, d.id).not.toContain(TOPIC_MARKER);
      }
    },
  );

  it.each(CASES.filter((c) => c.kind === "restart"))(
    "第一則遇到 $status「$detail」→ 重新開始對話 → 放回的開場白直接送出：和第一次送的一樣",
    ({ status, detail }) => {
      for (const d of topics) {
        const sent = send1(d.opening, d.id);
        const r = recoverFromError([sent], classifyChatError(status, detail));
        expect(errorAction(r.error, r.messages[r.messages.length - 1]), d.id).toBe("restart");
        const input = restartInput(r.messages, "");
        expect(input, d.id).toBe(d.opening.trim());
        expect(send1(input), d.id).toEqual(sent);
      }
    },
  );

  it("暫時性的錯誤：訊息留在對話裡，重試原樣送出（主題還在）", () => {
    const d = topics[0];
    const sent = send1(d.opening, d.id);
    const r = recoverFromError([sent], classifyChatError(503, "目前使用的人比較多，請稍後再試。"));
    expect(r.messages).toEqual([sent]);
    expect(r.messages[0]).toBe(sent); // 同一個物件：conversation_id 不變
    expect(errorAction(r.error, r.messages[0])).toBe("retry");
  });
});
