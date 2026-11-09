"""Claude 用量上限：滾動視窗（預設 5 小時）內的花費（美元）。

不記名，所以全站只算總量（UsageBudget，存在 SQLite 以便重啟後延續）；另外在記憶體裡為每個 client
記一份子額度（ClientBudget），避免一個人用光全站額度。每次呼叫 Claude 後，依實際 token 用量與價格表
換算成美元並記錄；紀錄只有「時間戳 + 金額」。
"""
from __future__ import annotations

import json
import logging
import math
import os
import sqlite3
import threading
import time
from collections import OrderedDict, deque
from pathlib import Path

log = logging.getLogger("uvicorn.error")

PRICE_FIELDS = ("input", "output", "cache_write", "cache_read")

# 每百萬 tokens 的美元價格。可用環境變數 PA_PRICE_TABLE（JSON）覆寫或新增。
# cache_write 以 5 分鐘快取計。fallbacks="default" 可能改由其他模型回覆，所以也列出常見的 fallback 目標。
DEFAULT_PRICES: dict[str, dict[str, float]] = {
    "claude-sonnet-5-5": {"input": 2.0, "output": 10.0, "cache_write": 2.5, "cache_read": 0.2},
    "claude-opus-5-5": {"input": 4.0, "output": 20.0, "cache_write": 5.0, "cache_read": 0.2},
    "claude-sonnet-5": {"input": 2.0, "output": 10.0, "cache_write": 2.5, "cache_read": 0.2},
    "claude-opus-5": {"input": 5.0, "output": 25.0, "cache_write": 6.25, "cache_read": 0.5},
    "claude-opus-4-8": {"input": 5.0, "output": 25.0, "cache_write": 6.25, "cache_read": 0.5},
}


def load_prices(raw: str | None) -> dict[str, dict[str, float]]:
    """預設價格表加上 PA_PRICE_TABLE 的覆寫。每一列都必須有四個非負數的價格，否則拒絕啟動。"""
    prices = {k: dict(v) for k, v in DEFAULT_PRICES.items()}
    if raw:
        table = json.loads(raw)
        if not isinstance(table, dict):
            raise ValueError("PA_PRICE_TABLE 必須是 JSON 物件")
        for model, p in table.items():
            if not isinstance(p, dict):
                raise ValueError(f"PA_PRICE_TABLE 的 {model} 必須是物件")
            prices.setdefault(model, {}).update(p)
    for model, p in prices.items():
        for f in PRICE_FIELDS:
            v = p.get(f)
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0:
                raise ValueError(f"價格表的 {model} 缺少 {f}，或不是非負數")
        extra = set(p) - set(PRICE_FIELDS)
        if extra:
            raise ValueError(f"價格表的 {model} 有不認得的欄位：{', '.join(sorted(extra))}")
    return prices


_warned_models: set[str] = set()


def price_for(model: str | None, prices: dict[str, dict[str, float]]) -> dict[str, float]:
    """價格表沒有的模型：每個欄位各取全表最大值（寧可多記），並記一筆警告。"""
    if model and model in prices:
        return prices[model]
    if str(model) not in _warned_models:
        _warned_models.add(str(model))
        log.warning("價格表沒有模型 %s，改用各欄位的最高價格計算", model)
    return {f: max(p[f] for p in prices.values()) for f in PRICE_FIELDS}


def _max_price(a: dict[str, float], b: dict[str, float]) -> dict[str, float]:
    return {f: max(a[f], b[f]) for f in PRICE_FIELDS}


def _g(usage, name: str) -> int:
    return int(getattr(usage, name, 0) or 0)


def tokens_from_usage(usage) -> int:
    """一次問答的總 token 數 = 輸入（含快取寫入與讀取）+ 輸出。"""
    return (_g(usage, "input_tokens") + _g(usage, "cache_creation_input_tokens")
            + _g(usage, "cache_read_input_tokens") + _g(usage, "output_tokens"))


def _cost(usage, p: dict[str, float]) -> float:
    return (
        _g(usage, "input_tokens") * p["input"]
        + _g(usage, "cache_creation_input_tokens") * p["cache_write"]
        + _g(usage, "cache_read_input_tokens") * p["cache_read"]
        + _g(usage, "output_tokens") * p["output"]
    ) / 1_000_000


