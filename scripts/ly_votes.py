#!/usr/bin/env python3
"""從立法院院會議事錄抓出所有記名表決，依黨籍統計，輸出 JSON。

資料來源：g0v 立法院 API（ly.govapi.tw）提供的議事錄文字檔與委員資料；
原始出處為立法院議事暨公報資訊網（ppg.ly.gov.tw）。

用法：python3 scripts/ly_votes.py --terms 10 11 [--out data/ly/votes.json] [--cache build/ly_cache]
"""
from __future__ import annotations

import argparse
import json
import re
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

API = "https://ly.govapi.tw/v2"
UA = {"User-Agent": "politic-awareness/0.1 (research script)"}


def get(url: str, retries: int = 3) -> bytes:
    for i in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.read()
        except Exception:
            if i == retries - 1:
                raise
            time.sleep(2 * (i + 1))
    raise RuntimeError("unreachable")


def api(path: str, **params) -> dict:
    return json.loads(get(f"{API}/{path}?{urllib.parse.urlencode(params)}"))


def norm(name: str) -> str:
    return re.sub(r"[\s‧・·．.]", "", name)


def legislators(term: int) -> dict[str, str]:
    d = api("legislators", 屆=term, limit=300)
    return {norm(x["委員姓名"]): x.get("黨籍") or "?" for x in d["legislators"]}


def meetings(term: int) -> list[dict]:
    out, page = [], 1
    while True:
        d = api("meets", 會議種類="院會", 屆=term, limit=50, page=page)
        out += d["meets"]
        if page >= d.get("total_page", 1):
            return out
        page += 1


HEADER = re.compile(r"^\((\d+)\)「(.+)」部分[：:]\s*$")
COUNTS = re.compile(r"出席人數[：:]\s*(\d+).*?贊成人數[：:]\s*(\d+).*?反對人數[：:]\s*(\d+).*?棄權人數[：:]\s*(\d+)")
SIDE = re.compile(r"^(贊成者|反對者|棄權者)[：:]")


def split_names(line: str) -> list[str]:
    """名單以全形空白分隔；兩字姓名中間也會補一個全形空白（例如「黃　仁」），需合併回來。"""
    toks = [t for t in re.split(r"[\u3000\s]+", line) if t]
    out, i = [], 0
    while i < len(toks):
        if len(toks[i]) == 1 and i + 1 < len(toks) and len(toks[i + 1]) == 1:
            out.append(toks[i] + toks[i + 1])
            i += 2
        else:
            out.append(toks[i])
            i += 1
    # 原住民族委員的族名與中文名之間有空白，例如「伍麗華Saidhai Tahovecahe」
    merged = []
    for t in out:
        if merged and re.fullmatch(r"[A-Za-z'’\-]+", t) and re.search(r"[A-Za-z]$", merged[-1]):
            merged[-1] += t
        else:
            merged.append(t)
    return merged


OVERRIDE_SIDE = re.compile(r"^(贊成維持本院原決議|反對維持本院原決議).*者[：:]\s*(\d+)人")


def parse_override_votes(text: str) -> list[dict]:
    """覆議案的記名投票格式不同：「贊成維持本院原決議，即反對覆議案者：62人」。
    贊成者 = 贊成維持原決議（反對覆議），反對者 = 反對維持原決議（贊成覆議）。編號從 1001 起。"""
    lines = [l.strip() for l in text.splitlines()]
    votes, cur, side, last_decision, last_head = [], None, None, "", ""
    for l in lines:
        if not l:
            continue
        if ITEM_HEAD.match(l) and "覆議" in l:
            last_head = re.sub(r"〔.*$", "", ITEM_HEAD.sub("", l)).strip()
        if re.match(r"^(決議：)?[（(][一二三四五六七八九十]+[）)].*覆議案", l) or (l.startswith("決議") and "覆議案" in l):
            last_decision = l
        if "記名投票表決結果名單" in l:
            item = re.sub(r"^決議：", "", last_decision)
            cur = {"no": 1001 + len(votes), "item": (item or last_head)[:200], "counts": None,
                   "贊成者": [], "反對者": [], "棄權者": [], "_ctx": last_decision, "_title": last_head}
            last_decision = ""
            votes.append(cur)
            side = None
            continue
        if cur is None:
            continue
        m = OVERRIDE_SIDE.match(l)
        if m:
            side = "贊成者" if m.group(1).startswith("贊成") else "反對者"
            expected = int(m.group(2))
            continue
        if side:
            cur[side] += split_names(l)
            if len(cur[side]) >= expected:   # 名單依人數截止，避免吃到後面的文字
                cur[side] = cur[side][:expected]
                side = None
    votes = [v for v in votes if v["贊成者"] or v["反對者"]]
    for v in votes:
        y, n = len(v["贊成者"]), len(v["反對者"])
        v["counts"] = {"出席": y + n, "贊成": y, "反對": n, "棄權": 0}
    return votes


