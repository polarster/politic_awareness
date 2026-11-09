import { describe, expect, it } from "vitest";
import type { ApiMessage } from "./api";
import {
  MAX_AUTO_RESENDS, USER_TEXT_MARKER, nextToolStep, userText, withUserText, withoutUserText, type Decisions,
} from "./chatFlow";

function badCall(id: string): ApiMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "我建議修改這題。" },
      { type: "tool_use", id, name: "propose_answer_change", input: { question_id: "ZZZ", new_value: 1 } },
    ],
  };
}

const rejected = (id: string): Decisions => ({
  [id]: { label: "（系統）無法處理這項建議", result: "未知的題目 id：ZZZ", isError: true },
});

/** user／assistant 交替，而且第一則與最後一則都是 user（後端的格式檢查） */
function alternates(msgs: ApiMessage[]): boolean {
  return msgs.length > 0 && msgs[0].role === "user" && msgs[msgs.length - 1].role === "user"
    && msgs.every((m, i) => i === 0 || m.role !== msgs[i - 1].role);
}

/**
 * 模擬 Chat 元件：送出 messages 後，模型每次都回一則不合法的工具呼叫，
 * 驗證後標成錯誤，再交給 nextToolStep 決定要不要自動回送。回傳總共送了幾次請求。
 */
function run(messages: ApiMessage[], decisions: Decisions, autoResends = 0) {
  let requests = 0;
  for (let i = 0; i < 100; i++) {
    expect(alternates(messages)).toBe(true);
    requests++;
    const id = `toolu_${messages.length}`;
    const reply = badCall(id);
    messages = [...messages, reply];
    decisions = { ...decisions, ...rejected(id) };
    const step = nextToolStep(reply, decisions, autoResends);
    if (step.kind !== "send") return { requests, messages, decisions, step };
    autoResends = step.autoResends;
    messages = [...messages, step.message];
  }
  throw new Error("一直自動重送，沒有停下來");
}

describe("工具呼叫一直不合法時的自動回送", () => {
  it("每次使用者操作後最多自動回送一次，然後停下來", () => {
    const r = run([{ role: "user", content: "我想聊聊核能" }], {});
    expect(MAX_AUTO_RESENDS).toBe(1);
    expect(r.requests).toBe(1 + MAX_AUTO_RESENDS);
    expect(r.step.kind).toBe("hold");
  });

  it("停下來之後，使用者的下一則訊息和錯誤結果合併成一則送出，不會有連續兩則 user 訊息", () => {
    const first = run([{ role: "user", content: "我想聊聊核能" }], {});
    const held = first.messages[first.messages.length - 1];
    const next = withUserText(first.messages, "請換個方式說明", first.decisions);
    expect(alternates(next)).toBe(true);
    expect(next).toHaveLength(first.messages.length + 1);
    const merged = next[next.length - 1];
    expect(merged.role).toBe("user");
    const heldId = (held.content as { type: string; id?: string }[]).find((b) => b.type === "tool_use")?.id;
    expect(merged.content).toEqual([
      { type: "tool_result", tool_use_id: heldId, content: "未知的題目 id：ZZZ", is_error: true },
      { type: "text", text: "請換個方式說明" },
    ]);
    expect(userText(merged)).toBe("請換個方式說明");
    // 使用者操作後重新計算：這次一樣最多自動回送一次
    const second = run(next, first.decisions);
    expect(second.requests).toBe(1 + MAX_AUTO_RESENDS);
  });

  it("有使用者自己做的決定時照常送出，並重新計算自動回送次數", () => {
    const ask: ApiMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_ok", name: "propose_answer_change", input: { question_id: "E01", new_value: 1 } }],
    };
    const decisions: Decisions = { toolu_ok: { label: "已修改", result: "使用者已確認修改 E01：0 → 1。" } };
    const step = nextToolStep(ask, decisions, MAX_AUTO_RESENDS);
    expect(step).toEqual({
      kind: "send",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ok", content: "使用者已確認修改 E01：0 → 1。" }] },
      autoResends: 0,
    });
  });

  it("還有建議等使用者回應、或沒有工具呼叫時不送", () => {
    expect(nextToolStep(badCall("toolu_x"), {}, 0)).toEqual({ kind: "wait" });
    expect(nextToolStep({ role: "assistant", content: [{ type: "text", text: "好的" }] }, {}, 0)).toEqual({ kind: "wait" });
    expect(nextToolStep(undefined, {}, 0)).toEqual({ kind: "wait" });
  });
});

describe("withUserText", () => {
  it("一般情況新增一則文字訊息", () => {
    const msgs: ApiMessage[] = [{ role: "user", content: "嗨" }, { role: "assistant", content: [{ type: "text", text: "你好" }] }];
    expect(withUserText(msgs, "再說一點", {})).toEqual([...msgs, { role: "user", content: "再說一點" }]);
  });

  it("上一則 user 訊息沒送成功時併進那一則，不會有連續兩則 user 訊息", () => {
    // 畫面上只有「只剩工具結果沒送出」時才能打字；已經有文字的情況是保底行為
    const first = `作答摘要\n\n${USER_TEXT_MARKER}第一句`;
    const out = withUserText([{ role: "user", content: first }], "第二句", {});
    expect(out).toEqual([{ role: "user", content: `${first}\n\n第二句` }]);
    expect(userText(out[0])).toBe("第一句\n\n第二句");

    const results = [{ type: "tool_result", tool_use_id: "toolu_1", content: "使用者拒絕修改 E01。" }];
    const msgs: ApiMessage[] = [
      { role: "user", content: "嗨" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "propose_answer_change", input: {} }] },
      { role: "user", content: results },
    ];
    const merged = withUserText(msgs, "為什麼這樣建議？", {});
    expect(alternates(merged)).toBe(true);
    expect(merged[2].content).toEqual([...results, { type: "text", text: "為什麼這樣建議？" }]);
    const again = withUserText(merged, "補充一句", {});
    expect(again[2].content).toEqual([...results, { type: "text", text: "為什麼這樣建議？\n\n補充一句" }]);
  });
});

describe("userText／withoutUserText", () => {
  it("只取使用者輸入的文字；只有工具結果時沒有文字", () => {
    expect(userText({ role: "user", content: `摘要\n${USER_TEXT_MARKER}你好` })).toBe("你好");
    expect(userText({ role: "user", content: "你好" })).toBe("你好");
    expect(userText({ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] })).toBeNull();
    expect(userText({ role: "assistant", content: "你好" })).toBeNull();
  });

  it("撤回文字時保留工具結果", () => {
    const tr = { type: "tool_result", tool_use_id: "t", content: "x", is_error: true };
    expect(withoutUserText({ role: "user", content: "你好" })).toBeNull();
    expect(withoutUserText({ role: "user", content: [tr, { type: "text", text: "你好" }] }))
      .toEqual({ role: "user", content: [tr] });
    expect(withoutUserText({ role: "user", content: [{ type: "text", text: "你好" }] })).toBeNull();
  });
});
