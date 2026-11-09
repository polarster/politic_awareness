"""後端：Claude 對答代理 + 匿名作答記錄。

設定只讀 PA_ 開頭的環境變數（見 .env.example）。建議用乾淨的環境啟動，金鑰從檔案讀取、不出現在指令列，
不輸出 access log（避免記錄 IP），不信任 X-Forwarded-For，只綁本機：

    env -i PATH=/usr/bin:/bin HOME="$HOME" LANG=C.UTF-8 \\
      PA_ANTHROPIC_API_KEY_FILE=../.keys/claude_api.key PA_CLIENT_IP_HEADER=cf-connecting-ip \\
      .venv/bin/uvicorn app:app --no-access-log --no-proxy-headers --host 127.0.0.1 --port 8000
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from collections import OrderedDict, deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, Literal, Optional, Union

import anthropic
from fastapi import FastAPI, HTTPException, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, model_validator
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException as StarletteHTTPException

from prompt import TOOLS, build_system_prompt
from usage import ClientBudget, UsageBudget, cost_from_usage, load_prices, private_db

HERE = Path(__file__).resolve().parent
log = logging.getLogger("uvicorn.error")


# ── 設定：只讀 PA_ 開頭的環境變數（避免和 Claude Code 等工具的同名變數撞名） ──
def _env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return default if v is None or v == "" else v


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        v = int(raw)
    except ValueError:
        raise RuntimeError(f"{name} 必須是整數") from None
    if v < minimum:
        raise RuntimeError(f"{name} 必須大於或等於 {minimum}")
    return v


def _env_float(name: str, default: float, minimum: float = 0.0, maximum: Optional[float] = None) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        v = float(raw)
    except ValueError:
        raise RuntimeError(f"{name} 必須是數字") from None
    if not (v >= minimum and (maximum is None or v <= maximum)):
        raise RuntimeError(f"{name} 超出允許範圍")
    return v


ALLOWED_EFFORTS = ("low", "medium", "high")
MODEL = _env("PA_CLAUDE_MODEL", "claude-sonnet-5-5")
EFFORT = _env("PA_CLAUDE_EFFORT", "medium")
if EFFORT not in ALLOWED_EFFORTS:
    raise RuntimeError(f"PA_CLAUDE_EFFORT 只接受 {'、'.join(ALLOWED_EFFORTS)}，目前是 {EFFORT!r}")
if not re.fullmatch(r"[a-z0-9][a-z0-9.\-]{1,63}", MODEL):
    raise RuntimeError(f"PA_CLAUDE_MODEL 格式不正確：{MODEL!r}")

DATA_PATH = Path(_env("PA_DATA_PATH", str(HERE.parent / "web" / "src" / "generated" / "data.json")))
LOG_DB_PATH = Path(_env("PA_LOG_DB_PATH", str(HERE / "answers.sqlite3")))
USAGE_DB_PATH = Path(_env("PA_USAGE_DB_PATH", str(HERE / "usage.sqlite3")))
ALLOWED_ORIGINS = [o.strip() for o in _env("PA_ALLOWED_ORIGINS", "http://localhost:5173").split(",") if o.strip()]
# 反向代理放真實 client IP 的單一標頭（例如 cf-connecting-ip、fly-client-ip）。只能設定代理一定會覆寫的標頭；
# 沒設定時用連線的來源位址。uvicorn 要加 --no-proxy-headers，才不會改用使用者可偽造的 X-Forwarded-For。
CLIENT_IP_HEADER = _env("PA_CLIENT_IP_HEADER", "").strip().lower() or None

MAX_USER_TURNS = _env_int("PA_MAX_USER_TURNS", 20)  # 每段對話使用者最多發言幾次（工具結果不算）
MAX_CHARS = _env_int("PA_MAX_CHARS", 60000)  # 整段對話的字數上限；UTF-8 位元組另以 3 倍為上限
MAX_TOKENS = _env_int("PA_MAX_TOKENS", 8000)
CHAT_RATE = (_env_int("PA_CHAT_RATE_COUNT", 30), _env_int("PA_CHAT_RATE_WINDOW", 600))
LOG_RATE = (5, 3600)
MAX_CONCURRENT_CHATS = _env_int("PA_MAX_CONCURRENT_CHATS", 2)  # 全站同時進行的 Claude 呼叫上限
LOG_DAILY_LIMIT = _env_int("PA_LOG_DAILY_LIMIT", 500)  # 每天最多新增幾筆匿名作答

# 全站 Claude 用量上限：PA_USAGE_WINDOW_SECONDS 內的總花費（美元），依價格表換算；
# 每個 client 另有子額度（全站額度的 PA_CLIENT_BUDGET_FRACTION），只存在記憶體
USD_BUDGET = _env_float("PA_USD_BUDGET", 1.0)
CLIENT_BUDGET_FRACTION = _env_float("PA_CLIENT_BUDGET_FRACTION", 0.2, minimum=0.01, maximum=1.0)
PRICES = load_prices(os.environ.get("PA_PRICE_TABLE"))
USAGE_WINDOW_SECONDS = _env_int("PA_USAGE_WINDOW_SECONDS", 5 * 3600)
API_KEY_FILE = os.environ.get("PA_ANTHROPIC_API_KEY_FILE") or None

# 舊的設定名稱已不再讀取；啟動時提醒（只列名稱，不印出值）
OLD_ENV_NAMES = (
    "CLAUDE_MODEL", "CLAUDE_EFFORT", "DATA_PATH", "LOG_DB_PATH", "USAGE_DB_PATH", "ALLOWED_ORIGINS", "TRUST_PROXY",
    "MAX_USER_TURNS", "MAX_CHARS", "MAX_TOKENS", "CHAT_RATE_COUNT", "CHAT_RATE_WINDOW", "USD_BUDGET", "PRICE_TABLE",
    "USAGE_WINDOW_SECONDS",
)

# 請求 body 上限（在解析之前就擋下）。對話會原樣帶著每一輪 thinking 的 signature，
# 很長的對話若因此被擋（「這段對話太長了」），可以調高 PA_CHAT_MAX_BODY_BYTES
CHAT_BODY_LIMIT = _env_int("PA_CHAT_MAX_BODY_BYTES", 256 * 1024, minimum=16 * 1024)
LOG_BODY_LIMIT = 64 * 1024
OTHER_BODY_LIMIT = 16 * 1024
LOG_PAYLOAD_LIMIT = 32 * 1024  # 寫入資料庫的單筆紀錄上限

# Claude 呼叫逾時（SDK 預設 10 分鐘、重試 2 次；卡住的請求會一直佔著同時呼叫的名額）
CLAUDE_TIMEOUT = 300.0
CLAUDE_MAX_RETRIES = 1


def _window_text(seconds: int) -> str:
    if seconds % 3600 == 0:
        return f"{seconds // 3600} 小時"
    return f"{max(1, seconds // 60)} 分鐘"


WINDOW_TEXT = _window_text(USAGE_WINDOW_SECONDS)


def _read_api_key(path: Optional[str]) -> Optional[str]:
    """PA_ANTHROPIC_API_KEY_FILE 指向的金鑰檔（建議 chmod 600）。沒設定時交給 SDK 讀 ANTHROPIC_API_KEY。"""
    if not path:
        return None
    p = Path(path)
    try:
        key = p.read_text(encoding="utf-8").strip()
    except OSError as e:
        raise RuntimeError(f"讀不到 PA_ANTHROPIC_API_KEY_FILE 指向的檔案（{type(e).__name__}）") from None
    if not key:
        raise RuntimeError("PA_ANTHROPIC_API_KEY_FILE 指向的檔案是空的")
    if p.stat().st_mode & 0o077:
        log.warning("金鑰檔 %s 其他帳號也能讀取，建議 chmod 600", p.name)
    return key


_API_KEY = _read_api_key(API_KEY_FILE)


# ── 題庫與立場資料：data.json 在磁碟上改變時自動重新載入 ──
@dataclass(frozen=True)
class Loaded:
    data: dict
    version: str
    data_hash: Optional[str]
    system_prompt: str
    question_ids: frozenset  # 主問卷 + 補充題
    main_ids: frozenset
    supplementary_ids: frozenset
    budget_ids: frozenset
    city_ids: frozenset

    @classmethod
    def build(cls, data: dict) -> "Loaded":
        main = frozenset(q["id"] for q in data["questions"])
        supp = frozenset(q["id"] for q in data["supplementary"])
        return cls(
            data=data,
            version=str(data["version"]),
            data_hash=data.get("data_hash"),
            system_prompt=build_system_prompt(data),
            question_ids=main | supp,
            main_ids=main,
            supplementary_ids=supp,
            budget_ids=frozenset(b["id"] for b in data["budget"]["items"]),
            city_ids=frozenset(c["id"] for c in data["budget"]["cities"]),
        )


class DataStore:
    """每次使用前檢查檔案的 mtime／大小／inode；有變就重新載入（題目、立場、system prompt 一起更新）。

    讀到寫到一半或格式錯誤的檔案時保留舊資料，等檔案再變動時重試。
    """

    def __init__(self, path: Path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self._sig = self._signature()
        self._failed_sig = None
        self._loaded = Loaded.build(json.loads(self.path.read_text(encoding="utf-8")))

    def _signature(self) -> tuple[int, int, int]:
        st = self.path.stat()
        return (st.st_mtime_ns, st.st_size, st.st_ino)

    def current(self) -> Loaded:
        try:
            sig = self._signature()
        except OSError:
            return self._loaded
        if sig == self._sig or sig == self._failed_sig:
            return self._loaded
        with self.lock:
            if sig != self._sig and sig != self._failed_sig:
                try:
                    loaded = Loaded.build(json.loads(self.path.read_text(encoding="utf-8")))
                except Exception as e:  # noqa: BLE001 — 任何錯誤都保留舊資料
                    self._failed_sig = sig
                    log.warning("重新載入 %s 失敗，繼續使用舊資料（%s）", self.path.name, type(e).__name__)
                    return self._loaded
                self._loaded, self._sig, self._failed_sig = loaded, sig, None
                log.info("已重新載入資料：題庫版本 %s", loaded.version)
        return self._loaded


store = DataStore(DATA_PATH)


# ── 限流：key 是加鹽雜湊過的 client IP，只存在記憶體；依最後一次命中排序，過期的從最舊的一端清掉 ──
class RateLimiter:
    def __init__(self, count: int, window: float, max_keys: int = 100_000):
        self.count, self.window, self.max_keys = count, window, max_keys
        self.hits: OrderedDict[str, deque] = OrderedDict()
        self.lock = threading.Lock()

    def _purge(self, now: float) -> None:
        while self.hits:
            q = next(iter(self.hits.values()))
            if q and now - q[-1] <= self.window:
                break
            self.hits.popitem(last=False)

    def purge(self, now: Optional[float] = None) -> None:
        with self.lock:
            self._purge(time.monotonic() if now is None else now)

    def allow(self, key: str, now: Optional[float] = None) -> bool:
        now = time.monotonic() if now is None else now
        with self.lock:
            self._purge(now)  # 每次只從最舊的一端清，攤銷 O(1)
            q = self.hits.get(key)
            if q is not None:
                while q and now - q[0] > self.window:
                    q.popleft()
                if len(q) >= self.count:
                    return False
                self.hits.move_to_end(key)
            else:
                if len(self.hits) >= self.max_keys:
                    self.hits.popitem(last=False)  # key 太多時丟掉最久沒出現的
                q = self.hits[key] = deque()
            q.append(now)
            return True

    def __len__(self) -> int:
        return len(self.hits)


class ChatSlots:
    """同時進行中的 Claude 呼叫：全站最多 total 個，每個 client 最多 1 個。

    花費要等 Claude 回覆後才知道（先檢查額度、後記帳）。限制同時進行的數量，並在取得名額後再檢查一次額度
    （見 chat()），同時送出的請求最多只會讓額度超支這幾次呼叫的費用。
    """

    def __init__(self, total: int):
        self.total = total
        self.active: set[str] = set()
        self.anonymous = 0  # 無法分辨個別 client 的請求（例如都從本機代理進來）
        self.lock = threading.Lock()

    def acquire(self, key: Optional[str]) -> Optional[str]:
        """成功回傳 None；失敗回傳原因："client"（同一個 client 已有請求）或 "full"（全站已滿）。"""
        with self.lock:
            if key is not None and key in self.active:
                return "client"
            if len(self.active) + self.anonymous >= self.total:
                return "full"
            if key is None:
                self.anonymous += 1
            else:
                self.active.add(key)
            return None

    def release(self, key: Optional[str]) -> None:
        with self.lock:
            if key is None:
                self.anonymous = max(0, self.anonymous - 1)
            else:
                self.active.discard(key)


chat_limiter = RateLimiter(*CHAT_RATE)
log_limiter = RateLimiter(*LOG_RATE)
chat_slots = ChatSlots(MAX_CONCURRENT_CHATS)
token_budget = UsageBudget(USD_BUDGET, USAGE_WINDOW_SECONDS, USAGE_DB_PATH)
client_budget = ClientBudget(USD_BUDGET * CLIENT_BUDGET_FRACTION, USAGE_WINDOW_SECONDS)

_KEY_SALT = secrets.token_bytes(16)  # 每次啟動隨機產生，不寫入任何地方


def _normalize_ip(value: str) -> Optional[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        ip = ipaddress.ip_address(value.strip())
    except ValueError:
        return None
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        return ip.ipv4_mapped
    return ip


def client_identity(request: Request) -> tuple[str, bool]:
    """回傳（key, 是否能代表單一 client）。

    IP 取自 PA_CLIENT_IP_HEADER 指定的標頭（必須是合法 IP），否則用連線來源位址；IPv6 以 /64 為單位。
    key 是加鹽的 HMAC，記憶體裡不留原始 IP。來源是本機（例如經 Vite／cloudflared 轉送卻沒設定標頭）時，
    所有人會共用同一個 key，這時不套用「每個 client」的子額度與同時請求限制，以免變成全站上限。
    """
    ip = None
    if CLIENT_IP_HEADER:
        raw = request.headers.get(CLIENT_IP_HEADER)
        if raw:
            ip = _normalize_ip(raw)
    if ip is None:
        host = request.client.host if request.client else ""
        ip = _normalize_ip(host) if host else None
        if ip is None:
            return _hash_key(host or "unknown"), False
    if isinstance(ip, ipaddress.IPv6Address):
        text = f"{ipaddress.IPv6Address(int(ip) >> 64 << 64)}/64"
    else:
        text = str(ip)
    return _hash_key(text), not (ip.is_loopback or ip.is_unspecified)


def _hash_key(text: str) -> str:
    return hmac.new(_KEY_SALT, text.encode("utf-8", "surrogatepass"), hashlib.sha256).hexdigest()[:24]


def client_key(request: Request) -> str:
    return client_identity(request)[0]


def _limiter_for(path: str) -> Optional[RateLimiter]:
    if path == "/api/chat":
        return chat_limiter
    if path == "/api/log":
        return log_limiter
    return None


class EarlyRateLimit:
    """在讀取與解析 body 之前先限流：被擋下的請求不會被解析，也不佔用執行緒。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope.get("method") == "POST":
            limiter = _limiter_for(scope.get("path", ""))
            if limiter is not None and not limiter.allow(client_key(Request(scope))):
                await JSONResponse({"detail": "請求太頻繁，請稍後再試。"}, status_code=429)(scope, receive, send)
                return
        await self.app(scope, receive, send)


