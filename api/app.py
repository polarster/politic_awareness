"""後端：Claude 對答代理 + 匿名作答記錄。

啟動（不輸出 access log，避免記錄 IP）：
    uvicorn app:app --no-access-log --port 8000
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional, Union

import anthropic
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from prompt import TOOLS, build_system_prompt
from usage import UsageBudget, cost_from_usage, load_prices

HERE = Path(__file__).resolve().parent

MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-5-5")
EFFORT = os.environ.get("CLAUDE_EFFORT", "low")
DATA_PATH = Path(os.environ.get("DATA_PATH", HERE.parent / "web" / "src" / "generated" / "data.json"))
LOG_DB_PATH = Path(os.environ.get("LOG_DB_PATH", HERE / "answers.sqlite3"))
ALLOWED_ORIGINS = [o for o in os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173").split(",") if o]
TRUST_PROXY = os.environ.get("TRUST_PROXY", "0") == "1"

MAX_USER_TURNS = int(os.environ.get("MAX_USER_TURNS", "20"))  # 每段對話使用者最多發言幾次
MAX_CHARS = int(os.environ.get("MAX_CHARS", "60000"))  # 整段對話的字元上限
MAX_TOKENS = int(os.environ.get("MAX_TOKENS", "8000"))
CHAT_RATE = (int(os.environ.get("CHAT_RATE_COUNT", "30")), int(os.environ.get("CHAT_RATE_WINDOW", "600")))
LOG_RATE = (5, 3600)

# 全站共用的 Claude 用量上限：USAGE_WINDOW_SECONDS 內的總花費（美元），依 PRICE_TABLE 換算
USD_BUDGET = float(os.environ.get("USD_BUDGET", "1.0"))
PRICES = load_prices(os.environ.get("PRICE_TABLE"))
USAGE_WINDOW_SECONDS = int(os.environ.get("USAGE_WINDOW_SECONDS", str(5 * 3600)))
USAGE_DB_PATH = Path(os.environ.get("USAGE_DB_PATH", HERE / "usage.sqlite3"))

DATA: dict = json.loads(DATA_PATH.read_text(encoding="utf-8"))
SYSTEM_PROMPT = build_system_prompt(DATA)
QUESTION_IDS = {q["id"] for q in DATA["questions"] + DATA["supplementary"]}
BUDGET_IDS = {b["id"] for b in DATA["budget"]["items"]}
CITY_IDS = {c["id"] for c in DATA["budget"]["cities"]}

app = FastAPI(title="politic-awareness-api", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["POST", "GET"], allow_headers=["Content-Type"],
)

_client: Optional[anthropic.Anthropic] = None


def get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic()  # 從 ANTHROPIC_API_KEY 讀取金鑰
    return _client


# ── 限流：IP 只存在記憶體中做計數，視窗過後即丟棄，不寫入任何地方 ──
class RateLimiter:
    def __init__(self, count: int, window: int):
        self.count, self.window = count, window
        self.hits: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self.lock:
            # 順手清掉過期的 key，避免記憶體中長期保留 IP
            for k in [k for k, q in self.hits.items() if not q or now - q[-1] > self.window]:
                del self.hits[k]
            q = self.hits[key]
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.count:
                return False
            q.append(now)
            return True


chat_limiter = RateLimiter(*CHAT_RATE)
log_limiter = RateLimiter(*LOG_RATE)
token_budget = UsageBudget(USD_BUDGET, USAGE_WINDOW_SECONDS, USAGE_DB_PATH)


def client_key(request: Request) -> str:
    if TRUST_PROXY:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# ── Claude 對答 ──
class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: Union[str, list[dict[str, Any]]]


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1)


def validate_conversation(msgs: list[ChatMessage]) -> None:
    if msgs[0].role != "user" or msgs[-1].role != "user":
        raise HTTPException(400, "對話格式錯誤")
    for a, b in zip(msgs, msgs[1:]):
        if a.role == b.role:
            raise HTTPException(400, "對話格式錯誤")
    user_turns = sum(1 for m in msgs if m.role == "user" and isinstance(m.content, str))
    if user_turns > MAX_USER_TURNS:
        raise HTTPException(429, f"這段對話已達 {MAX_USER_TURNS} 則訊息的上限，請重新開始一段對話。")
    size = sum(len(m.content) if isinstance(m.content, str) else len(json.dumps(m.content, ensure_ascii=False))
               for m in msgs)
    if size > MAX_CHARS:
        raise HTTPException(413, "這段對話太長了，請重新開始一段對話。")


@app.post("/api/chat")
def chat(req: ChatRequest, request: Request):
    if not chat_limiter.allow(client_key(request)):
        raise HTTPException(429, "請求太頻繁，請稍後再試。")
    validate_conversation(req.messages)
    if token_budget.exhausted():
        raise HTTPException(429, "Claude 對答的用量已達這 5 小時的上限，請稍後再來。")
    try:
        resp = get_client().beta.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            tools=TOOLS,
            messages=[m.model_dump() for m in req.messages],
            output_config={"effort": EFFORT},
            cache_control={"type": "ephemeral"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.RateLimitError:
        raise HTTPException(503, "目前使用的人比較多，請稍後再試。")
    except anthropic.BadRequestError as e:
        raise HTTPException(400, f"請求無法處理：{e.message}")
    except anthropic.APIStatusError:
        raise HTTPException(502, "Claude 暫時無法回應，請稍後再試。")
    except anthropic.APIConnectionError:
        raise HTTPException(502, "無法連線到 Claude，請稍後再試。")

    # 若觸發 refusal fallback，resp.model 是實際服務的模型
    token_budget.record(cost_from_usage(resp.usage, getattr(resp, "model", None) or MODEL, PRICES))

    if resp.stop_reason == "refusal":
        raise HTTPException(409, "Claude 無法回應這則訊息，請換個方式說說看。")
    content = [b.to_dict() for b in resp.content]
    if not content:
        raise HTTPException(502, "Claude 沒有產生回覆，請再試一次。")
    return {"content": content, "stop_reason": resp.stop_reason, "usage_percent": token_budget.percent()}


@app.get("/api/usage")
def usage():
    """全站 5 小時用量百分比（不透露實際數量）。"""
    return {"percent": token_budget.percent()}


# ── 匿名作答記錄 ──
class LogAnswer(BaseModel):
    v: Optional[int] = Field(default=None, ge=-2, le=2)
    imp: bool = False


class LogAdjustment(BaseModel):
    type: Literal["answer_change", "importance_change", "supplementary_answer"]
    question: str
    from_: Optional[int] = Field(default=None, alias="from", ge=-2, le=2)
    to: Union[bool, int, None] = None


class LogRecord(BaseModel):
    quiz_version: str = Field(max_length=40)
    city: Optional[str] = None
    answers: dict[str, LogAnswer]
    budget: Optional[dict[str, int]] = None
    adjustments: list[LogAdjustment] = Field(default_factory=list, max_length=200)


_db_lock = threading.Lock()


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(LOG_DB_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS answers ("
        " id INTEGER PRIMARY KEY, hour TEXT NOT NULL, quiz_version TEXT NOT NULL, payload TEXT NOT NULL)"
    )
    return conn


@app.post("/api/log")
def log_answers(rec: LogRecord, request: Request):
    if not log_limiter.allow(client_key(request)):
        raise HTTPException(429, "請求太頻繁，請稍後再試。")
    if rec.quiz_version != DATA["version"]:
        raise HTTPException(400, "題庫版本不符")
    if set(rec.answers) - QUESTION_IDS:
        raise HTTPException(400, "包含未知的題目")
    if rec.city is not None and rec.city not in CITY_IDS:
        raise HTTPException(400, "未知的城市")
    if rec.budget is not None:
        if set(rec.budget) - BUDGET_IDS or any(not -2 <= v <= 2 for v in rec.budget.values()):
            raise HTTPException(400, "預算資料格式錯誤")
    if any(a.question not in QUESTION_IDS for a in rec.adjustments):
        raise HTTPException(400, "包含未知的題目")

    # 時間只記到小時（UTC），不記 IP、User-Agent 或任何識別資訊
    hour = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H")
    payload = rec.model_dump(by_alias=True, exclude={"quiz_version"})
    with _db_lock:
        conn = db()
        try:
            conn.execute(
                "INSERT INTO answers (hour, quiz_version, payload) VALUES (?, ?, ?)",
                (hour, rec.quiz_version, json.dumps(payload, ensure_ascii=False)),
            )
            conn.commit()
        finally:
            conn.close()
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"ok": True, "model": MODEL, "quiz_version": DATA["version"]}
