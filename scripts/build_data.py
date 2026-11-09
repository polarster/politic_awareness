#!/usr/bin/env python3
"""驗證 data/ 下的 YAML，並輸出前端與後端共用的 data.json。

用法：python3 scripts/build_data.py [--check]
  --check  只驗證，不寫檔

輸出的 version 是 questions.yaml 的 version 加上題目內容的雜湊（例如 2026.11-draft4+1a2b3c4d）：
題目、補充題、維度或預算項目一改，版本就跟著變，不必手動改版本號。data_hash 則涵蓋整份輸出（含立場）。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = ROOT / "web" / "src" / "generated" / "data.json"
PUBLIC = ROOT / "web" / "public"
LY_VOTES = DATA / "ly" / "votes.json"
ARCHIVE_OUT = PUBLIC / "ly-votes.json"
ARCHIVE_FIELDS = ("id", "kind", "term", "meeting", "dates", "source_url", "no", "item", "short_title",
                  "agenda_title", "counts", "by_party", "names", "procedural")

# 第三方資料（立法院表決）與政黨資料直接進入網頁的欄位，再檢查一次格式
LY_SOURCE_URL = re.compile(r"https://ppg\.ly\.gov\.tw/[^\s\"'<>\\]*")
COLOR = re.compile(r"#[0-9A-Fa-f]{6}")
LOGO = re.compile(r"logos/[A-Za-z0-9_-]+\.(svg|png)")

GRADES = {"A", "B", "C"}
EVIDENCE_KINDS = {
    "vote", "bulletin", "bill", "interpellation", "platform", "statement",
    "interview", "debate", "social_interview",
}
GRADE_ORDER = {"A": 3, "B": 2, "C": 1}


class ValidationError(Exception):
    pass


def load(path: Path):
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def fail(msg: str):
    raise ValidationError(msg)


def content_hash(obj) -> str:
    """與鍵順序無關的內容雜湊（sha256 hex）。"""
    raw = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def quiz_hash(axes, questions, supplementary, budget) -> str:
    """影響題意與計分的內容：維度、主問卷、補充題、預算（含城市）。立場等其他資料不在內。"""
    return content_hash({"axes": axes, "questions": questions, "supplementary": supplementary, "budget": budget})[:8]


def check_ly_record(v: dict) -> bool:
    """立法院表決紀錄的 source_url 會直接變成網頁上的連結，只接受立法院公報網站的 https 網址。"""
    url = v.get("source_url")
    return isinstance(url, str) and LY_SOURCE_URL.fullmatch(url) is not None


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_ly() -> list[dict]:
    """讀入 data/ly/votes.json（scripts/ly_votes.py 產生的第三方資料），檢查會進入網頁的欄位。"""
    if not LY_VOTES.exists():
        return []
    records = json.loads(LY_VOTES.read_text(encoding="utf-8"))
    if not isinstance(records, list):
        fail(f"{_rel(LY_VOTES)}: 格式錯誤")
    bad = [str(v.get("id")) if isinstance(v, dict) else repr(v)[:40]
           for v in records if not isinstance(v, dict) or not check_ly_record(v)]
    if bad:
        fail(f"{_rel(LY_VOTES)}: {len(bad)} 筆表決的 source_url 不是 https://ppg.ly.gov.tw/ 的網址："
             f"{'、'.join(bad[:10])}{'…' if len(bad) > 10 else ''}")
    for v in records:
        missing = [k for k in ARCHIVE_FIELDS if k not in v]
        if missing:
            fail(f"{_rel(LY_VOTES)} {v.get('id')}: 缺少欄位 {', '.join(missing)}")
    return records


def check_entity(e: dict, where: str) -> None:
    """政黨的代表色、黨徽路徑與來源會直接用在網頁上。"""
    if e.get("color") is not None and not (isinstance(e["color"], str) and COLOR.fullmatch(e["color"])):
        fail(f"{where}: color 必須是 #RRGGBB")
    if e.get("logo") is not None:
        if not (isinstance(e["logo"], str) and LOGO.fullmatch(e["logo"])):
            fail(f"{where}: logo 必須是 logos/ 底下的 .svg 或 .png 檔名")
        if not (PUBLIC / e["logo"]).is_file():
            fail(f"{where}: 找不到黨徽檔 web/public/{e['logo']}")
    if e.get("logo_source") is not None and not str(e["logo_source"]).startswith("https://"):
        fail(f"{where}: logo_source 必須是 https 網址")


def write_atomic(path: Path, text: str) -> None:
    """先寫到同目錄的暫存檔再改名：讀取的一方（Vite、後端）不會讀到寫到一半的檔案。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def check_item(q: dict, axis_ids: set[str], where: str):
    for key in ("id", "text"):
        if not q.get(key):
            fail(f"{where}: 缺少 {key}")
    if q.get("layer") not in ("national", "municipal"):
        fail(f"{where} {q['id']}: layer 必須是 national 或 municipal")
    axis = q.get("axis")
    if axis is not None and axis not in axis_ids:
        fail(f"{where} {q['id']}: 未知的 axis {axis}")
    d = q.get("direction")
    if axis is None and d not in (0, None):
        fail(f"{where} {q['id']}: axis 為 null 時 direction 應為 0")
    if axis is not None and d not in (1, -1):
        fail(f"{where} {q['id']}: direction 必須是 1 或 -1")