class _BodyTooLarge(StarletteHTTPException):
    def __init__(self) -> None:
        super().__init__(status_code=413, detail="Content Too Large")


def _too_large(path: str) -> JSONResponse:
    msg = "這段對話太長了，請重新開始一段對話。" if path == "/api/chat" else "送出的資料太大了。"
    return JSONResponse({"detail": msg}, status_code=413)


class PathBodyLimit:
    """依路徑限制 body 大小，在解析之前就擋下：Content-Length 超過就直接回 413（不讀 body）；
    沒有 Content-Length 的 chunked 上傳，累計超過時中止讀取。"""

    def __init__(self, app, limits: dict[str, int], default: int):
        self.app = app
        self.limits = limits
        self.default = default

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        limit = self.limits.get(path, self.default)
        declared = Headers(scope=scope).get("content-length")
        if declared is not None:
            try:
                too_large = int(declared) > limit
            except ValueError:
                too_large = True
            if too_large:
                return await _too_large(path)(scope, receive, send)

        total = 0
        started = False

        async def limited_receive():
            nonlocal total
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > limit:
                    raise _BodyTooLarge()  # FastAPI 讀 body 時拋出，由下面的 _http_error 轉成 JSON
            return message

        async def tracking_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except _BodyTooLarge:
            if started:
                raise
            await _too_large(path)(scope, receive, send)


