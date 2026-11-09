"""S20：成本換算（fallback 的 iterations、價格表驗證、未知模型）；S18：資料庫檔權限；S25：寫檔失敗不影響回覆。"""
import os
import stat
from types import SimpleNamespace

import pytest

from usage import DEFAULT_PRICES, UsageBudget, cost_from_usage, load_prices, private_db


def seg(type_, model, inp, out, cw=0, cr=0):
    return SimpleNamespace(type=type_, model=model, input_tokens=inp, output_tokens=out,
                           cache_creation_input_tokens=cw, cache_read_input_tokens=cr)


def test_fallback_targets_are_priced():
    for m in ("claude-sonnet-5", "claude-opus-5", "claude-opus-4-8"):
        assert m in DEFAULT_PRICES
    assert DEFAULT_PRICES["claude-opus-4-8"] == {"input": 5, "output": 25, "cache_write": 6.25, "cache_read": 0.5}


def test_iterations_are_summed_at_each_segments_price():
    # 官方格式：被拒的嘗試是 message、實際回覆的是 fallback_message；頂層 usage 只涵蓋最後一段
    usage = SimpleNamespace(input_tokens=200, output_tokens=50, cache_creation_input_tokens=1000,
                            cache_read_input_tokens=0, iterations=[
                                seg("message", "claude-sonnet-5-5", 300, 7900, cw=2000, cr=500),
                                seg("fallback_message", "claude-opus-4-8", 200, 50, cw=1000),
                            ])
    p = load_prices(None)
    expected = ((300 * 2 + 7900 * 10 + 2000 * 2.5 + 500 * 0.2)
                + (200 * 5 + 50 * 25 + 1000 * 6.25)) / 1e6
    assert cost_from_usage(usage, "claude-opus-4-8", p, requested="claude-sonnet-5-5") == pytest.approx(expected)
    # 只看頂層會少記很多
    assert cost_from_usage(SimpleNamespace(**{k: getattr(usage, k) for k in (
        "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")}),
        "claude-opus-4-8", p) < expected / 5


def test_segment_without_model_uses_the_more_expensive_of_requested_and_served():
    usage = SimpleNamespace(input_tokens=0, output_tokens=0, iterations=[seg("message", None, 1_000_000, 0)])
    p = load_prices(None)
    assert cost_from_usage(usage, "claude-sonnet-5-5", p, requested="claude-opus-5") == pytest.approx(5)
    assert cost_from_usage(usage, "claude-opus-5", p, requested="claude-sonnet-5-5") == pytest.approx(5)


def test_unknown_model_uses_per_field_maximum():
    u = SimpleNamespace(input_tokens=0, output_tokens=0, cache_creation_input_tokens=0, cache_read_input_tokens=1e6)
    p = load_prices(None)
    # 舊做法拿「output 最貴的那一整列」，cache_read 只會記到 0.2
    assert cost_from_usage(u, "claude-future-9", p) == pytest.approx(0.5)


@pytest.mark.parametrize("raw", [
    '{"claude-new": {"output": 30}}',  # 新模型缺欄位：原本缺的價格會當 0 元
    '{"claude-new": {"input": 1, "output": 2, "cache_write": 3, "cache_read": -1}}',
    '{"claude-new": {"input": 1, "output": 2, "cache_write": 3, "cache_read": true}}',
    '{"claude-new": {"input": 1, "output": 2, "cache_write": 3, "cache_read": "0.1"}}',
    '{"claude-sonnet-5-5": {"ouput": 15}}',
    '[1, 2]',
])
def test_invalid_price_tables_are_rejected(raw):
    with pytest.raises(ValueError):
        load_prices(raw)


def test_complete_new_row_is_accepted():
    p = load_prices('{"claude-new": {"input": 1, "output": 2, "cache_write": 1.25, "cache_read": 0.1}}')
    assert p["claude-new"]["cache_write"] == 1.25


def test_private_db_creates_0600_and_tightens_existing(tmp_path):
    new = tmp_path / "sub" / "a.sqlite3"
    private_db(new).close()
    assert stat.S_IMODE(new.stat().st_mode) == 0o600
    old = tmp_path / "b.sqlite3"
    old.write_bytes(b"")
    os.chmod(old, 0o644)
    private_db(old).close()
    assert stat.S_IMODE(old.stat().st_mode) == 0o600


def test_usage_db_is_private(tmp_path):
    db = tmp_path / "u.sqlite3"
    UsageBudget(1.0, 3600, db).record(0.1)
    assert stat.S_IMODE(db.stat().st_mode) == 0o600


def test_record_survives_db_write_failure(tmp_path):
    db = tmp_path / "u.sqlite3"
    b = UsageBudget(1.0, 3600, db)
    os.chmod(db, 0o400)  # 寫不進去（例如磁碟滿）
    try:
        b.record(0.4)  # 不丟例外：已經付費的回覆不會變成 500
    finally:
        os.chmod(db, 0o600)
    assert b.used() == pytest.approx(0.4)  # 記憶體裡照樣計入
