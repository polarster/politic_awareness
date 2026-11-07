import json
import sqlite3
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import app as app_module
from prompt import TOOLS, build_system_prompt
from usage import TokenBudget


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "LOG_DB_PATH", tmp_path / "t.sqlite3")
    monkeypatch.setattr(app_module, "chat_limiter", app_module.RateLimiter(100, 60))
    monkeypatch.setattr(app_module, "log_limiter", app_module.RateLimiter(100, 60))
    monkeypatch.setattr(app_module, "token_budget", TokenBudget(1000, 3600))
    return TestClient(app_module.app)


class FakeBlock:
    def __init__(self, d):
        self.d = d

    def to_dict(self):
        return self.d


class FakeClient:
    def __init__(self, stop_reason="end_turn", content=None):
        self.calls = []
        self.stop_reason = stop_reason
        self.content = content if content is not None else [{"type": "text", "text": "你好"}]
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))

    def create(self, **kw):
        self.calls.append(kw)
        usage = SimpleNamespace(input_tokens=100, output_tokens=50,
                                cache_creation_input_tokens=0, cache_read_input_tokens=100)
        return SimpleNamespace(stop_reason=self.stop_reason, content=[FakeBlock(c) for c in self.content],
                               usage=usage)


def test_system_prompt_includes_questions_and_rules():
    p = build_system_prompt(app_module.DATA)
    assert "N01" in p and "X13" in p and "B_TECH" in p
    assert "T_POLITICAL_SILENCE" in p
    assert "不勸使用者支持" in p
    if any(app_module.DATA["stances"].values()):
        assert "kmt / G02" in p and "https://" in p
    else:
        assert "目前尚未整理任何立場資料" in p


def test_tools_are_strict():
    for t in TOOLS:
        assert t["strict"] is True
        assert t["input_schema"]["additionalProperties"] is False


def test_chat_proxies_request(client, monkeypatch):
    fake = FakeClient()
    monkeypatch.setattr(app_module, "get_client", lambda: fake)
    r = client.post("/api/chat", json={"messages": [{"role": "user", "content": "嗨"}]})
    assert r.status_code == 200
    assert r.json()["content"][0]["text"] == "你好"
    call = fake.calls[0]
    assert call["model"] == app_module.MODEL
    assert call["tools"] == TOOLS
    assert call["system"][0]["text"] == app_module.SYSTEM_PROMPT
    assert call["fallbacks"] == "default"


def test_chat_refusal_returns_409(client, monkeypatch):
    monkeypatch.setattr(app_module, "get_client", lambda: FakeClient(stop_reason="refusal", content=[]))
    r = client.post("/api/chat", json={"messages": [{"role": "user", "content": "嗨"}]})
    assert r.status_code == 409


def test_chat_rejects_bad_conversation(client, monkeypatch):
    monkeypatch.setattr(app_module, "get_client", lambda: FakeClient())
    r = client.post("/api/chat", json={"messages": [{"role": "assistant", "content": "x"}]})
    assert r.status_code == 400
    r = client.post("/api/chat", json={"messages": [
        {"role": "user", "content": "a"}, {"role": "user", "content": "b"}]})
    assert r.status_code == 400


def test_chat_turn_limit(client, monkeypatch):
    monkeypatch.setattr(app_module, "get_client", lambda: FakeClient())
    msgs = []
    for _ in range(app_module.MAX_USER_TURNS + 1):
        msgs += [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
    r = client.post("/api/chat", json={"messages": msgs[:-1]})
    assert r.status_code == 429


def test_rate_limiter():
    rl = app_module.RateLimiter(2, 60)
    assert rl.allow("a") and rl.allow("a")
    assert not rl.allow("a")
    assert rl.allow("b")


def _log_body(**kw):
    body = {
        "quiz_version": app_module.DATA["version"],
        "city": "taipei",
        "answers": {"N01": {"v": 1, "imp": True}, "N02": {"v": None, "imp": False}},
        "budget": {"B_HOUSING": 2, "R_DEBT": 1},
        "adjustments": [{"type": "answer_change", "question": "N01", "from": 0, "to": 1}],
    }
    body.update(kw)
    return body


def test_log_stores_minimal_record(client):
    r = client.post("/api/log", json=_log_body(), headers={"User-Agent": "secret-ua"})
    assert r.status_code == 200
    conn = sqlite3.connect(app_module.LOG_DB_PATH)
    rows = conn.execute("SELECT hour, quiz_version, payload FROM answers").fetchall()
    assert len(rows) == 1
    hour, version, payload = rows[0]
    assert len(hour) == len("2026-11-07T14")
    assert version == app_module.DATA["version"]
    assert "secret-ua" not in payload and "testclient" not in payload
    assert json.loads(payload)["answers"]["N01"] == {"v": 1, "imp": True}


@pytest.mark.parametrize("override", [
    {"quiz_version": "old"},
    {"answers": {"NOPE": {"v": 1, "imp": False}}},
    {"answers": {"N01": {"v": 5, "imp": False}}},
    {"budget": {"B_HOUSING": 3}},
    {"city": "kaohsiung"},
])
def test_log_rejects_invalid(client, override):
    r = client.post("/api/log", json=_log_body(**override))
    assert r.status_code in (400, 422)


def test_chat_records_usage_and_reports_percent(client, monkeypatch):
    monkeypatch.setattr(app_module, "get_client", lambda: FakeClient())
    r = client.post("/api/chat", json={"messages": [{"role": "user", "content": "嗨"}]})
    assert r.json()["usage_percent"] == 25  # 250 / 1000
    assert client.get("/api/usage").json() == {"percent": 25}


def test_chat_blocked_when_budget_exhausted(client, monkeypatch):
    fake = FakeClient()
    monkeypatch.setattr(app_module, "get_client", lambda: fake)
    app_module.token_budget.record(1000)
    r = client.post("/api/chat", json={"messages": [{"role": "user", "content": "嗨"}]})
    assert r.status_code == 429
    assert fake.calls == []
    assert client.get("/api/usage").json() == {"percent": 100}


def test_token_budget_window_and_persistence(tmp_path):
    db = tmp_path / "u.sqlite3"
    b = TokenBudget(100, 3600, db)
    b.record(30, now=1000.0)
    b.record(50, now=2000.0)
    assert b.used(now=2000.0) == 80
    assert b.percent(now=2000.0) == 80
    assert b.used(now=1000.0 + 3601) == 50  # 第一筆滑出視窗
    b2 = TokenBudget(100, 10**12, db)  # 重啟後從 SQLite 讀回
    assert b2.used() == 80
