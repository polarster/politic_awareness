"""S15：scripts/ly_votes.py 的上游欄位檢查。不連網：api() 與下載都換成假的。

寫檔的位置由 run_main 明確指定在 tmp_path（--out、--cache），不靠腳本的預設值；另有保險擋下寫到 tmp_path
以外的動作，所以就算預設值之後改成 repo 裡的絕對路徑，也不會覆寫 data/ly/votes.json 或 build/ly_cache。

和 test_build_data.py 一樣用 importlib 載入 scripts/ 下的腳本，`cd api && .venv/bin/pytest -q` 就會跑到。
LY_VOTES_PATH 可以指向其他版本（例如修正前的版本），確認這些測試在修正前會失敗。
"""
from __future__ import annotations

import argparse
import http.client
import importlib.util
import io
import json
import os
import socket
import sys
import urllib.request
import urllib.response
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent  # 本檔在 api/ 底下，上一層是專案根目錄
LY_PATH = Path(os.environ.get("LY_VOTES_PATH", ROOT / "scripts" / "ly_votes.py"))
FAKE_KEY = "sk-ant-FAKE-KEY-FOR-TEST-ONLY-0000"

TEXT = """記名表決結果名單：
(1)「測試條例草案」部分：
出席人數：3　贊成人數：2　反對人數：1　棄權人數：0
贊成者：
王小明　李大華
反對者：
陳一二
"""


def guard_writes(monkeypatch, root: Path) -> None:
    """保險：mkdir、touch、write_text、write_bytes 與寫入模式的 open，目的地在 root 以外就直接失敗，不會真的寫出去。
    相對路徑以目前的工作目錄（fixture 已切到 tmp_path）為準。"""
    root = root.resolve()

    def check(path: Path) -> None:
        if not path.resolve().is_relative_to(root):
            raise AssertionError(f"測試不應該寫到 tmp_path 以外：{path}")

    for name in ("mkdir", "touch", "write_text", "write_bytes"):
        def guarded(self, *a, _orig=getattr(Path, name), **k):
            check(self)
            return _orig(self, *a, **k)

        monkeypatch.setattr(Path, name, guarded)

    def guarded_open(self, mode="r", *a, _orig=Path.open, **k):
        if set(mode) & set("wax+"):
            check(self)
        return _orig(self, mode, *a, **k)

    monkeypatch.setattr(Path, "open", guarded_open)


@pytest.fixture
def ly(monkeypatch, tmp_path):
    spec = importlib.util.spec_from_file_location(f"ly_votes_{id(tmp_path)}", LY_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(mod.time, "sleep", lambda s: None)

    # 保險：萬一有請求繞過假的 api()／opener，直接失敗，不會真的連到外部
    def no_network(*a, **k):
        raise AssertionError("測試不應該連網")

    monkeypatch.setattr(socket, "create_connection", no_network)
    monkeypatch.setattr(socket.socket, "connect", no_network)
    guard_writes(monkeypatch, tmp_path)
    return mod


def fake_upstream(meets):
    def api(path, **params):
        if path == "legislators":
            return {"legislators": [{"委員姓名": "王小明", "黨籍": "甲黨"}, {"委員姓名": "李大華", "黨籍": "甲黨"},
                                    {"委員姓名": "陳一二", "黨籍": "乙黨"}]}
        assert path == "meets"
        return {"meets": meets, "total_page": 1}
    return api


class FakeResponse:
    def __init__(self, body: bytes):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self.body


class FakeHTTPS(urllib.request.HTTPSHandler):
    """不連網的假 HTTPS：location 本身回 200，其他請求一律回 302 重新導向到 location。"""

    def __init__(self, location: str):
        super().__init__()
        self.location = location
        self.urls: list[str] = []

    def https_open(self, req):
        self.urls.append(req.full_url)
        headers = http.client.HTTPMessage()
        if req.full_url == self.location:
            resp = urllib.response.addinfourl(io.BytesIO(b"ok"), headers, req.full_url, 200)
            resp.msg = "OK"
        else:
            headers["Location"] = self.location
            resp = urllib.response.addinfourl(io.BytesIO(b""), headers, req.full_url, 302)
            resp.msg = "Found"
        return resp


def redirecting_opener(ly, location: str):
    """和 ly_votes 的 _opener 一樣掛 _CheckedRedirect，只是 HTTPS 換成假的、不讀環境變數的 proxy。"""
    https = FakeHTTPS(location)
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), ly._CheckedRedirect, https), https