async def _purge_loop() -> None:
    # 沒有新請求時也定期清掉過期的 key，不讓 IP 雜湊長留在記憶體
    while True:
        await asyncio.sleep(60)
        chat_limiter.purge()
        log_limiter.purge()
        client_budget.purge()


@asynccontextmanager
async def lifespan(app: FastAPI):
    d = store.current()
    log.info("Claude 設定：model=%s effort=%s max_tokens=%d；題庫版本 %s", MODEL, EFFORT, MAX_TOKENS, d.version)
    ignored = [n for n in OLD_ENV_NAMES if n in os.environ]
    if ignored:
        log.warning("這些舊的環境變數已不再讀取，請改用 PA_ 開頭的名稱：%s", ", ".join(ignored))
    if not CLIENT_IP_HEADER:
        log.warning("未設定 PA_CLIENT_IP_HEADER：經反向代理進來的請求會共用同一個限流 key")
    task = asyncio.create_task(_purge_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="politic-awareness-api", docs_url=None, redoc_url=None, lifespan=lifespan)
# add_middleware 後加的在外層：CORS 最外層（429／413 也帶 CORS 標頭），接著限流，再來 body 上限
app.add_middleware(PathBodyLimit, limits={"/api/chat": CHAT_BODY_LIMIT, "/api/log": LOG_BODY_LIMIT},
                   default=OTHER_BODY_LIMIT)