def parse_votes(text: str) -> list[dict]:
    lines = text.splitlines()
    try:
        start = next(i for i, l in enumerate(lines) if "記名表決結果名單" in l)
    except StopIteration:
        return []
    votes, cur, side = [], None, None
    for line in lines[start + 1:]:
        line = line.strip()
        if not line:
            continue
        m = HEADER.match(line)
        if m:
            cur = {"no": int(m.group(1)), "item": m.group(2), "counts": None,
                   "贊成者": [], "反對者": [], "棄權者": []}
            votes.append(cur)
            side = None
            continue
        if cur is None:
            continue
        m = COUNTS.search(line)
        if m:
            cur["counts"] = dict(zip(["出席", "贊成", "反對", "棄權"], map(int, m.groups())))
            continue
        m = SIDE.match(line)
        if m:
            side = m.group(1)
            continue
        if side:
            cur[side] += split_names(line)
    return votes


ITEM_HEAD = re.compile(r"^[一二三四五六七八九十百]+、")
PROCEDURAL = re.compile(r"復議|議事日程|變更議程|逕付二讀|撤銷|延長會期|繼續進行三讀|交付.*委員會|另定期|散會")


CN = {c: i for i, c in enumerate("零一二三四五六七八九")}


def cn_num(s: str) -> int:
    """中文數字（至九十九）轉整數。"""
    if "十" not in s:
        return CN.get(s, 0)
    a, _, b = s.partition("十")
    return (CN.get(a, 1) if a else 1) * 10 + (CN.get(b, 0) if b else 0)


def section_items(text: str, header: str) -> list[str]:
    """取出議事錄中某一節（例如「討論事項」）依序的議程名稱。"""
    lines = [l.strip() for l in text.splitlines()]
    items: list[str] = []
    inside = False
    for l in lines:
        if l == header:
            inside, items = True, []   # 以最後一次出現的節為準（前面可能是議程目錄）
            continue
        if inside:
            if l in ("報告事項", "討論事項", "臨時提案", "散會") or l.startswith("主席："):
                inside = False
                continue
            if ITEM_HEAD.match(l):
                t = re.sub(r"〔.*$", "", ITEM_HEAD.sub("", l)).strip()
                items.append(t)
    return items


def agenda_title_from_item(text: str, item: str, cache: dict) -> str:
    m = re.match(r"(討論事項|報告事項)第([一二三四五六七八九十]+)案", item)
    if not m:
        return ""
    sec = m.group(1)
    if sec not in cache:
        cache[sec] = section_items(text, sec)
    n = cn_num(m.group(2))
    lst = cache[sec]
    return lst[n - 1][:300] if 0 < n <= len(lst) else ""


REF = re.compile(r"附後\((\d+)\)((?:(?:至|及|、)\(\d+\))*)")


def ref_index(text: str) -> dict[int, int]:
    """表決編號 → 引用它的段落行號（「表決結果附後(3)及(4)」「附後(1)至(8)」）。"""
    idx: dict[int, int] = {}
    for i, para in enumerate(text.splitlines()):
        for m in REF.finditer(para):
            nums = [int(m.group(1))]
            rest = m.group(2) or ""
            for op, n in re.findall(r"(至|及|、)\((\d+)\)", rest):
                n = int(n)
                if op == "至":
                    nums += list(range(nums[-1] + 1, n + 1))
                else:
                    nums.append(n)
            for n in nums:
                idx.setdefault(n, i)
    return idx


