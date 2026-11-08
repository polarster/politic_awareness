import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  conversationIdFor, fingerprint, loadUploadState, newId, postChat, postLog, saveUploadState, UUID4,
  type ApiMessage, type LogRecord,
} from "./api";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

function stubFetch() {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, content: [], stop_reason: "end_turn", usage_percent: 0 }));
  }));
  return calls;
}

describe("newId", () => {
  it("產生 UUID v4，沒有 randomUUID（非 HTTPS）時也可以", () => {
    const a = newId();
    expect(a).toMatch(UUID4);
    expect(newId()).not.toBe(a);
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (b: Uint8Array) => real.getRandomValues(b) });
    try {
      expect(newId()).toMatch(UUID4);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("fingerprint", () => {
  it("同樣的內容得到同樣的指紋，內容改變就不同", () => {
    const a = { answers: { N01: { v: 1, imp: false } }, city: "taipei" };
    expect(fingerprint(a)).toBe(fingerprint(JSON.parse(JSON.stringify(a))));
    expect(fingerprint({ ...a, city: "newtaipei" })).not.toBe(fingerprint(a));
    expect(fingerprint({ answers: { N01: { v: 2, imp: false } }, city: "taipei" })).not.toBe(fingerprint(a));
  });
});

describe("上傳狀態（submission_id）", () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("sessionStorage", storage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("同一輪作答沿用同一個 id，換一輪就換新的", () => {
    const first = loadUploadState("round-1");
    expect(first.id).toMatch(UUID4);
    expect(first.sent).toBeNull();
    saveUploadState({ ...first, sent: "abc" });
    expect(loadUploadState("round-1")).toEqual({ round: "round-1", id: first.id, sent: "abc" });
    const next = loadUploadState("round-2");
    expect(next.id).not.toBe(first.id);
    expect(next.sent).toBeNull();
  });

  it("儲存內容損壞或無法使用時，產生新的狀態", () => {
    storage.setItem("politic-awareness-upload", "{not json");
    expect(loadUploadState("r").id).toMatch(UUID4);
    storage.setItem("politic-awareness-upload", JSON.stringify({ round: "r", id: "not-a-uuid", sent: null }));
    expect(loadUploadState("r").id).toMatch(UUID4);
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(loadUploadState("r").id).toMatch(UUID4);
  });

  it("postLog 送出 submission_id", async () => {
    const calls = stubFetch();
    const rec: LogRecord = {
      submission_id: loadUploadState("r").id, quiz_version: "v+12345678", city: null, answers: {}, budget: null,
      adjustments: [], mode: "simple", first_answers: null, journey_after_results: null,
    };
    await postLog(rec);
    expect((calls[0].body as LogRecord).submission_id).toMatch(UUID4);
  });
});

describe("conversationIdFor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("同一段對話（同一則第一訊息）用同一個 id，新的對話換新的", async () => {
    const first: ApiMessage = { role: "user", content: "嗨" };
    const a = conversationIdFor([first]);
    expect(a).toMatch(UUID4);
    expect(conversationIdFor([first, { role: "assistant", content: "你好" }, { role: "user", content: "再說" }])).toBe(a);
    expect(conversationIdFor([{ role: "user", content: "嗨" }])).not.toBe(a);
    expect(conversationIdFor([])).toBeUndefined();

    const calls = stubFetch();
    await postChat([first]);
    expect(calls[0].body).toEqual({ messages: [first], conversation_id: a });
  });
});
