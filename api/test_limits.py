"""S2、S4、S6、S7：同時請求上限、client key、限流清理、每個 client 的子額度、解析 body 之前先限流。"""
import threading
from types import SimpleNamespace

import pytest
from starlette.requests import Request

import app as app_module
from conftest import FakeClient
from usage import ClientBudget, UsageBudget

MSG = {"messages": [{"role": "user", "content": "嗨"}]}
IP_HEADER = "x-test-client-ip"


def make_request(headers=None, host="203.0.113.9"):
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "method": "POST", "path": "/api/chat", "headers": raw, "client": (host, 1234)})


def test_forwarded_for_is_ignored_unless_a_header_is_configured(monkeypatch):
    monkeypatch.setattr(app_module, "CLIENT_IP_HEADER", None)
    a = app_module.client_identity(make_request({"X-Forwarded-For": "1.1.1.1"}))
    b = app_module.client_identity(make_request({"X-Forwarded-For": "2.2.2.2"}))
    assert a == b and a[1] is True  # 輪替 XFF 不會換到新的 key


def test_configured_header_is_used_and_validated(monkeypatch):
    monkeypatch.setattr(app_module, "CLIENT_IP_HEADER", "cf-connecting-ip")
    k1, d1 = app_module.client_identity(make_request({"CF-Connecting-IP": "198.51.100.7"}))
    k2, _ = app_module.client_identity(make_request({"CF-Connecting-IP": "198.51.100.8"}))
    assert d1 and k1 != k2
    # 不是 IP 的值：退回連線來源位址
    k3, _ = app_module.client_identity(make_request({"CF-Connecting-IP": "1.1.1.1, 2.2.2.2"}))
    assert k3 == app_module.client_identity(make_request())[0]
    # key 是雜湊，不含原始 IP
    assert "198.51.100.7" not in k1


def test_ipv6_is_grouped_by_64_and_loopback_is_not_distinct(monkeypatch):
    monkeypatch.setattr(app_module, "CLIENT_IP_HEADER", "cf-connecting-ip")
    a = app_module.client_identity(make_request({"CF-Connecting-IP": "2001:db8:1:2::1"}))
    b = app_module.client_identity(make_request({"CF-Connecting-IP": "2001:db8:1:2:ffff::9"}))
    c = app_module.client_identity(make_request({"CF-Connecting-IP": "2001:db8:1:3::1"}))
    assert a == b and a != c
    mapped = app_module.client_identity(make_request({"CF-Connecting-IP": "::ffff:198.51.100.7"}))
    assert mapped == app_module.client_identity(make_request({"CF-Connecting-IP": "198.51.100.7"}))
    assert app_module.client_identity(make_request(host="127.0.0.1"))[1] is False


def test_rate_limiter_purges_expired_keys_without_new_hits():
    rl = app_module.RateLimiter(2, 60)
    for i in range(1000):
        assert rl.allow(f"k{i}", now=0.0)
    assert len(rl) == 1000
    rl.purge(now=61.0)  # 背景工作每 60 秒呼叫一次
    assert len(rl) == 0


def test_rate_limiter_keeps_active_keys_and_caps_key_count():
    rl = app_module.RateLimiter(2, 60, max_keys=3)
    assert rl.allow("old", now=0.0)
    assert rl.allow("a", now=30.0) and rl.allow("a", now=31.0)
    assert not rl.allow("a", now=32.0)
    assert rl.allow("old", now=61.0)  # 視窗過了又可以
    for k in ("b", "c", "d"):
        rl.allow(k, now=62.0)
    assert len(rl) == 3  # 超過上限時丟掉最久沒出現的
    assert list(rl.hits) == ["b", "c", "d"]


def test_rate_limit_runs_before_body_parsing(client, monkeypatch):
    monkeypatch.setattr(app_module, "chat_limiter", app_module.RateLimiter(1, 60))
    assert client.post("/api/chat", content=b"not json", headers={"Content-Type": "application/json"}).status_code == 422
    r = client.post("/api/chat", content=b"x" * 200_000, headers={"Content-Type": "application/json"})
    assert r.status_code == 429  # 已被限流的 key：body 不會被讀取或解析
    assert r.json()["detail"] == "請求太頻繁，請稍後再試。"


def test_log_rate_limit_also_runs_first(client, monkeypatch):
    monkeypatch.setattr(app_module, "log_limiter", app_module.RateLimiter(1, 60))
    assert client.post("/api/log", json={}).status_code == 422
    assert client.post("/api/log", json={}).status_code == 429


def test_chat_slots_limit_global_and_per_client():
    s = app_module.ChatSlots(2)
    assert s.acquire("a") is None
    assert s.acquire("a") == "client"
    assert s.acquire(None) is None
    assert s.acquire("b") == "full"
    s.release("a")
    assert s.acquire("b") is None
    s.release(None)
    s.release("b")
    assert s.active == set() and s.anonymous == 0


class BlockingClient(FakeClient):
    def __init__(self):
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()

    def create(self, **kw):
        self.entered.set()
        assert self.release.wait(10)
        return super().create(**kw)