def decision_context(text: str, vote_no: int, refs: dict[int, int]) -> tuple[str, str]:
    """回傳（決議脈絡, 議程名稱）。議程名稱取引用這筆表決的段落往上最近的議程標題。"""
    lines = text.splitlines()
    i = refs.get(vote_no)
    if i is None:
        return "", ""
    para = lines[i].strip()
    title = ""
    if ITEM_HEAD.match(para):
        title = para
    else:
        # 往上找最近的主項目（「二、…」）；併案審查時，中間的「(二)(三)…」是被併入的提案，跳過
        for j in range(i - 1, max(i - 120, -1), -1):
            cand = lines[j].strip()
            if ITEM_HEAD.match(cand):
                title = cand
                break
    title = re.sub(r"〔.*$", "", title)
    title = ITEM_HEAD.sub("", title).strip()
    title = re.sub(r"^[(（]一[)）]", "", title).strip()
    return para[:600], title[:300]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--terms", nargs="+", type=int, default=[10, 11])
    ap.add_argument("--out", default="data/ly/votes.json")
    ap.add_argument("--cache", default="build/ly_cache")
    args = ap.parse_args()
    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)

    # 黨籍以該屆資料為準；該屆名單缺漏者（例如任期中離職）以相鄰屆次補上
    fallback: dict[str, str] = {}
    for t in sorted({t2 for t in args.terms for t2 in (t - 1, t, t + 1) if t2 >= 9}, reverse=True):
        try:
            fallback.update(legislators(t))
        except Exception:
            pass
    # API 委員名單缺漏者，人工補上（第 10 屆）
    fallback.update({"葉毓蘭": "中國國民黨", "廖國棟": "中國國民黨", "伍麗華": "民主進步黨"})
    results = []
    for term in args.terms:
        party = {**fallback, **legislators(term)}
        for m in meetings(term):
            rec = m.get("議事錄") or {}
            txt_url = rec.get("txt_file")
            if not txt_url:
                continue
            f = cache / (m["會議代碼"] + ".txt")
            if not f.exists():
                f.write_bytes(get(txt_url))
                time.sleep(0.3)
            text = f.read_text(encoding="utf-8", errors="replace")
            sec_cache: dict = {}
            refs = ref_index(text)
            for v in parse_votes(text) + parse_override_votes(text):
                tally = {}
                names = {}
                unknown = []
                for side in ("贊成者", "反對者", "棄權者"):
                    c = Counter()
                    names[side] = []
                    for n in v[side]:
                        p = party.get(norm(n))
                        if p is None:
                            unknown.append(n)
                            p = "?"
                        c[p] += 1
                        names[side].append([n, p])
                    tally[side] = dict(c)
                context, title = (v["_ctx"][:600], v["_title"] or "覆議案") if "_ctx" in v else decision_context(text, v["no"], refs)
                if not title:
                    title = agenda_title_from_item(text, v["item"], sec_cache)
                short = ""
                dm = re.match(r"^決議：([^〔。]+)", context)
                if dm:
                    short = dm.group(1).strip()
                if not short or short.startswith("照") or len(short) < 8:
                    short = title or v["item"]
                results.append({
                    "id": f'{m["會議代碼"]}#{v["no"]}',
                    "short_title": short[:120],
                    "kind": "override" if "_ctx" in v else "normal",
                    "term": term,
                    "meeting": m["會議代碼"],
                    "dates": m.get("日期"),
                    "source_url": rec.get("source_url") or rec.get("ppg_url"),
                    "no": v["no"],
                    "item": v["item"],
                    "counts": v["counts"],
                    "by_party": tally,
                    "names": names,
                    "unknown_names": unknown,
                    "agenda_title": title,
                    "procedural": bool(PROCEDURAL.search(v["item"])),
                    "context": context,
                })
        print(f"第 {term} 屆完成，累計 {len(results)} 筆記名表決")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"已輸出 {out}")


if __name__ == "__main__":
    main()