app.add_middleware(EarlyRateLimit)
app.add_middleware(
    CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["POST", "GET"], allow_headers=["Content-Type"],
)


@app.exception_handler(RequestValidationError)
async def _validation_error(request: Request, exc: RequestValidationError):
    # FastAPI 預設會把每個錯誤的輸入原樣附在回應裡（小請求就能放大成好幾 MB），這裡只回固定訊息
    msg = "對話格式錯誤，請重新開始一段對話。" if request.url.path == "/api/chat" else "送出的資料格式不正確。"
    return JSONResponse({"detail": msg}, status_code=422)


@app.exception_handler(StarletteHTTPException)
async def _http_error(request: Request, exc: StarletteHTTPException):
    if isinstance(exc, _BodyTooLarge):
        return _too_large(request.url.path)
    return await http_exception_handler(request, exc)


_client: Optional[anthropic.Anthropic] = None
_client_lock = threading.Lock()


def get_client() -> anthropic.Anthropic:
    global _client
    with _client_lock:
        if _client is None:
            kw: dict[str, Any] = {"timeout": CLAUDE_TIMEOUT, "max_retries": CLAUDE_MAX_RETRIES}
            if _API_KEY:
                kw["api_key"] = _API_KEY
            _client = anthropic.Anthropic(**kw)  # 沒有金鑰檔時從 ANTHROPIC_API_KEY 讀取
    return _client