def test_concurrent_chats_are_capped(client, monkeypatch):
    """S2：原本同時送出的請求都會通過「先檢查、後扣款」；現在同時進行的呼叫有上限。"""
    monkeypatch.setattr(app_module, "CLIENT_IP_HEADER", IP_HEADER)
    monkeypatch.setattr(app_module, "chat_slots", app_module.ChatSlots(1))
    blocking = BlockingClient()
    monkeypatch.setattr(app_module, "get_client", lambda: blocking)
    results = {}
    t = threading.Thread(target=lambda: results.setdefault(
        "first", client.post("/api/chat", json=MSG, headers={IP_HEADER: "198.51.100.1"}).status_code))
    t.start()
    assert blocking.entered.wait(10)
    same = client.post("/api/chat", json=MSG, headers={IP_HEADER: "198.51.100.1"})
    other = client.post("/api/chat", json=MSG, headers={IP_HEADER: "198.51.100.2"})
    blocking.release.set()
    t.join(10)
    assert results["first"] == 200
    assert same.status_code == 429  # 同一個 client 已有請求在進行
    assert other.status_code == 503  # 全站名額已滿
    assert len(blocking.calls) == 1
    # 名額釋放後恢復
    assert client.post("/api/chat", json=MSG, headers={IP_HEADER: "198.51.100.2"}).status_code == 200


class RacySlots(app_module.ChatSlots):
    """模擬時序：這個請求通過額度檢查後、拿到名額前，另一個請求剛好記帳（用完額度）並釋放名額。"""

    def __init__(self, total, before_acquire):
        super().__init__(total)
        self.before_acquire = before_acquire

    def acquire(self, key):
        self.before_acquire()
        return super().acquire(key)


@pytest.mark.parametrize("which", ["site", "client"])
def test_budget_is_rechecked_after_taking_a_slot(client, fake, monkeypatch, which):
    """S2：拿到名額後要再檢查一次全站額度與每人子額度，不然釋放出來的名額會放行一個已過期的檢查結果。"""
    monkeypatch.setattr(app_module, "CLIENT_IP_HEADER", IP_HEADER)
    ip = {IP_HEADER: "198.51.100.1"}
    if which == "site":
        def spend():
            app_module.token_budget.record(5.0)
    else:
        def spend():
            app_module.client_budget.record(app_module.client_key(make_request(ip)), 5.0)
    slots = RacySlots(2, spend)
    monkeypatch.setattr(app_module, "chat_slots", slots)
    r = client.post("/api/chat", json=MSG, headers=ip)
    assert r.status_code == 429
    assert ("你在這" in r.json()["detail"]) == (which == "client")
    assert fake.calls == []  # 沒有呼叫 Claude
    assert slots.active == set() and slots.anonymous == 0  # 名額已釋放


def test_slot_is_released_when_claude_fails(client, monkeypatch):
    import anthropic
    import httpx2

    monkeypatch.setattr(app_module, "chat_slots", app_module.ChatSlots(1))
    err = anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))
    monkeypatch.setattr(app_module, "get_client", lambda: FakeClient(error=err))
    assert client.post("/api/chat", json=MSG).status_code == 502
    assert app_module.chat_slots.active == set() and app_module.chat_slots.anonymous == 0


def test_per_client_budget(client, monkeypatch):
    """S6：一個 client 用光自己的子額度後，其他人還能對答。"""
    monkeypatch.setattr(app_module, "CLIENT_IP_HEADER", IP_HEADER)
    monkeypatch.setattr(app_module, "client_budget", ClientBudget(0.0005, 3600))
    monkeypatch.setattr(app_module, "token_budget", UsageBudget(1.0, 3600))
    fake = FakeClient()  # 每次 $0.00072
    monkeypatch.setattr(app_module, "get_client", lambda: fake)
    a = {IP_HEADER: "198.51.100.1"}
    assert client.post("/api/chat", json=MSG, headers=a).status_code == 200
    r = client.post("/api/chat", json=MSG, headers=a)
    assert r.status_code == 429 and "你在這" in r.json()["detail"]
    assert client.post("/api/chat", json=MSG, headers={IP_HEADER: "198.51.100.2"}).status_code == 200
    assert len(fake.calls) == 2


def test_client_budget_window_and_purge():
    b = ClientBudget(1.0, 100)
    b.record("a", 0.6, now=0.0)
    b.record("a", 0.5, now=50.0)
    assert b.exhausted("a", now=60.0)
    assert not b.exhausted("a", now=120.0)  # 第一筆滑出視窗
    b.record("b", 0.1, now=120.0)
    b.purge(now=500.0)
    assert len(b) == 0


def test_fallback_iterations_are_charged(client, monkeypatch):
    """S20：被拒那次的用量記在 usage.iterations，也要算進額度。"""
    seg = dict(cache_creation_input_tokens=0, cache_read_input_tokens=0)
    usage = SimpleNamespace(input_tokens=100, output_tokens=10, cache_creation_input_tokens=0,
                            cache_read_input_tokens=0, iterations=[
                                SimpleNamespace(type="message", model=None, input_tokens=1000, output_tokens=7900, **seg),
                                SimpleNamespace(type="fallback_message", model="claude-opus-4-8", input_tokens=100,
                                                output_tokens=10, **seg)])
    monkeypatch.setattr(app_module, "get_client",
                        lambda: FakeClient(usage=usage, model="claude-opus-4-8"))
    assert client.post("/api/chat", json=MSG).status_code == 200
    expected = (1000 * 5 + 7900 * 25 + 100 * 5 + 10 * 25) / 1e6  # 沒標模型的一段取兩者中較貴的價格
    assert app_module.token_budget.used() == pytest.approx(expected)
