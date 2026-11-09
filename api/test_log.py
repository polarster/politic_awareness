"""S18、S25：匿名作答以隨機的 submission_id 去重、時間只到日、檔案 0600；/api/log 的驗證。"""
import hashlib
import json
import sqlite3
import stat

import pytest

import app as app_module

SID = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e"


def body(**kw):
    d = app_module.store.current()
    b = {
        "submission_id": SID,
        "quiz_version": d.version,
        "city": "taipei",
        "answers": {"N01": {"v": 1, "imp": True}, "N02": {"v": None, "imp": False}},
        "budget": {"B_HOUSING": 2, "R_DEBT": 1},
        "adjustments": [
            {"type": "answer_change", "question": "N01", "from": 0, "to": 1},
            {"type": "importance_change", "question": "N01", "to": True},
            {"type": "supplementary_answer", "question": sorted(d.supplementary_ids)[0], "to": None},
        ],
        "mode": "simple",
        "first_answers": None,
        "journey_after_results": None,
    }
    b.update(kw)
    return b


def rows():
    conn = sqlite3.connect(app_module.LOG_DB_PATH)
    try:
        return conn.execute("SELECT id, day, quiz_version, payload FROM answers").fetchall()
    finally:
        conn.close()


def test_resubmission_overwrites_the_same_row(client):
    assert client.post("/api/log", json=body()).status_code == 200
    full = body(mode="full", first_answers={"N01": {"v": 0, "imp": False}}, journey_after_results=True)
    assert client.post("/api/log", json=full).status_code == 200
    stored = rows()
    assert len(stored) == 1
    assert json.loads(stored[0][3])["mode"] == "full"  # 保留最後（最完整）的版本
    other = body(submission_id="9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d")
    assert client.post("/api/log", json=other).status_code == 200
    assert len(rows()) == 2


def test_row_has_no_order_revealing_key_and_only_the_day(client):
    assert client.post("/api/log", json=body()).status_code == 200
    (row_id, day, _, payload), = rows()
    assert row_id == hashlib.sha256(SID.encode()).hexdigest()  # 只存雜湊，不存前端持有的原值
    assert len(day) == len("2026-11-07") and "T" not in day
    conn = sqlite3.connect(app_module.LOG_DB_PATH)
    with pytest.raises(sqlite3.OperationalError):
        conn.execute("SELECT rowid FROM answers")  # WITHOUT ROWID：沒有遞增的 rowid
    conn.close()
    assert SID.encode() not in app_module.LOG_DB_PATH.read_bytes()
    assert set(json.loads(payload)) == {"city", "answers", "budget", "adjustments", "mode", "first_answers",
                                        "journey_after_results"}


def test_database_files_are_private(client):
    assert client.post("/api/log", json=body()).status_code == 200
    assert stat.S_IMODE(app_module.LOG_DB_PATH.stat().st_mode) == 0o600


@pytest.mark.parametrize("override", [
    {"submission_id": "not-a-uuid"},
    {"submission_id": SID.upper()},
    {"submission_id": "3f2b8c1e-4d5a-1b6c-8d7e-9f0a1b2c3d4e"},  # 不是 v4
    {"answers": {}},
    {"adjustments": [{"type": "answer_change", "question": "N01", "from": 0, "to": 9}]},
    {"adjustments": [{"type": "answer_change", "question": "N01", "from": 0, "to": int("9" * 4000)}]},
    {"adjustments": [{"type": "importance_change", "question": "N01", "to": 2}]},
    {"adjustments": [{"type": "answer_change", "question": "N01", "to": 1, "reason": "原話"}]},
    {"adjustments": [{"type": "other", "question": "N01", "to": 1}]},
    {"answers": {"N01": {"v": 1, "imp": False, "extra": 1}}},
    {"answers": {"N01": {"v": "2", "imp": False}}},
    {"extra_field": 1},
])
def test_schema_rejects(client, override):
    assert client.post("/api/log", json=body(**override)).status_code == 422
    assert not app_module.LOG_DB_PATH.exists() or rows() == []


@pytest.mark.parametrize("override", [
    {"answers": {sorted(app_module.store.current().supplementary_ids)[0]: {"v": 1, "imp": False}}},
    {"adjustments": [{"type": "supplementary_answer", "question": "N01", "to": 1}]},
    {"adjustments": [{"type": "answer_change", "question": "NOPE", "from": 0, "to": 1}]},
    {"first_answers": {"N01": {"v": 0, "imp": False}}},  # simple 模式不該有第一輪答案
    {"mode": "full"},  # full 模式要有第一輪答案
    {"quiz_version": "old"},
])
def test_semantic_checks(client, override):
    assert client.post("/api/log", json=body(**override)).status_code == 400


def test_payload_size_is_limited(client, monkeypatch):
    monkeypatch.setattr(app_module, "LOG_PAYLOAD_LIMIT", 200)
    assert client.post("/api/log", json=body()).status_code == 413


def test_daily_cap_only_counts_new_submissions(client, monkeypatch):
    monkeypatch.setattr(app_module, "LOG_DAILY_LIMIT", 1)
    assert client.post("/api/log", json=body()).status_code == 200
    assert client.post("/api/log", json=body(city="newtaipei")).status_code == 200  # 更新同一筆
    other = body(submission_id="9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d")
    assert client.post("/api/log", json=other).status_code == 429
    assert len(rows()) == 1


def test_vacuum_failure_does_not_fail_the_upload(client, monkeypatch):
    """VACUUM 失敗（例如磁碟快滿）時資料已經寫入：照常回 200，而且當天不再重試。"""
    real_db = app_module.answers_db
    vacuums = []

    class VacuumFails:
        def __init__(self, conn):
            self._conn = conn

        def execute(self, sql, *args):
            if sql.strip().upper() == "VACUUM":
                vacuums.append(sql)
                raise sqlite3.OperationalError("database or disk is full")
            return self._conn.execute(sql, *args)

        def __getattr__(self, name):
            return getattr(self._conn, name)

    monkeypatch.setattr(app_module, "answers_db", lambda: VacuumFails(real_db()))
    assert client.post("/api/log", json=body()).status_code == 200
    other = body(submission_id="9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d")
    assert client.post("/api/log", json=other).status_code == 200
    assert len(rows()) == 2
    assert len(vacuums) == 1


def test_daily_count_uses_an_index(client):
    """每日上限的計數（在 _db_lock 內）不掃整張表。"""
    assert client.post("/api/log", json=body()).status_code == 200
    conn = sqlite3.connect(app_module.LOG_DB_PATH)
    try:
        plan = conn.execute("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM answers WHERE day = ?",
                            ("2026-11-07",)).fetchall()
    finally:
        conn.close()
    assert any("answers_day" in row[-1] for row in plan), plan


def test_log_body_limit(client):
    big = body(answers={f"N{i:05d}": {"v": 1, "imp": False} for i in range(3000)})
    r = client.post("/api/log", json=big)
    assert r.status_code == 413
    assert r.json()["detail"] == "送出的資料太大了。"