# ── Claude 對答：只放行前端實際會送的格式 ──
TOOL_PROPS = {t["name"]: frozenset(t["input_schema"]["properties"]) for t in TOOLS}
ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
UUID4_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
FIRST_MESSAGE_CHARS = 16_000  # 第一則：作答摘要 + 使用者文字（目前最長約 6,000 字）
USER_TEXT_CHARS = 8_000  # 之後的使用者文字（輸入框上限 2,000 字；送出失敗時前端會把下一段併進同一則）
TOOL_RESULT_CHARS = 4_000
ASSISTANT_TEXT_CHARS = 40_000
MAX_MESSAGES = 4 * MAX_USER_TURNS + 1  # 含工具往返的總訊息數
MAX_BLOCKS = 64
ACCOUNT_ERROR_CODES = {"organization_on_hold", "workspace_policy_violation"}


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TextBlock(_Strict):
    type: Literal["text"]
    text: StrictStr = Field(max_length=ASSISTANT_TEXT_CHARS)
    citations: Optional[list[Any]] = Field(default=None, max_length=0)  # 回覆會帶 null，原樣送回；不接受引用內容


class ThinkingBlock(_Strict):
    type: Literal["thinking"]
    thinking: StrictStr = Field(max_length=ASSISTANT_TEXT_CHARS)
    signature: StrictStr


class RedactedThinkingBlock(_Strict):
    type: Literal["redacted_thinking"]
    data: StrictStr


class DirectCaller(_Strict):
    type: Literal["direct"]


class ToolUseBlock(_Strict):
    type: Literal["tool_use"]
    id: str = Field(pattern=ID_PATTERN)
    name: StrictStr
    input: dict[str, Union[StrictBool, StrictInt, Annotated[StrictStr, Field(max_length=4000)]]]
    caller: Optional[DirectCaller] = None
    toolset_name: None = None

    @model_validator(mode="after")
    def _known_tool(self):
        props = TOOL_PROPS.get(self.name)
        if props is None or not set(self.input) <= props:
            raise ValueError("未知的工具或參數")
        return self


class FallbackModel(_Strict):
    model: str = Field(pattern=r"^[A-Za-z0-9._-]{1,64}$")


class FallbackBlock(_Strict):
    """refusal fallback 的分界標記：要放在原本的位置原樣送回（伺服器靠它驗證前後的 thinking）。"""
    type: Literal["fallback"]
    from_: FallbackModel = Field(alias="from")
    to: FallbackModel
    trigger: Optional[dict[str, Any]] = None


class ToolResultBlock(_Strict):
    type: Literal["tool_result"]
    tool_use_id: str = Field(pattern=ID_PATTERN)
    content: StrictStr = Field(max_length=TOOL_RESULT_CHARS)
    is_error: Optional[StrictBool] = None


class UserTextBlock(_Strict):
    type: Literal["text"]
    text: StrictStr = Field(max_length=USER_TEXT_CHARS)


AssistantBlock = Annotated[
    Union[TextBlock, ThinkingBlock, RedactedThinkingBlock, ToolUseBlock, FallbackBlock], Field(discriminator="type")
]
UserBlock = Annotated[Union[ToolResultBlock, UserTextBlock], Field(discriminator="type")]


class UserMessage(_Strict):
    role: Literal["user"]
    content: Union[Annotated[StrictStr, Field(max_length=FIRST_MESSAGE_CHARS)],
                   Annotated[list[UserBlock], Field(min_length=1, max_length=MAX_BLOCKS + 1)]]


class AssistantMessage(_Strict):
    role: Literal["assistant"]
    content: Union[Annotated[StrictStr, Field(min_length=1, max_length=ASSISTANT_TEXT_CHARS)],
                   Annotated[list[AssistantBlock], Field(min_length=1, max_length=MAX_BLOCKS)]]


ChatMessage = Annotated[Union[UserMessage, AssistantMessage], Field(discriminator="role")]