def run_main(ly, monkeypatch, tmp_path, *args):
    """輸出檔與快取目錄都明確指定在 tmp_path，不靠腳本的預設值（目前是相對路徑，之後可能改成絕對路徑）。"""
    monkeypatch.setattr(sys, "argv", ["ly_votes.py", "--terms", "11",
                                      "--out", str(tmp_path / "data" / "ly" / "votes.json"),
                                      "--cache", str(tmp_path / "build" / "ly_cache"), *args])
    ly.main()


VALID_MEETS = [{"會議代碼": "臨時會院會-11-1-1-1", "日期": ["2024-06-21", "2024-06-25"],
                "議事錄": {"txt_file": "https://lydata.ronny-s3.click/agenda-txt/LCIDC01_1136401_00009.doc",
                         "source_url": "https://ppg.ly.gov.tw/ppg/publications/official-gazettes/113/64/01/details"}},
               {"會議代碼": "院會-11-1-19", "議事錄": {}}]  # 沒有議事錄的會議照舊略過


def text_opener(urls: list):
    """假的 _opener：記下網址，回傳 TEXT。"""
    def fake_open(self, req, timeout=None):
        urls.append(req.full_url)
        return FakeResponse(TEXT.encode("utf-8"))

    return type("O", (), {"open": fake_open})()


def test_finding_attack_is_blocked(ly, monkeypatch, tmp_path):
    """報告中的情境：txt_file 指向本機金鑰、會議代碼含 ../，金鑰不能被複製進 web/public。"""
    (tmp_path / ".keys").mkdir()
    (tmp_path / ".keys" / "claude_api.key").write_text(FAKE_KEY)
    (tmp_path / "web" / "public").mkdir(parents=True)
    meets = [{"會議代碼": "../../web/public/robots", "日期": ["2024-01-01"],
              "議事錄": {"txt_file": "file:.keys/claude_api.key", "source_url": "javascript:alert(1)"}}]
    monkeypatch.setattr(ly, "api", fake_upstream(meets))
    with pytest.raises(SystemExit) as e:
        run_main(ly, monkeypatch, tmp_path)
    msg = str(e.value.code)
    assert "會議代碼格式不符" in msg and "txt_file" in msg and "公報連結" in msg
    assert not (tmp_path / "web" / "public" / "robots.txt").exists()
    leaked = [p for p in tmp_path.rglob("*") if p.is_file() and ".keys" not in p.parts and FAKE_KEY in p.read_text(errors="ignore")]
    assert leaked == []
    assert not (tmp_path / "data" / "ly" / "votes.json").exists()


@pytest.mark.parametrize("meet,needle", [
    ({"會議代碼": "院會-11-1-1", "議事錄": {"txt_file": "https://evil.example/x.txt", "source_url": "https://ppg.ly.gov.tw/a"}}, "txt_file"),
    ({"會議代碼": "院會-11-1-1", "議事錄": {"txt_file": "http://lydata.ronny-s3.click/x.txt", "source_url": "https://ppg.ly.gov.tw/a"}}, "txt_file"),
    # urlsplit 解析不了的網址也要列成問題，不能直接 traceback
    ({"會議代碼": "院會-11-1-1", "議事錄": {"txt_file": "https://[lydata.ronny-s3.click/x.txt", "source_url": "https://ppg.ly.gov.tw/a"}}, "txt_file"),
    ({"會議代碼": "院會-11-1-1", "議事錄": {"txt_file": "https://lydata.ronny-s3.click＃@evil.example/x.txt", "source_url": "https://ppg.ly.gov.tw/a"}}, "txt_file"),
    ({"會議代碼": "院會-11-1-1", "議事錄": {"txt_file": "https://lydata.ronny-s3.click/x.txt", "source_url": "https://ppg.ly.gov.tw.evil.example/a"}}, "公報連結"),
    ({"會議代碼": "院會-11-1-1", "議事錄": {"txt_file": "https://lydata.ronny-s3.click/x.txt", "ppg_url": "javascript:alert(1)"}}, "公報連結"),
    ({"會議代碼": "院會-11-1-1", "議事錄": {"txt_file": "https://lydata.ronny-s3.click/x.txt"}}, "公報連結"),
    ({"會議代碼": "院會-11-1-1/../../x", "議事錄": {"txt_file": "https://lydata.ronny-s3.click/x.txt", "source_url": "https://ppg.ly.gov.tw/a"}}, "會議代碼"),
    ({"會議代碼": "院會-１１-1-1", "議事錄": {"txt_file": "https://lydata.ronny-s3.click/x.txt", "source_url": "https://ppg.ly.gov.tw/a"}}, "會議代碼"),
    ({"會議代碼": "院會-11-1-1", "日期": ["<script>"], "議事錄": {"txt_file": "https://lydata.ronny-s3.click/x.txt", "source_url": "https://ppg.ly.gov.tw/a"}}, "日期"),
])
def test_bad_fields_abort_before_download(ly, monkeypatch, tmp_path, meet, needle):
    good = {"會議代碼": "院會-11-1-2", "日期": ["2024-03-01"],
            "議事錄": {"txt_file": "https://lydata.ronny-s3.click/ok.txt", "source_url": "https://ppg.ly.gov.tw/ok"}}
    monkeypatch.setattr(ly, "api", fake_upstream([good, meet]))
    opened = []
    monkeypatch.setattr(ly, "_opener", type("O", (), {"open": lambda self, req, timeout=None: opened.append(req)})(), raising=False)
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: opened.append(a))
    with pytest.raises(SystemExit) as e:
        run_main(ly, monkeypatch, tmp_path)
    assert needle in str(e.value.code)
    assert opened == []  # 一筆不符合就全部不下載
    assert list((tmp_path / "build" / "ly_cache").iterdir()) == []


