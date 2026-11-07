"""全站共用的 Claude 用量上限：滾動視窗（預設 5 小時）內的總花費（美元）。

不記名，所以只算整個 app 的總量。每次呼叫 Claude 後，依實際 token 用量與價格表換算成美元並記錄；
紀錄只有「時間戳 + 金額」，存在 SQLite 以便重啟後延續。
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from collections import deque
from pathlib import Path

# 每百萬 tokens 的美元價格。可用環境變數 PRICE_TABLE（JSON）覆寫。
# cache_write 以 5 分鐘快取計；數字待確認後再定案。
DEFAULT_PRICES: dict[str, dict[str, float]] = {
    "claude-sonnet-5-5": {"input": 2.0, "output": 10.0, "cache_write": 2.5, "cache_read": 0.2},
    "claude-opus-5-5": {"input": 4.0, "output": 20.0, "cache_write": 5.0, "cache_read": 0.2},
}


def load_prices(raw: str | None) -> dict[str, dict[str, float]]:
    prices = {k: dict(v) for k, v in DEFAULT_PRICES.items()}
    if raw:
        for model, p in json.loads(raw).items():
            prices.setdefault(model, {}).update(p)
    return prices


def _g(usage, name: str) -> int:
    return int(getattr(usage, name, 0) or 0)


def tokens_from_usage(usage) -> int:
    """一次問答的總 token 數 = 輸入（含快取寫入與讀取）+ 輸出。"""
    return (_g(usage, "input_tokens") + _g(usage, "cache_creation_input_tokens")
            + _g(usage, "cache_read_input_tokens") + _g(usage, "output_tokens"))


def cost_from_usage(usage, model: str, prices: dict[str, dict[str, float]]) -> float:
    """依價格表把一次問答換算成美元。價格表沒有的模型，用表中最貴的價格計（保守估計）。"""
    p = prices.get(model)
    if p is None:
        p = max(prices.values(), key=lambda x: x.get("output", 0))
    return (
        _g(usage, "input_tokens") * p.get("input", 0)
        + _g(usage, "cache_creation_input_tokens") * p.get("cache_write", p.get("input", 0))
        + _g(usage, "cache_read_input_tokens") * p.get("cache_read", 0)
        + _g(usage, "output_tokens") * p.get("output", 0)
    ) / 1_000_000


class UsageBudget:
    """滾動視窗內的累計花費（美元）。"""

    def __init__(self, budget_usd: float, window_seconds: int, db_path: Path | None = None):
        self.budget = budget_usd
        self.window = window_seconds
        self.db_path = db_path
        self.events: deque[tuple[float, float]] = deque()
        self.total = 0.0
        self.lock = threading.Lock()
        if db_path:
            self._load()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.execute("CREATE TABLE IF NOT EXISTS usage_cost (ts REAL NOT NULL, usd REAL NOT NULL)")
        return conn

    def _load(self) -> None:
        cutoff = time.time() - self.window
        conn = self._conn()
        try:
            conn.execute("DELETE FROM usage_cost WHERE ts < ?", (cutoff,))
            conn.commit()
            for ts, usd in conn.execute("SELECT ts, usd FROM usage_cost ORDER BY ts"):
                self.events.append((ts, usd))
                self.total += usd
        finally:
            conn.close()

    def _expire(self, now: float) -> None:
        cutoff = now - self.window
        while self.events and self.events[0][0] < cutoff:
            _, usd = self.events.popleft()
            self.total -= usd
        if not self.events:
            self.total = 0.0  # 避免浮點誤差累積

    def used(self, now: float | None = None) -> float:
        with self.lock:
            self._expire(now if now is not None else time.time())
            return self.total

    def exhausted(self, now: float | None = None) -> bool:
        return self.used(now) >= self.budget

    def percent(self, now: float | None = None) -> int:
        """0–100 的整數百分比（超過上限時顯示 100）。"""
        if self.budget <= 0:
            return 100
        return min(100, int(self.used(now) * 100 // self.budget))

    def record(self, usd: float, now: float | None = None) -> None:
        now = now if now is not None else time.time()
        with self.lock:
            self.events.append((now, usd))
            self.total += usd
            self._expire(now)
        if self.db_path:
            conn = self._conn()
            try:
                conn.execute("INSERT INTO usage_cost (ts, usd) VALUES (?, ?)", (now, usd))
                conn.execute("DELETE FROM usage_cost WHERE ts < ?", (now - self.window,))
                conn.commit()
            finally:
                conn.close()