class ChatRequest(_Strict):
    messages: list[ChatMessage] = Field(min_length=1, max_length=2 * MAX_MESSAGES)
    # 前端為每段對話隨機產生的 UUID，只當作 metadata.user_id 傳給 Anthropic（讓濫用能歸到單一對話），不存檔
    conversation_id: Optional[str] = Field(default=None, pattern=UUID4_PATTERN)


def _bad_conversation() -> HTTPException:
    return HTTPException(400, "對話格式錯誤，請重新開始一段對話。")


def validate_conversation(msgs: list) -> list[dict]:
    """檢查對話結構與長度，回傳要送給 Claude 的 messages（只含白名單內的欄位）。"""
    if msgs[0].role != "user" or msgs[-1].role != "user" or not isinstance(msgs[0].content, str):
        raise _bad_conversation()
    for a, b in zip(msgs, msgs[1:]):
        if a.role == b.role:
            raise _bad_conversation()
    if len(msgs) > MAX_MESSAGES:
        raise HTTPException(429, "這段對話已達上限，請重新開始一段對話。")

    texts: list[str] = []  # 計入長度上限的文字
    user_turns = 0
    for i, m in enumerate(msgs):
        if m.role == "assistant":
            if isinstance(m.content, str):
                texts.append(m.content)
                continue
            for b in m.content:
                if b.type in ("text", "thinking"):
                    texts.append(b.text if b.type == "text" else b.thinking)
                elif b.type == "tool_use":
                    texts.append(json.dumps(b.input, ensure_ascii=False))
            continue
        prev_uses = [] if i == 0 or isinstance(msgs[i - 1].content, str) else \
            [b.id for b in msgs[i - 1].content if b.type == "tool_use"]
        if len(set(prev_uses)) != len(prev_uses):
            raise _bad_conversation()
        if isinstance(m.content, str):
            if prev_uses:  # 上一則有工具呼叫時，這一則必須先回工具結果
                raise _bad_conversation()
            text = m.content
        else:
            # 工具結果在前（剛好對應上一則的工具呼叫），最多再接一段使用者文字
            k = 0
            while k < len(m.content) and m.content[k].type == "tool_result":
                k += 1
            rest = m.content[k:]
            if not prev_uses or k == 0 or len(rest) > 1:
                raise _bad_conversation()
            if sorted(b.tool_use_id for b in m.content[:k]) != sorted(prev_uses):
                raise _bad_conversation()
            texts.extend(b.content for b in m.content[:k])
            text = rest[0].text if rest else None
        if text is not None:
            if not text.strip():
                raise _bad_conversation()
            if len(text) > (FIRST_MESSAGE_CHARS if i == 0 else USER_TEXT_CHARS):
                raise HTTPException(413, "這則訊息太長了，請縮短一點再送出。")
            texts.append(text)
            user_turns += 1

    if user_turns > MAX_USER_TURNS:
        raise HTTPException(429, f"這段對話已達 {MAX_USER_TURNS} 則訊息的上限，請重新開始一段對話。")

    api_messages = [m.model_dump(by_alias=True, exclude_unset=True) for m in msgs]
    # 和 SDK 一樣序列化一次：NaN、孤立的 surrogate 等會讓 SDK 丟例外（原本變成 500）
    try:
        json.dumps(api_messages, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (ValueError, UnicodeEncodeError):
        raise _bad_conversation() from None

    chars = sum(len(t) for t in texts)
    nbytes = sum(len(t.encode("utf-8")) for t in texts)
    if chars > MAX_CHARS or nbytes > 3 * MAX_CHARS:
        raise HTTPException(413, "這段對話太長了，請重新開始一段對話。")
    return api_messages


ECHO_BLOCK_TYPES = {"text", "thinking", "redacted_thinking", "tool_use", "fallback"}


def _check_budget(key: str, distinct: bool) -> None:
    """全站額度與這個 client 的子額度都還沒用完才放行。"""
    if token_budget.exhausted():
        raise HTTPException(429, f"Claude 對答的用量已達這 {WINDOW_TEXT}的上限，請稍後再來。")
    if distinct and client_budget.exhausted(key):
        raise HTTPException(429, f"你在這 {WINDOW_TEXT}內的對答用量已達上限，請稍後再來。")


@app.post("/api/chat")
def chat(req: ChatRequest, request: Request):
    # 每個 client 的限流已在 EarlyRateLimit 做過（解析 body 之前）
    d = store.current()
    api_messages = validate_conversation(req.messages)
    key, distinct = client_identity(request)
    _check_budget(key, distinct)  # 額度已用完時直接回「用量已達上限」，不佔名額
    busy = chat_slots.acquire(key if distinct else None)
    if busy == "client":
        raise HTTPException(429, "上一則訊息還在處理中，請等回覆出現後再送出。")
    if busy == "full":
        raise HTTPException(503, "目前使用的人比較多，請稍後再試。")
    try:
        # 拿到名額後再檢查一次：上面檢查完到拿到名額之間，別的請求可能剛記帳用完額度、釋放名額。
        # 記帳都在釋放名額之前，所以會呼叫 Claude 的請求都看得到先前每一筆花費，超支最多是同時進行的那幾次
        _check_budget(key, distinct)
        extra: dict[str, Any] = {}
        if req.conversation_id:
            extra["metadata"] = {"user_id": req.conversation_id}
        try:
            resp = get_client().beta.messages.create(
                model=MODEL,
                max_tokens=MAX_TOKENS,
                system=[{"type": "text", "text": d.system_prompt, "cache_control": {"type": "ephemeral"}}],
                tools=TOOLS,
                messages=api_messages,
                output_config={"effort": EFFORT},
                cache_control={"type": "ephemeral"},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                **extra,
            )
        except anthropic.RateLimitError:
            raise HTTPException(503, "目前使用的人比較多，請稍後再試。") from None
        except anthropic.BadRequestError as e:
            # 只在伺服器端記 SDK 拆好的欄位；不回傳原文（含 request_id 與錯誤細節），也不記 e.message（可能夾帶使用者內容）
            log.warning("anthropic 400 type=%s code=%s req=%s", e.type, e.error_code, e.request_id)
            if e.error_code in ACCOUNT_ERROR_CODES:
                raise HTTPException(503, "對答功能暫時休息中，請稍後再來。") from None
            raise HTTPException(400, "這則訊息無法處理，請重新開始一段對話。") from None
        except anthropic.APIStatusError as e:
            log.warning("anthropic %s type=%s code=%s req=%s", e.status_code, e.type, e.error_code, e.request_id)
            raise HTTPException(502, "Claude 暫時無法回應，請稍後再試。") from None
        except anthropic.APIConnectionError:
            raise HTTPException(502, "無法連線到 Claude，請稍後再試。") from None

        # 觸發 refusal fallback 時，被拒的嘗試也會計費，記在 usage.iterations；resp.model 是實際回覆的模型
        cost = cost_from_usage(resp.usage, getattr(resp, "model", None) or MODEL, PRICES, requested=MODEL)
        token_budget.record(cost)
        if distinct:
            client_budget.record(key, cost)
    finally:
        chat_slots.release(key if distinct else None)

    if resp.stop_reason == "refusal":
        raise HTTPException(409, "Claude 無法回應這則訊息，請換個方式說說看。")
    content, dropped = [], set()
    for b in resp.content:
        if b.type in ECHO_BLOCK_TYPES:
            content.append(b.to_dict())
        else:
            dropped.add(b.type)
    if dropped:
        log.warning("略過不支援的回覆區塊：%s", ", ".join(sorted(dropped)))
    if not content:
        raise HTTPException(502, "Claude 沒有產生回覆，請再試一次。")
    return {"content": content, "stop_reason": resp.stop_reason, "usage_percent": token_budget.percent()}


@app.get("/api/usage")
def usage():
    """全站用量百分比（不透露實際數量）。"""
    return {"percent": token_budget.percent()}


# ── 匿名作答記錄 ──
Score = Annotated[int, Field(strict=True, ge=-2, le=2)]
QuestionId = Annotated[str, Field(max_length=32)]


class LogAnswer(_Strict):
    v: Optional[Score] = None
    imp: StrictBool = False


class AnswerChangeAdj(_Strict):
    type: Literal["answer_change"]
    question: QuestionId
    from_: Optional[Score] = Field(default=None, alias="from")
    to: Score


class ImportanceChangeAdj(_Strict):
    type: Literal["importance_change"]
    question: QuestionId
    to: StrictBool


class SupplementaryAnswerAdj(_Strict):
    type: Literal["supplementary_answer"]
    question: QuestionId
    to: Optional[Score]


LogAdjustment = Annotated[
    Union[AnswerChangeAdj, ImportanceChangeAdj, SupplementaryAnswerAdj], Field(discriminator="type")
]


class LogRecord(_Strict):
    # 前端每輪作答隨機產生的 UUID：重送同一輪時覆蓋同一筆。資料庫只存它的 SHA-256
    submission_id: str = Field(pattern=UUID4_PATTERN)
    quiz_version: str = Field(max_length=64)
    city: Optional[Annotated[str, Field(max_length=32)]] = None
    answers: dict[QuestionId, LogAnswer] = Field(min_length=1, max_length=300)
    budget: Optional[dict[QuestionId, Score]] = Field(default=None, max_length=100)
    adjustments: list[LogAdjustment] = Field(default_factory=list, max_length=300)
    mode: Literal["simple", "full"] = "simple"
    # 完成思辨旅程時：第一輪的答案（第一直覺）
    first_answers: Optional[dict[QuestionId, LogAnswer]] = Field(default=None, max_length=300)
    # 思辨旅程是否在看過結果之後才進行（可能受結果影響）
    journey_after_results: Optional[StrictBool] = None


_db_lock = threading.Lock()
_last_vacuum_day: Optional[str] = None


def answers_db() -> sqlite3.Connection:
    """匿名作答資料庫（0600）。主鍵是隨機的雜湊值、沒有 rowid，資料表本身不保留送出順序。"""
    conn = private_db(LOG_DB_PATH)
    conn.execute("PRAGMA secure_delete = ON")  # 覆蓋或刪除的內容會被清零，不留在檔案的空頁裡
    conn.execute(
        "CREATE TABLE IF NOT EXISTS answers ("
        " id TEXT PRIMARY KEY, day TEXT NOT NULL, quiz_version TEXT NOT NULL, payload TEXT NOT NULL"
        ") WITHOUT ROWID"
    )
    # 每日上限的計數用；索引依（日期, 隨機 id）排序，不反映寫入順序
    conn.execute("CREATE INDEX IF NOT EXISTS answers_day ON answers(day)")
    return conn


@app.post("/api/log")
def log_answers(rec: LogRecord):
    # 每個 client 的限流已在 EarlyRateLimit 做過（解析 body 之前）
    global _last_vacuum_day
    d = store.current()
    if rec.quiz_version != d.version:
        raise HTTPException(400, "題庫已經更新，這份作答無法送出。請重新整理頁面後再作答。")
    if set(rec.answers) - d.question_ids or set(rec.first_answers or {}) - d.question_ids:
        raise HTTPException(400, "包含未知的題目")
    if not set(rec.answers) & d.main_ids:
        raise HTTPException(400, "沒有任何主問卷的作答")
    if rec.city is not None and rec.city not in d.city_ids:
        raise HTTPException(400, "未知的城市")
    if rec.budget is not None and set(rec.budget) - d.budget_ids:
        raise HTTPException(400, "預算資料格式錯誤")
    if len(rec.adjustments) > 3 * len(d.question_ids):
        raise HTTPException(400, "修正紀錄太多")
    for a in rec.adjustments:
        allowed = d.supplementary_ids if a.type == "supplementary_answer" else d.question_ids
        if a.question not in allowed:
            raise HTTPException(400, "包含未知的題目")
    if rec.mode == "simple" and (rec.first_answers is not None or rec.journey_after_results is not None):
        raise HTTPException(400, "作答模式不一致")
    if rec.mode == "full" and (rec.first_answers is None or rec.journey_after_results is None):
        raise HTTPException(400, "作答模式不一致")

    payload = json.dumps(rec.model_dump(by_alias=True, exclude={"quiz_version", "submission_id"}),
                         ensure_ascii=False, separators=(",", ":"))
    if len(payload.encode("utf-8")) > LOG_PAYLOAD_LIMIT:
        raise HTTPException(413, "送出的資料太大了。")
    # 時間只記到日（UTC），不記 IP、User-Agent 或任何識別資訊
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    row_id = hashlib.sha256(rec.submission_id.encode("ascii")).hexdigest()
    with _db_lock:
        conn = answers_db()
        try:
            exists = conn.execute("SELECT 1 FROM answers WHERE id = ?", (row_id,)).fetchone()
            if not exists and conn.execute(
                "SELECT COUNT(*) FROM answers WHERE day = ?", (day,)
            ).fetchone()[0] >= LOG_DAILY_LIMIT:
                raise HTTPException(429, "今天收到的作答已達上限，請明天再試。")
            conn.execute(
                "INSERT INTO answers (id, day, quiz_version, payload) VALUES (?, ?, ?, ?)"
                " ON CONFLICT(id) DO UPDATE SET day = excluded.day, quiz_version = excluded.quiz_version,"
                " payload = excluded.payload",
                (row_id, day, rec.quiz_version, payload),
            )
            conn.commit()
            # 每天第一筆寫入後重整一次檔案，讓頁面配置也不反映寫入順序。
            # VACUUM 需要約 2 倍資料庫大小的暫存空間；失敗（例如磁碟快滿）時資料已經寫入，只記警告、照常回成功，
            # 當天也不再重試（否則之後每一筆上傳都會失敗）
            if _last_vacuum_day != day:
                _last_vacuum_day = day
                try:
                    conn.execute("VACUUM")
                except sqlite3.Error as e:
                    log.warning("answers 資料庫 VACUUM 失敗：%s", type(e).__name__)
        finally:
            conn.close()
    return {"ok": True}


@app.get("/api/health")
def health():
    d = store.current()
    return {"ok": True, "model": MODEL, "effort": EFFORT, "quiz_version": d.version, "data_hash": d.data_hash}