def test_valid_upstream(ly, monkeypatch, tmp_path):
    monkeypatch.setattr(ly, "api", fake_upstream(VALID_MEETS))
    urls = []
    monkeypatch.setattr(ly, "_opener", text_opener(urls))
    run_main(ly, monkeypatch, tmp_path)
    assert urls == ["https://lydata.ronny-s3.click/agenda-txt/LCIDC01_1136401_00009.doc"]
    assert (tmp_path / "build" / "ly_cache" / "臨時會院會-11-1-1-1.txt").read_text(encoding="utf-8") == TEXT
    out = json.loads((tmp_path / "data" / "ly" / "votes.json").read_text(encoding="utf-8"))
    assert len(out) == 1
    v = out[0]
    assert v["id"] == "臨時會院會-11-1-1-1#1"
    assert v["source_url"] == "https://ppg.ly.gov.tw/ppg/publications/official-gazettes/113/64/01/details"
    assert v["dates"] == ["2024-06-21", "2024-06-25"]
    assert v["by_party"] == {"贊成者": {"甲黨": 2}, "反對者": {"乙黨": 1}, "棄權者": {}}


def test_explicit_paths_win_over_defaults(ly, monkeypatch, tmp_path):
    """模擬 --out、--cache 的預設值改成 repo 裡的絕對路徑（例如用 ROOT 算出來）：
    run_main 明確帶的路徑優先，輸出照樣在 tmp_path，預設的位置完全不會被建立或寫入。"""
    fake_root = tmp_path / "repo"  # 代替 repo 根目錄；萬一真的寫進去，也還在 tmp_path 裡
    add_argument = argparse.ArgumentParser.add_argument

    def absolute_defaults(self, *names, **kw):
        if names and names[0] in ("--out", "--cache"):
            kw["default"] = str(fake_root / kw["default"])
        return add_argument(self, *names, **kw)

    monkeypatch.setattr(argparse.ArgumentParser, "add_argument", absolute_defaults)
    monkeypatch.setattr(ly, "api", fake_upstream(VALID_MEETS))
    monkeypatch.setattr(ly, "_opener", text_opener([]))
    run_main(ly, monkeypatch, tmp_path)
    assert (tmp_path / "data" / "ly" / "votes.json").is_file()
    assert (tmp_path / "build" / "ly_cache" / "臨時會院會-11-1-1-1.txt").is_file()
    assert not fake_root.exists()


def test_writes_outside_tmp_path_are_blocked(ly, tmp_path):
    """fixture 的保險本身：寫到 tmp_path 以外（含用 .. 跑出去的相對路徑）會直接失敗，檔案不會被建立。"""
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    writes = [lambda: outside.mkdir(), lambda: outside.with_suffix(".txt").write_text("x"),
              lambda: outside.with_suffix(".bin").write_bytes(b"x"), lambda: outside.with_suffix(".log").open("a"),
              lambda: Path("..", f"{tmp_path.name}-escape.txt").write_text("x")]
    for write in writes:
        with pytest.raises(AssertionError, match="tmp_path 以外"):
            write()
    assert not [p for p in tmp_path.parent.iterdir() if p.name.startswith(f"{tmp_path.name}-")]
    (tmp_path / "inside" / "ok.txt").parent.mkdir()  # tmp_path 裡照常可以寫
    (tmp_path / "inside" / "ok.txt").write_text("ok")


@pytest.mark.parametrize("url", [
    "https://ly.govapi.tw/v2/meets?%E5%B1%86=11&limit=50",
    "https://lydata.ronny-s3.click/meet-proceeding-txt/%E9%99%A2%E6%9C%83-11-1-1.txt",
])
def test_check_url_accepts(ly, url):
    ly.check_url(url)


