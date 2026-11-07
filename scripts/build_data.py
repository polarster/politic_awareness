#!/usr/bin/env python3
"""驗證 data/ 下的 YAML，並輸出前端與後端共用的 data.json。

用法：python3 scripts/build_data.py [--check]
  --check  只驗證，不寫檔
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = ROOT / "web" / "src" / "generated" / "data.json"
LY_VOTES = DATA / "ly" / "votes.json"
ARCHIVE_OUT = ROOT / "web" / "public" / "ly-votes.json"
ARCHIVE_FIELDS = ("id", "kind", "term", "meeting", "dates", "source_url", "no", "item", "short_title",
                  "agenda_title", "counts", "by_party", "names", "procedural")

GRADES = {"A", "B", "C"}
EVIDENCE_KINDS = {
    "vote", "bill", "interpellation", "platform", "statement",
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


def build() -> dict:
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

    ARG_KINDS = {"gazette", "minutes", "official", "news"}
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

    ly = {v["id"]: v for v in json.loads(LY_VOTES.read_text(encoding="utf-8"))} if LY_VOTES.exists() else {}
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

    return {
        "version": qdoc["version"],
        "votes": curated,
        "arguments": arguments,
        "discussions": ddoc["discussions"],
        "axes": axes,
        "questions": qdoc["questions"],
        "supplementary": sdoc["questions"],
        "budget": bdoc,
        "entities": entities,
        "stances": stances,
    }


def main():
    try:
        data = build()
    except ValidationError as e:
        print(f"資料驗證失敗：{e}", file=sys.stderr)
        sys.exit(1)
    if "--check" in sys.argv:
        print("資料驗證通過")
        return
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if LY_VOTES.exists():
        archive = [{k: v[k] for k in ARCHIVE_FIELDS} for v in json.loads(LY_VOTES.read_text(encoding="utf-8"))]
        ARCHIVE_OUT.parent.mkdir(parents=True, exist_ok=True)
        ARCHIVE_OUT.write_text(json.dumps(archive, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    n_st = sum(len(v) for v in data["stances"].values())
    print(f"已輸出 {OUT.relative_to(ROOT)}：{len(data['questions'])} 題、"
          f"{len(data['budget']['items'])} 個預算項目、{len(data['entities'])} 個對象、{n_st} 筆立場、"
          f"{len(data['votes'])} 筆精選表決、{len(data['arguments'])} 題正反說法")


if __name__ == "__main__":
    main()
