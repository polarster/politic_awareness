"""全站共用的 Claude 用量上限：滾動視窗（預設 5 小時）內的總 token 數。

不記名，所以只算整個 app 的總量。每次呼叫 Claude 後記錄該次的 token 數；
紀錄只有「時間戳 + token 數」，存在 SQLite 以便重啟後延續。
"""
from __future__ import annotations

import sqlite3
import threading
import time
from collections import deque
from pathlib import Path


def tokens_from_usage(usage) -> int:
    """一次問答的總 token 數 = 輸入（含快取寫入與讀取）+ 輸出。"""
    def g(name: str) -> int:
        return int(getattr(usage, name, 0) or 0)

    return (
        g("input_tokens")
        + g("cache_creation_input_tokens")
        + g("cache_read_input_tokens")
        + g("output_tokens")
    )


class TokenBudget:
    def __init__(self, budget: int, window_seconds: int, db_path: Path | None = None):
        self.budget = budget
        self.window = window_seconds
        self.db_path = db_path
        self.events: deque[tuple[float, int]] = deque()
        self.total = 0
        self.lock = threading.Lock()
        if db_path:
            self._load()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.execute("CREATE TABLE IF NOT EXISTS token_usage (ts REAL NOT NULL, tokens INTEGER NOT NULL)")
        return conn

    def _load(self) -> None:
        cutoff = time.time() - self.window
        conn = self._conn()
        try:
            conn.execute("DELETE FROM token_usage WHERE ts < ?", (cutoff,))
            conn.commit()
            for ts, tok in conn.execute("SELECT ts, tokens FROM token_usage ORDER BY ts"):
                self.events.append((ts, tok))
                self.total += tok
        finally:
            conn.close()

    def _expire(self, now: float) -> None:
        cutoff = now - self.window
        while self.events and self.events[0][0] < cutoff:
            _, tok = self.events.popleft()
            self.total -= tok

    def used(self, now: float | None = None) -> int:
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

    def record(self, tokens: int, now: float | None = None) -> None:
        now = now if now is not None else time.time()
        with self.lock:
            self.events.append((now, tokens))
            self.total += tokens
            self._expire(now)
        if self.db_path:
            conn = self._conn()
            try:
                conn.execute("INSERT INTO token_usage (ts, tokens) VALUES (?, ?)", (now, tokens))
                conn.execute("DELETE FROM token_usage WHERE ts < ?", (now - self.window,))
                conn.commit()
            finally:
                conn.close()
