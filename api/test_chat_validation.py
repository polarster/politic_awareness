"""S5、S7、S23、S24：/api/chat 只放行前端實際會送的格式，錯誤訊息不外洩細節。"""
import json

import anthropic
import httpx2
import pytest

import app as app_module
from conftest import FakeClient

FIRST = {"role": "user", "content": "【使用者的作答】\n- N01：同意（1）\n\n【使用者訊息】\n你好"}
TOOL_USE = {"type": "tool_use", "id": "toolu_01ABCdef", "name": "ask_supplementary",
            "input": {"question_id": "X01", "why": "想多了解你的看法"}}
# 和 SDK 的 to_dict() 一樣：text 帶 citations: null，thinking 帶 signature，fallback 用 "from"
ASSISTANT = {"role": "assistant", "content": [
    {"type": "fallback", "from": {"model": "claude-sonnet-5-5"}, "to": {"model": "claude-opus-4-8"},
     "trigger": {"type": "refusal", "category": None}},
    {"type": "thinking", "thinking": "", "signature": "c2lnbmF0dXJl"},
    {"type": "redacted_thinking", "data": "ZW5jcnlwdGVk"},
    {"type": "text", "text": "我們來看看這題。", "citations": None},
    TOOL_USE,
]}
RESULT = {"role": "user", "content": [
    {"type": "tool_result", "tool_use_id": "toolu_01ABCdef", "content": "使用者作答：同意（1）。"},
    {"type": "text", "text": "另外我也想問一件事"},
]}


def post(client, messages, **extra):
    return client.post("/api/chat", json={"messages": messages, **extra})


def test_real_response_shapes_are_accepted_and_forwarded_unchanged(client, fake):
    msgs = [FIRST, ASSISTANT, RESULT]
    r = post(client, msgs)
    assert r.status_code == 200, r.text
    assert fake.calls[0]["messages"] == msgs  # 原樣送出（含 citations: null、fallback 分界），不多也不少


@pytest.mark.parametrize("block", [
    {"type": "document", "source": {"type": "url", "url": "https://example.com/600-pages.pdf"}},
    {"type": "image", "source": {"type": "url", "url": "https://example.com/a.webp"}},
    {"type": "search_result", "source": "x", "title": "t", "content": []},
    {"type": "text", "text": "hi", "cache_control": {"type": "ephemeral"}},
    {"type": "tool_result", "tool_use_id": "toolu_01ABCdef", "content": [{"type": "text", "text": "x"}]},
    {"type": "tool_result", "tool_use_id": "toolu_01ABCdef", "content": "x",
     "cache_control": {"type": "ephemeral"}},
])
def test_user_blocks_outside_whitelist_are_rejected(client, fake, block):
    r = post(client, [FIRST, {"role": "assistant", "content": [TOOL_USE]}, {"role": "user", "content": [block]}])
    assert r.status_code == 422
    assert fake.calls == []


@pytest.mark.parametrize("block", [
    {"type": "text", "text": "x", "citations": [{"type": "char_location", "cited_text": "x"}]},
    {"type": "tool_use", "id": "toolu_1", "name": "web_fetch", "input": {"url": "https://example.com"}},
    {"type": "tool_use", "id": "toolu_1", "name": "ask_supplementary", "input": {"question_id": "X01", "x": "y"}},
    {"type": "tool_use", "id": "toolu_1", "name": "ask_supplementary", "input": {"question_id": {"nested": 1}}},
    {"type": "tool_use", "id": "../bad id", "name": "ask_supplementary", "input": {"question_id": "X01"}},
    {"type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": {"query": "x"}},
    {"type": "document", "source": {"type": "text", "media_type": "text/plain", "data": "x"}},
])
def test_assistant_blocks_outside_whitelist_are_rejected(client, fake, block):
    r = post(client, [FIRST, {"role": "assistant", "content": [block]}, {"role": "user", "content": "好"}])
    assert r.status_code == 422
    assert fake.calls == []


def test_validation_error_does_not_echo_input(client, fake):
    # FastAPI 預設會把每個錯誤的輸入附在回應裡：0.25MB 的 [1,1,…] 可以換到十幾 MB 的回應
    body = {"messages": [{"role": "user", "content": [1] * 60000}]}
    r = client.post("/api/chat", json=body)
    assert r.status_code == 422
    assert len(r.content) < 200
    assert "input" not in r.json()


