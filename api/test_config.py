"""S11：設定只讀 PA_ 開頭的變數、effort 白名單、金鑰檔；S12：data.json 改變時後端自動重新載入。"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

import app as app_module
from app import DataStore

HERE = Path(__file__).resolve().parent


def run_app(env_extra: dict, code: str, tmp_path: Path) -> subprocess.CompletedProcess:
    """用乾淨的環境（只帶指定變數）匯入 app，回傳執行結果。"""
    env = {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "LANG": "C.UTF-8",
           "PA_USAGE_DB_PATH": str(tmp_path / "usage.sqlite3"), "PA_LOG_DB_PATH": str(tmp_path / "answers.sqlite3")}
    env.update(env_extra)
    return subprocess.run([sys.executable, "-c", f"import app\n{code}"], cwd=HERE, env=env,
                          capture_output=True, text=True, timeout=60)


def test_unprefixed_claude_effort_is_ignored(tmp_path):
    # Claude Code 會在它的 shell 裡 export CLAUDE_EFFORT；後端不能跟著變成 max
    r = run_app({"CLAUDE_EFFORT": "max", "CLAUDE_MODEL": "claude-opus-5-5"},
                "print(app.EFFORT, app.MODEL)", tmp_path)
    assert r.returncode == 0, r.stderr
    assert r.stdout.split() == ["medium", "claude-sonnet-5-5"]


@pytest.mark.parametrize("effort", ["max", "xhigh", "auto", "MEDIUM", " medium"])
def test_effort_outside_whitelist_refuses_to_start(tmp_path, effort):
    r = run_app({"PA_CLAUDE_EFFORT": effort}, "print(app.EFFORT)", tmp_path)
    assert r.returncode != 0 and "PA_CLAUDE_EFFORT" in r.stderr


def test_empty_setting_means_default(tmp_path):
    r = run_app({"PA_CLAUDE_EFFORT": "", "PA_CLAUDE_MODEL": ""}, "print(app.EFFORT, app.MODEL)", tmp_path)
    assert r.returncode == 0, r.stderr
    assert r.stdout.split() == ["medium", "claude-sonnet-5-5"]


def test_prefixed_settings_are_read(tmp_path):
    r = run_app({"PA_CLAUDE_EFFORT": "low", "PA_MAX_USER_TURNS": "7", "PA_CLIENT_IP_HEADER": "CF-Connecting-IP"},
                "print(app.EFFORT, app.MAX_USER_TURNS, app.CLIENT_IP_HEADER)", tmp_path)
    assert r.returncode == 0, r.stderr
    assert r.stdout.split() == ["low", "7", "cf-connecting-ip"]


def test_api_key_is_read_from_file(tmp_path):
    key = tmp_path / "fake.key"
    key.write_text("sk-ant-fake-for-tests\n", encoding="utf-8")
    key.chmod(0o600)
    r = run_app({"PA_ANTHROPIC_API_KEY_FILE": str(key)}, "print(app.get_client().api_key)", tmp_path)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "sk-ant-fake-for-tests"
    r = run_app({"PA_ANTHROPIC_API_KEY_FILE": str(tmp_path / "missing.key")}, "", tmp_path)
    assert r.returncode != 0 and "PA_ANTHROPIC_API_KEY_FILE" in r.stderr


def test_invalid_price_table_refuses_to_start(tmp_path):
    r = run_app({"PA_PRICE_TABLE": '{"claude-new": {"output": 30}}'}, "", tmp_path)
    assert r.returncode != 0 and "claude-new" in r.stderr


@pytest.fixture
def data_copy(tmp_path):
    p = tmp_path / "data.json"
    shutil.copy(app_module.DATA_PATH, p)
    return p


def bump(path: Path, mutate) -> None:
    d = json.loads(path.read_text(encoding="utf-8"))
    mutate(d)
    path.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    st = path.stat()
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))


def test_data_store_reloads_when_file_changes(data_copy):
    store = DataStore(data_copy)
    before = store.current()
    removed = before.data["supplementary"][0]["id"]

    def mutate(d):
        d["version"] = "2099.1+deadbeef"
        d["supplementary"] = d["supplementary"][1:]
        d["questions"][0]["text"] = "新的措辭"

    bump(data_copy, mutate)
    after = store.current()
    assert after.version == "2099.1+deadbeef"
    assert removed not in after.question_ids
    assert "新的措辭" in after.system_prompt and "新的措辭" not in before.system_prompt


def test_data_store_keeps_old_data_on_broken_file(data_copy):
    store = DataStore(data_copy)
    good = json.loads(data_copy.read_text(encoding="utf-8"))
    v = store.current().version
    data_copy.write_text('{"version": "half-writ', encoding="utf-8")  # 寫到一半
    assert store.current().version == v
    assert store.current().version == v  # 同一個壞檔不會每次都重讀
    good["version"] = "2099.2+feedface"
    data_copy.write_text(json.dumps(good, ensure_ascii=False), encoding="utf-8")
    os.utime(data_copy, ns=(1, 2))
    assert store.current().version == "2099.2+feedface"  # 檔案寫完後照常讀取


def test_api_uses_reloaded_data(client, data_copy, monkeypatch):
    store = DataStore(data_copy)
    monkeypatch.setattr(app_module, "store", store)
    old_version = store.current().version
    bump(data_copy, lambda d: d.update(version="2099.1+deadbeef"))
    assert client.get("/api/health").json()["quiz_version"] == "2099.1+deadbeef"
    body = {"submission_id": "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e", "quiz_version": old_version,
            "answers": {"N01": {"v": 1, "imp": False}}}
    assert client.post("/api/log", json=body).status_code == 400  # 舊版本的作答不再收
    body["quiz_version"] = "2099.1+deadbeef"
    assert client.post("/api/log", json=body).status_code == 200