def build(ly_records: list[dict] | None = None) -> dict:
    axes = load(DATA / "axes.yaml")["axes"]
    axis_ids = {a["id"] for a in axes}

    qdoc = load(DATA / "questions.yaml")
    sdoc = load(DATA / "supplementary.yaml")
    bdoc = load(DATA / "budget.yaml")

    seen: set[str] = set()
    for q in qdoc["questions"]:
        check_item(q, axis_ids, "questions.yaml")
        if q["id"] in seen:
            fail(f"重複的 id {q['id']}")
        seen.add(q["id"])
    for q in sdoc["questions"]:
        check_item(q, axis_ids, "supplementary.yaml")
        if q["id"] in seen:
            fail(f"重複的 id {q['id']}")
        seen.add(q["id"])
    for b in bdoc["items"]:
        if b["kind"] not in ("expense", "revenue", "surplus"):
            fail(f"budget {b['id']}: 未知的 kind")
        if b.get("axis") is not None and b["axis"] not in axis_ids:
            fail(f"budget {b['id']}: 未知的 axis")
        if b["id"] in seen:
            fail(f"重複的 id {b['id']}")
        seen.add(b["id"])
    budget_ids = {b["id"] for b in bdoc["items"]}

    entities = []
    for kind_dir in ("parties", "people"):
        d = DATA / "entities" / kind_dir
        if not d.exists():
            continue
        for p in sorted(d.glob("*.yaml")):
            e = load(p)
            if e["id"] != p.stem:
                fail(f"{p}: id 必須與檔名相同")
            check_entity(e, f"entities/{kind_dir}/{p.name}")
            entities.append(e)
    entity_ids = {e["id"] for e in entities}

    stances: dict[str, list] = {}
    for p in sorted((DATA / "stances").glob("*.yaml")):
        doc = load(p) or {}
        eid = doc.get("entity")
        if eid not in entity_ids:
            fail(f"{p}: 未知的 entity {eid}")
        out = []
        for s in doc.get("stances") or []:
            qid = s["question"]
            where = f"{p.name} {qid}"
            if qid not in seen:
                fail(f"{where}: 未知的題目或預算項目")
            v = s.get("value")
            allowed = (-1, 0, 1) if qid in budget_ids else (-2, -1, 0, 1, 2)
            if v not in allowed:
                fail(f"{where}: value 必須是 {allowed}")
            ev = s.get("evidence") or []
            if not ev:
                fail(f"{where}: 每個立場至少要有一筆出處")
            for e in ev:
                if e.get("grade") not in GRADES:
                    fail(f"{where}: grade 必須是 A/B/C")
                if e.get("kind") not in EVIDENCE_KINDS:
                    fail(f"{where}: 未知的 evidence kind {e.get('kind')}")
                if not str(e.get("url", "")).startswith(("http://", "https://")):
                    fail(f"{where}: 每筆出處都要有連結")
                if e["kind"] == "vote" and not e.get("vote"):
                    fail(f"{where}: kind 為 vote 時需要 vote 欄位")
                if e["grade"] == "A" and e["kind"] not in ("vote", "bulletin"):
                    fail(f"{where}: A 級只能是記名表決（vote）或選舉公報（bulletin）")
            if not s.get("interpretation"):
                fail(f"{where}: 需要 interpretation（詮釋）")
            s["grade"] = max((e["grade"] for e in ev), key=GRADE_ORDER.get)
            for e in ev:
                if e.get("date") is not None:
                    e["date"] = str(e["date"])
            if s.get("last_reviewed") is not None:
                s["last_reviewed"] = str(s["last_reviewed"])
            out.append(s)
        stances[eid] = out

    ddoc = load(DATA / "discussions.yaml")
    for d in ddoc["discussions"]:
        for key in ("id", "title", "opening", "guidance"):
            if not d.get(key):
                fail(f"discussions.yaml: 缺少 {key}")
        for qid in d.get("reflection_questions") or []:
            if qid not in seen:
                fail(f"discussions.yaml {d['id']}: 未知的題目 {qid}")

    ARG_KINDS = {"gazette", "minutes", "official", "news", "org", "research"}
    arguments: dict[str, dict] = {}
    for p in sorted((DATA / "arguments").glob("*.yaml")):
        for a in (load(p) or {}).get("arguments") or []:
            qid = a.get("question")
            where = f"{p.name} {qid}"
            if qid not in seen:
                fail(f"{where}: 未知的題目")
            if qid in arguments:
                fail(f"{where}: 重複的題目")
            for side in ("pro", "con"):
                sd = a.get(side) or {}
                if not sd.get("text"):
                    fail(f"{where}: 缺少 {side}.text")
                for src in sd.get("sources") or []:
                    if src.get("kind") not in ARG_KINDS:
                        fail(f"{where}: 未知的來源類型 {src.get('kind')}")
                    if not str(src.get("url", "")).startswith(("http://", "https://")):
                        fail(f"{where}: 來源需要連結")
                    if src.get("date") is not None:
                        src["date"] = str(src["date"])
            arguments[qid] = {"pro": a["pro"], "con": a["con"]}

    # 名詞與背景、正反說法的白話說明。不得出現政黨或政治人物名稱（避免影響作答）
    EXP_KINDS = ARG_KINDS | {"reference"}
    PARTY_WORDS = ["國民黨", "民進黨", "民眾黨", "時代力量", "時力", "綠黨", "社民黨", "基進", "小民參",
                   "民主進步黨", "國民黨團", "黨團", "親民黨", "新黨"]
    party_names = [e["name"] for e in entities if e.get("type") == "party"] + PARTY_WORDS
    person_names = [e["name"] for e in entities if e.get("type") == "person"]

    def check_text(where: str, text: str, limit: int) -> None:
        if not text or not str(text).strip():
            fail(f"{where}: 缺少內容")
        if len(str(text)) > limit:
            fail(f"{where}: 超過 {limit} 字（{len(str(text))}）")
        for w in party_names + person_names:
            if w and w in str(text):
                fail(f"{where}: 不可出現政黨或政治人物名稱「{w}」")

    def check_sources(where: str, srcs) -> None:
        if not srcs:
            fail(f"{where}: 至少需要一個來源")
        for src in srcs:
            if src.get("kind") not in EXP_KINDS:
                fail(f"{where}: 未知的來源類型 {src.get('kind')}")
            if not str(src.get("url", "")).startswith(("http://", "https://")) or not src.get("title"):
                fail(f"{where}: 來源需要標題與連結")
            if src.get("date") is not None:
                src["date"] = str(src["date"])

    explainers: dict[str, dict] = {}
    for p in sorted((DATA / "explainers").glob("*.yaml")):
        for x in (load(p) or {}).get("explainers") or []:
            qid = x.get("question")
            where = f"explainers/{p.name} {qid}"
            if qid not in arguments:
                fail(f"{where}: 題目不存在或沒有正反說法")
            if qid in explainers:
                fail(f"{where}: 重複的題目")
            for t in x.get("terms") or []:
                if not t.get("term"):
                    fail(f"{where}: 名詞缺少 term")
                check_text(f"{where} 名詞「{t.get('term')}」", t.get("text"), 120)
                check_sources(f"{where} 名詞「{t.get('term')}」", t.get("sources"))
            if x.get("background"):
                check_text(f"{where} 背景", x["background"].get("text"), 170)
                check_sources(f"{where} 背景", x["background"].get("sources"))
            plain = x.get("plain") or {}
            for side in ("pro", "con"):
                check_text(f"{where} 白話說明 {side}", plain.get(side), 100)
            explainers[qid] = {"terms": x.get("terms") or [], "background": x.get("background"), "plain": plain}

    ly = {v["id"]: v for v in (load_ly() if ly_records is None else ly_records)}
    curated = []
    vdoc = load(DATA / "votes.yaml")
    for c in vdoc["votes"]:
        for key in ("id", "vote", "title", "summary"):
            if not c.get(key):
                fail(f"votes.yaml: 缺少 {key}")
        recs = []
        for vid in [c["vote"], *(c.get("also") or [])]:
            if vid not in ly:
                fail(f"votes.yaml {c['id']}: data/ly/votes.json 中找不到表決 {vid}")
            if not check_ly_record(ly[vid]):
                fail(f"votes.yaml {c['id']}: 表決 {vid} 的 source_url 不是 https://ppg.ly.gov.tw/ 的網址")
            recs.append({k: ly[vid][k] for k in ARCHIVE_FIELDS})
        for q in c.get("questions") or []:
            if q not in seen:
                fail(f"votes.yaml {c['id']}: 未知的題目 {q}")
        curated.append({**c, "records": recs})
    curated_ids = {c["id"] for c in curated}
    for eid, sts in stances.items():
        for st in sts:
            for e in st["evidence"]:
                ref = (e.get("vote") or {}).get("ref")
                if ref and ref not in curated_ids:
                    fail(f"{eid} {st['question']}: vote.ref {ref} 不在 votes.yaml 中")

    version = str(qdoc["version"])
    if "+" in version:
        fail("questions.yaml: version 不可含「+」（「+」之後是自動加上的內容雜湊）")
    out = {
        # 題目內容一改版本就變：前端會丟掉舊版本的作答進度，後端也不收舊版本的作答
        "version": f"{version}+{quiz_hash(axes, qdoc['questions'], sdoc['questions'], bdoc)}",
        "votes": curated,
        "arguments": arguments,
        "explainers": explainers,
        "discussions": ddoc["discussions"],
        "axes": axes,
        "questions": qdoc["questions"],
        "supplementary": sdoc["questions"],
        "budget": bdoc,
        "entities": entities,
        "stances": stances,
    }
    out["data_hash"] = content_hash(out)[:12]  # 整份資料（含立場、討論主題）的雜湊，後端 /api/health 會回報
    return out


def main():
    try:
        ly_records = load_ly()
        data = build(ly_records)
    except ValidationError as e:
        print(f"資料驗證失敗：{e}", file=sys.stderr)
        sys.exit(1)
    if "--check" in sys.argv:
        print(f"資料驗證通過（版本 {data['version']}，data_hash {data['data_hash']}）")
        return
    if ly_records:
        archive = [{k: v[k] for k in ARCHIVE_FIELDS} for v in ly_records]
        write_atomic(ARCHIVE_OUT, json.dumps(archive, ensure_ascii=False, separators=(",", ":")))
    write_atomic(OUT, json.dumps(data, ensure_ascii=False, indent=1, default=str))
    n_st = sum(len(v) for v in data["stances"].values())
    print(f"已輸出 {OUT.relative_to(ROOT)}（版本 {data['version']}）：{len(data['questions'])} 題、"
          f"{len(data['budget']['items'])} 個預算項目、{len(data['entities'])} 個對象、{n_st} 筆立場、"
          f"{len(data['votes'])} 筆精選表決、{len(data['arguments'])} 題正反說法、{len(data['explainers'])} 題名詞與背景")


if __name__ == "__main__":
    main()