def cost_from_usage(usage, model: str | None, prices: dict[str, dict[str, float]],
                    requested: str | None = None) -> float:
    """依價格表把一次問答換算成美元。

    觸發 refusal fallback 時，頂層 usage 只涵蓋最後產出回覆的那一次嘗試；被拒的嘗試記在
    usage.iterations。所以有 iterations 時逐段依各段的模型計價後加總；某段沒有標模型時，
    在請求的模型（requested）與實際回覆的模型（model）之間取較貴的價格。
    """
    iterations = getattr(usage, "iterations", None) or []
    if iterations:
        fallback_price = _max_price(price_for(requested or model, prices), price_for(model or requested, prices))
        total = 0.0
        for it in iterations:
            m = getattr(it, "model", None)
            total += _cost(it, price_for(m, prices) if m else fallback_price)
        return total
    return _cost(usage, price_for(model or requested, prices))


def private_db(path: Path) -> sqlite3.Connection:
    """開啟 SQLite 資料庫檔：不存在時先以 0600 建立；已存在但其他帳號可讀時改成 0600。

    SQLite 的 journal 檔會沿用主檔的權限，所以只要處理主檔。
    """
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
    except FileExistsError:
        if path.stat().st_mode & 0o077:
            os.chmod(path, 0o600)
    return sqlite3.connect(path)


class UsageBudget:
    """全站在滾動視窗內的累計花費（美元）。"""

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
        conn = private_db(self.db_path)
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
        # 先記在記憶體（真正用來擋請求的是這份）；寫檔只是為了重啟後延續。
        # 寫檔失敗（例如磁碟滿）時只記警告，不讓已經付費的回覆變成 500。
        with self.lock:
            self.events.append((now, usd))
            self.total += usd
            self._expire(now)
        if not self.db_path:
            return
        try:
            conn = self._conn()
            try:
                conn.execute("INSERT INTO usage_cost (ts, usd) VALUES (?, ?)", (now, usd))
                conn.execute("DELETE FROM usage_cost WHERE ts < ?", (now - self.window,))
                conn.commit()
            finally:
                conn.close()
        except (sqlite3.Error, OSError) as e:
            log.warning("用量紀錄寫入失敗（只保留在記憶體）：%s", type(e).__name__)


class ClientBudget:
    """每個 client 在滾動視窗內的花費（美元）。只存在記憶體，不寫檔；key 由呼叫端先雜湊過。

    依最後一次花費的時間排序，過期的從最舊的一端清掉；key 數量有上限。
    """

    def __init__(self, limit_usd: float, window_seconds: float, max_keys: int = 100_000):
        self.limit = limit_usd
        self.window = window_seconds
        self.max_keys = max_keys
        self.spent: OrderedDict[str, deque[tuple[float, float]]] = OrderedDict()
        self.lock = threading.Lock()

    def _purge(self, now: float) -> None:
        cutoff = now - self.window
        while self.spent:
            q = next(iter(self.spent.values()))
            if q and q[-1][0] >= cutoff:
                break
            self.spent.popitem(last=False)

    def purge(self, now: float | None = None) -> None:
        with self.lock:
            self._purge(now if now is not None else time.time())

    def used(self, key: str, now: float | None = None) -> float:
        now = now if now is not None else time.time()
        with self.lock:
            self._purge(now)
            q = self.spent.get(key)
            if not q:
                return 0.0
            cutoff = now - self.window
            while q and q[0][0] < cutoff:
                q.popleft()
            return sum(usd for _, usd in q)

    def exhausted(self, key: str, now: float | None = None) -> bool:
        return self.used(key, now) >= self.limit

    def record(self, key: str, usd: float, now: float | None = None) -> None:
        now = now if now is not None else time.time()
        with self.lock:
            self._purge(now)
            q = self.spent.get(key)
            if q is None:
                if len(self.spent) >= self.max_keys:
                    self.spent.popitem(last=False)
                q = self.spent[key] = deque()
            else:
                self.spent.move_to_end(key)
            q.append((now, usd))

    def __len__(self) -> int:
        return len(self.spent)
