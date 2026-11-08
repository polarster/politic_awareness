"""S12、S15：scripts/build_data.py 的版本雜湊與第三方資料檢查（只讀 data/，不寫入產生的檔案）。"""
import copy
import importlib.util
import json
import re
import stat
from pathlib import Path

import pytest

pytest.importorskip("yaml")

_SPEC = importlib.util.spec_from_file_location(
    "build_data", Path(__file__).resolve().parent.parent / "scripts" / "build_data.py")
bd = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(bd)


@pytest.fixture(scope="module")
def built():
    return bd.build()


def test_version_carries_content_hash_and_is_deterministic(built):
    assert re.fullmatch(r"[^+]+\+[0-9a-f]{8}", built["version"])
    assert re.fullmatch(r"[0-9a-f]{12}", built["data_hash"])
    again = bd.build()
    assert again["version"] == built["version"] and again["data_hash"] == built["data_hash"]


def test_quiz_hash_follows_question_changes_but_not_stances(built):
    parts = (built["axes"], built["questions"], built["supplementary"], built["budget"])
    base = bd.quiz_hash(*parts)
    reworded = copy.deepcopy(built["questions"])
    reworded[0]["text"] += "（改寫）"
    assert bd.quiz_hash(built["axes"], reworded, built["supplementary"], built["budget"]) != base
    flipped = copy.deepcopy(built["questions"])
    flipped[0]["direction"] = -flipped[0]["direction"]
    assert bd.quiz_hash(built["axes"], flipped, built["supplementary"], built["budget"]) != base
    removed = copy.deepcopy(built["supplementary"])[1:]
    assert bd.quiz_hash(built["axes"], built["questions"], removed, built["budget"]) != base
    # 立場只影響 data_hash，不影響題庫版本
    other = copy.deepcopy(built)
    other.pop("data_hash")
    first = next(k for k, v in other["stances"].items() if v)
    other["stances"][first][0]["value"] = -other["stances"][first][0]["value"] or 1
    assert bd.quiz_hash(*parts) == base
    assert bd.content_hash(other)[:12] != built["data_hash"]


@pytest.mark.parametrize("url,ok", [
    ("https://ppg.ly.gov.tw/ppg/publications/official-gazettes/113/01/07/details", True),
    ("file:.keys/claude_api.key", False),
    ("javascript:alert(1)", False),
    ("http://ppg.ly.gov.tw/ppg/x", False),
    ("https://ppg.ly.gov.tw.evil.example/x", False),
    ("https://ppg.ly.gov.tw@evil.example/x", False),
    ("https://evil.example/https://ppg.ly.gov.tw/", False),
    ('https://ppg.ly.gov.tw/"><script>', False),
    (None, False),
])
def test_ly_source_url_must_be_the_gazette_site(url, ok):
    assert bd.check_ly_record({"source_url": url}) is ok


def test_load_ly_rejects_tampered_upstream(tmp_path, monkeypatch):
    good = {k: None for k in bd.ARCHIVE_FIELDS}
    good.update(id="v1", source_url="https://ppg.ly.gov.tw/ppg/x")
    bad = dict(good, id="v2", source_url="file:.keys/claude_api.key")
    f = tmp_path / "votes.json"
    f.write_text(json.dumps([good, bad]), encoding="utf-8")
    monkeypatch.setattr(bd, "LY_VOTES", f)
    with pytest.raises(bd.ValidationError, match="v2"):
        bd.load_ly()
    f.write_text(json.dumps([good]), encoding="utf-8")
    assert bd.load_ly() == [good]
    f.write_text(json.dumps([{"id": "v3", "source_url": "https://ppg.ly.gov.tw/x"}]), encoding="utf-8")
    with pytest.raises(bd.ValidationError, match="缺少欄位"):
        bd.load_ly()


@pytest.mark.parametrize("entity", [
    {"color": "red; background:url(x)"},
    {"color": "#12345"},
    {"logo": "../../.keys/claude_api.key"},
    {"logo": "logos/../x.svg"},
    {"logo": "https://evil.example/logo.svg"},
    {"logo": "logos/missing.svg"},
    {"logo_source": "http://commons.wikimedia.org/x"},
    {"logo_source": "javascript:alert(1)"},
])
def test_entity_fields_are_checked(entity):
    with pytest.raises(bd.ValidationError):
        bd.check_entity(entity, "test")


def test_real_entities_pass(built):
    for e in built["entities"]:
        bd.check_entity(e, e["id"])


def test_write_atomic(tmp_path):
    target = tmp_path / "out" / "data.json"
    bd.write_atomic(target, '{"a": 1}')
    bd.write_atomic(target, '{"a": 2}')
    assert json.loads(target.read_text(encoding="utf-8")) == {"a": 2}
    assert stat.S_IMODE(target.stat().st_mode) == 0o644
    assert [p.name for p in target.parent.iterdir()] == ["data.json"]  # 沒有留下暫存檔
