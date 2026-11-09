"""測試共用設定：在匯入 app 之前把設定指到暫存目錄，測試不會碰到正在使用的資料庫或真的 Claude API。"""
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

_TMP = Path(tempfile.mkdtemp(prefix="pa-test-"))
for _name in [n for n in os.environ if n.startswith("PA_") or n == "ANTHROPIC_API_KEY"]:
    del os.environ[_name]
os.environ["PA_USAGE_DB_PATH"] = str(_TMP / "usage.sqlite3")
os.environ["PA_LOG_DB_PATH"] = str(_TMP / "answers.sqlite3")

import app as app_module  # noqa: E402
from usage import ClientBudget, UsageBudget  # noqa: E402


class FakeBlock:
    def __init__(self, d):
        self.d = d
        self.type = d["type"]

    def to_dict(self):
        return self.d


class FakeClient:
    """假的 Anthropic client：記下收到的參數，回傳固定的回覆與用量。"""

    def __init__(self, stop_reason="end_turn", content=None, usage=None, model="claude-sonnet-5-5", error=None):
        self.calls = []
        self.stop_reason = stop_reason
        self.content = content if content is not None else [{"type": "text", "text": "你好"}]
        self.usage = usage or SimpleNamespace(input_tokens=100, output_tokens=50,
                                              cache_creation_input_tokens=0, cache_read_input_tokens=100)
        self.model = model
        self.error = error
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))

    def create(self, **kw):
        self.calls.append(kw)
        if self.error is not None:
            raise self.error
        return SimpleNamespace(stop_reason=self.stop_reason, content=[FakeBlock(c) for c in self.content],
                               usage=self.usage, model=self.model)


@pytest.fixture
def client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setattr(app_module, "LOG_DB_PATH", tmp_path / "answers.sqlite3")
    monkeypatch.setattr(app_module, "_last_vacuum_day", None)
    monkeypatch.setattr(app_module, "chat_limiter", app_module.RateLimiter(100, 60))
    monkeypatch.setattr(app_module, "log_limiter", app_module.RateLimiter(100, 60))
    monkeypatch.setattr(app_module, "chat_slots", app_module.ChatSlots(2))
    monkeypatch.setattr(app_module, "token_budget", UsageBudget(1.0, 3600))
    monkeypatch.setattr(app_module, "client_budget", ClientBudget(1.0, 3600))
    return TestClient(app_module.app)


@pytest.fixture
def fake(monkeypatch):
    f = FakeClient()
    monkeypatch.setattr(app_module, "get_client", lambda: f)
    return f