@pytest.mark.parametrize("url", [
    "file:.keys/claude_api.key", "file:///etc/passwd", "ftp://ly.govapi.tw/x", "data:,x",
    "http://ly.govapi.tw/v2/meets", "https://evil.example/x", "https://ly.govapi.tw.evil.example/x",
    "https://ly.govapi.tw@evil.example/x", "https://evil.example\\@ly.govapi.tw/x", "https://user@ly.govapi.tw/x",
    "https://ly.govapi.tw:8443/x", " https://ly.govapi.tw/x", "https://ly.gov\napi.tw/x", "https://ly.govapi.tw/\tx",
    # urlsplit 會丟 ValueError 的網址：括號不成對、括號裡不是 IP、主機含 NFKC 後會變成 # 的全形字
    "https://[ly.govapi.tw/x", "https://ly.govapi.tw]/x", "https://[ly.govapi.tw]/x", "https://ly.govapi.tw＃@evil.example/x",
    "/etc/passwd", "../../x", "", None, 1,
])
def test_check_url_rejects(ly, url):
    with pytest.raises(ly.UpstreamError):
        ly.check_url(url)
    with pytest.raises(ly.UpstreamError):
        ly.get(url)


def test_redirects_are_checked(ly):
    assert any(isinstance(h, ly._CheckedRedirect) for h in ly._opener.handlers)
    req = urllib.request.Request("https://ly.govapi.tw/v2/meets")
    for bad in ("http://127.0.0.1:8000/api/usage", "https://evil.example/x", "ftp://ly.govapi.tw/x"):
        with pytest.raises(ly.UpstreamError):
            ly._CheckedRedirect().redirect_request(req, None, 302, "Found", {}, bad)
    ok = ly._CheckedRedirect().redirect_request(req, None, 302, "Found", {}, "https://lydata.ronny-s3.click/x.txt")
    assert ok.full_url == "https://lydata.ronny-s3.click/x.txt"


@pytest.mark.parametrize("location,ok", [
    ("https://lydata.ronny-s3.click/ok.txt", True),
    ("https://evil.example/x", False),
    # urllib 先自己解析 Location，在 _CheckedRedirect 之前就丟 ValueError；get() 要把它當成 UpstreamError
    ("https://[ly.govapi.tw/x", False),
    ("https://ly.govapi.tw]/x", False),
    ("https://[ly.govapi.tw]/x", False),
])
def test_redirect_through_opener(ly, monkeypatch, location, ok):
    opener, https = redirecting_opener(ly, location)
    monkeypatch.setattr(ly, "_opener", opener)
    start = "https://ly.govapi.tw/v2/meets"
    if ok:
        assert ly.get(start) == b"ok"
        assert https.urls == [start, location]
    else:
        with pytest.raises(ly.UpstreamError):
            ly.get(start)
        assert https.urls == [start]  # 不跟著重新導向，也不重試


def test_unparsable_redirect_aborts_main(ly, monkeypatch, tmp_path):
    """補黨籍的迴圈不能吞掉它：第一個請求就中止，不會繼續抓其他屆，也不寫任何檔案。"""
    opener, https = redirecting_opener(ly, "https://[ly.govapi.tw/x")
    monkeypatch.setattr(ly, "_opener", opener)
    with pytest.raises(ly.UpstreamError):
        run_main(ly, monkeypatch, tmp_path)
    assert len(https.urls) == 1
    assert [p for p in tmp_path.rglob("*") if p.is_file()] == []


def test_cache_file_stays_inside(ly, tmp_path):
    cache = tmp_path / "cache"
    cache.mkdir()
    assert ly.cache_file(cache, "院會-11-1-1") == cache / "院會-11-1-1.txt"
    (tmp_path / "secret").write_text(FAKE_KEY)
    (cache / "院會-11-1-2.txt").symlink_to(tmp_path / "secret")
    with pytest.raises(ly.UpstreamError):
        ly.cache_file(cache, "院會-11-1-2")
    with pytest.raises(ly.UpstreamError):
        ly.cache_file(cache, "../escape")


def test_meeting_code_pattern_covers_real_codes(ly):
    cached = ROOT / "build" / "ly_cache"
    if not cached.exists():
        pytest.skip("沒有 build/ly_cache")
    codes = [p.stem for p in cached.glob("*.txt")]
    assert codes and all(ly.MEETING_CODE.fullmatch(c) for c in codes)
    assert sum(c.startswith("臨時會") for c in codes) >= 8