def test_tool_results_must_match_previous_tool_uses(client, fake):
    other = {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_other", "content": "x"}]}
    assert post(client, [FIRST, {"role": "assistant", "content": [TOOL_USE]}, other]).status_code == 400
    # 上一則沒有工具呼叫卻送工具結果（偽造的 tool_result）
    forged = {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_01ABCdef", "content": "x"}]}
    assert post(client, [FIRST, {"role": "assistant", "content": "好"}, forged]).status_code == 400
    # 上一則有工具呼叫，卻直接送文字
    assert post(client, [FIRST, {"role": "assistant", "content": [TOOL_USE]},
                         {"role": "user", "content": "略過"}]).status_code == 400
    # 文字放在工具結果前面、或有兩段文字
    swapped = {"role": "user", "content": [{"type": "text", "text": "x"}, RESULT["content"][0]]}
    assert post(client, [FIRST, ASSISTANT, swapped]).status_code == 400
    assert fake.calls == []


def test_list_form_user_messages_count_as_turns(client, fake):
    msgs = [FIRST]
    for _ in range(app_module.MAX_USER_TURNS):
        msgs += [{"role": "assistant", "content": [TOOL_USE]}, RESULT]
    r = post(client, msgs)
    assert r.status_code == 429
    assert fake.calls == []


def test_total_message_count_is_limited(client, fake):
    only_results = {"role": "user", "content": [RESULT["content"][0]]}
    msgs = [FIRST]
    while len(msgs) <= app_module.MAX_MESSAGES:
        msgs += [{"role": "assistant", "content": [TOOL_USE]}, only_results]
    assert post(client, msgs).status_code == 429
    assert fake.calls == []


def _with_trigger(value: str) -> str:
    return ('{"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": [{"type": "fallback",'
            ' "from": {"model": "m"}, "to": {"model": "n"}, "trigger": {"x": ' + value + '}}]},'
            ' {"role": "user", "content": "b"}]}')


@pytest.mark.parametrize("raw,status", [
    # NaN 與孤立的 surrogate：原本讓 SDK 序列化時丟例外而回 500
    (_with_trigger("NaN"), 400),
    (_with_trigger('"\\ud800"'), 400),
    ('{"messages": [{"role": "user", "content": "a\\ud800"}]}', 422),
])
def test_unserializable_content_is_a_client_error(client, fake, raw, status):
    r = client.post("/api/chat", content=raw, headers={"Content-Type": "application/json"})
    assert r.status_code == status
    assert fake.calls == []


def test_utf8_bytes_are_limited_not_only_code_points(client, fake, monkeypatch):
    monkeypatch.setattr(app_module, "MAX_CHARS", 3000)
    text = "𠀀" * 2300  # 4-byte 罕用字：字數在上限內，位元組數（9,200）超過 3 倍上限（9,000）
    r = post(client, [{"role": "user", "content": text}])
    assert r.status_code == 413
    assert fake.calls == []
    assert post(client, [{"role": "user", "content": "字" * 2900}]).status_code == 200


def test_per_message_length_limits(client, fake):
    long_first = {"role": "user", "content": "字" * (app_module.FIRST_MESSAGE_CHARS + 1)}
    assert post(client, [long_first]).status_code == 422  # schema 上限
    long_later = {"role": "user", "content": "字" * (app_module.USER_TEXT_CHARS + 1)}
    assert post(client, [FIRST, {"role": "assistant", "content": "好"}, long_later]).status_code == 413
    assert post(client, [{"role": "user", "content": "   "}]).status_code == 400
    assert fake.calls == []


def test_body_size_limit_returns_413_before_parsing(client, fake):
    big = json.dumps({"messages": [{"role": "user", "content": "a" * (300 * 1024)}]})
    r = client.post("/api/chat", content=big, headers={"Content-Type": "application/json"})
    assert r.status_code == 413
    assert r.json()["detail"] == "這段對話太長了，請重新開始一段對話。"

    def chunks():  # 沒有 Content-Length 的 chunked 上傳也會在超過時中止
        for _ in range(40):
            yield b"[" + b"1," * 4000 + b"1]"

    r = client.post("/api/chat", content=chunks(), headers={"Content-Type": "application/json"})
    assert r.status_code == 413
    assert fake.calls == []


def _status_error(cls, status, body):
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx2.Response(status, request=request, json=body, headers={"request-id": "req_011SECRET"})
    return cls(f"Error code: {status} - {body}", response=response, body=body)


def test_anthropic_400_is_not_echoed(client, monkeypatch):
    body = {"type": "error", "error": {"type": "invalid_request_error", "message": "messages.0: bad block"},
            "request_id": "req_011SECRET"}
    monkeypatch.setattr(app_module, "get_client",
                        lambda: FakeClient(error=_status_error(anthropic.BadRequestError, 400, body)))
    r = post(client, [FIRST])
    assert r.status_code == 400
    assert "req_" not in r.text and "Error code" not in r.text and "invalid_request_error" not in r.text
    assert r.json()["detail"] == "這則訊息無法處理，請重新開始一段對話。"


def test_account_status_400_becomes_503(client, monkeypatch):
    body = {"type": "error", "error": {"type": "invalid_request_error", "message": "on hold",
                                       "details": {"error_code": "organization_on_hold",
                                                   "appeal_url": "https://example.com/appeal"}}}
    monkeypatch.setattr(app_module, "get_client",
                        lambda: FakeClient(error=_status_error(anthropic.BadRequestError, 400, body)))
    r = post(client, [FIRST])
    assert r.status_code == 503
    assert "appeal" not in r.text and "req_" not in r.text


def test_conversation_id_is_sent_as_metadata_user_id(client, fake):
    cid = "0b8f5a7e-3c2d-4e1f-9a8b-7c6d5e4f3a2b"
    assert post(client, [FIRST], conversation_id=cid).status_code == 200
    assert fake.calls[-1]["metadata"] == {"user_id": cid}
    assert post(client, [FIRST], conversation_id="jeremy@example.com").status_code == 422
    assert post(client, [FIRST], extra_field=1).status_code == 422


def test_unknown_response_blocks_are_not_returned(client, monkeypatch):
    f = FakeClient(content=[{"type": "text", "text": "好"}, {"type": "server_tool_use", "id": "s", "name": "x",
                                                             "input": {}}])
    monkeypatch.setattr(app_module, "get_client", lambda: f)
    r = post(client, [FIRST])
    assert [b["type"] for b in r.json()["content"]] == ["text"]
