"""Known-answer fixture generator for Crosswalk's discovery tools (tasks C4 and C5, and the host-run
tools in agent/src/tools/discovery.ts).

Writes crosswalk-discovery.json next to this file. Every expected value is computed here, in Python,
from the method as written in docs/cursor-tasks/C4 and C5 and in the tool rules below, independently
of the TypeScript under test. The catalogue and manifest inputs are copies of the committed
seeds/catalogue.json and zetaris/manifest.json taken when the generator runs; every other row
(FEMA catalogue rows, getting-started entries, probe samples, CIKs, values) is synthetic.

Run from the repository root:  python agent/test/fixtures/make_discovery_fixtures.py
"""

from __future__ import annotations

import json
import re
from itertools import combinations
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent

# ---------------------------------------------------------------- C4: catalogue search
STOPWORDS = {
    "a", "an", "the", "of", "in", "on", "and", "or", "for", "to", "by", "with", "what", "which",
    "did", "do", "does", "their", "that", "this", "is", "are", "was", "were", "how", "at", "from",
    "as", "it", "its", "per",
}
STATUS_RANK = {"verified": 0, "listed": 1, "unverified": 2, "deprecated": 3, "known_to_fail": 4}


def tokenize(text: str) -> list[str]:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text or "")
    out: list[str] = []
    for raw in re.split(r"[^a-z0-9]+", spaced.lower()):
        if len(raw) < 2 or raw in STOPWORDS:
            continue
        tok = raw
        if tok.endswith("ies") and len(tok) > 4:
            tok = tok[:-3] + "y"
        elif tok.endswith("s") and not tok.endswith("ss") and len(tok) > 3:
            tok = tok[:-1]
        if tok not in out:
            out.append(tok)
    return out


def object_of(zetaris_object):
    if not isinstance(zetaris_object, str) or not zetaris_object.strip():
        return None
    s = zetaris_object
    if "->" in s:
        s = s.split("->", 1)[1]
    s = s.strip()
    return s.split()[0] if s else None


def entries_from_catalogue(catalogue: dict) -> list[dict]:
    return [{
        "id": e["id"], "kind": e["kind"], "object": object_of(e.get("zetaris_object")),
        "status": e["status"], "licence": e.get("licence", ""), "note": e.get("note", ""),
    } for e in catalogue["entries"]]


def entries_from_manifest(manifest: dict, prefix: str = "") -> list[dict]:
    out = []
    for s in manifest["sources"]:
        objs = s.get("objects") or {}
        names: list[str] = []
        for key in ("views", "view", "frames", "submission", "usl"):
            v = objs.get(key)
            if isinstance(v, str):
                names.append(v)
            elif isinstance(v, list):
                names.extend(x for x in v if isinstance(x, str))
        base = {"kind": "registered_view" if not prefix else s.get("kind", ""), "status": s.get("status", ""),
                "licence": "", "note": s.get("summary", "")}
        if names and not prefix:
            for n in names:
                out.append({"id": f"{s['id']}:{n}", "object": n, **base})
        else:
            out.append({"id": f"{prefix}{s['id']}", "object": None, **base})
    return out


def entries_from_fema_catalogue(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        note = str(r.get("title") or "")
        if r.get("api_endpoint"):
            note = f"{note} {r['api_endpoint']}".strip()
        out.append({"id": f"openfema:{r['name']}@v{r['version']}", "kind": "openfema_dataset", "object": None,
                    "status": "listed", "licence": "", "note": note})
    return out


def entry_tokens(e: dict) -> set[str]:
    return set(tokenize(" ".join([e["id"], e["kind"], e["object"] or "", e["note"]])))


def search(query: str, entries: list[dict], limit: int = 8) -> list[dict]:
    q = tokenize(query)
    hits = []
    for e in entries:
        score = sum(1 for t in q if t in entry_tokens(e))
        if score > 0:
            hits.append({**e, "note": e["note"][:200], "score": score, "negative": e["status"] == "known_to_fail"})
    hits.sort(key=lambda h: (-h["score"], STATUS_RANK.get(h["status"], 5), h["id"]))
    return hits[:limit]


# ---------------------------------------------------------------- C4: candidate key columns
KEY_PATTERNS = ["cik", "state", "id", "code", "fips", "disasternumber", "sic", "loc", "period"]
NON_KEY_TYPES = {"double", "float", "decimal"}


def norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def candidate_key_columns(columns: list[dict], limit: int = 3) -> list[str]:
    ranked = []
    for i, c in enumerate(columns):
        if c["type"].lower().split("(")[0] in NON_KEY_TYPES:
            continue
        n = norm(c["name"])
        found = None
        for p_i, p in enumerate(KEY_PATTERNS):
            if n == p:
                found = (0, p_i)
                break
        if found is None:
            for p_i, p in enumerate(KEY_PATTERNS):
                if n.startswith(p) or n.endswith(p):
                    found = (1, p_i)
                    break
        if found is not None:
            ranked.append((found[0], found[1], i, c["name"]))
    ranked.sort()
    return [r[3] for r in ranked[:limit]]


# ---------------------------------------------------------------- C5: the deterministic key baseline
CLASS_ORDER = ["cik", "station_id", "sic", "state", "fips_state", "fips_county"]
SPECIFIC = {"cik", "station_id", "sic", "fips_state", "fips_county"}
REFUSED = re.compile(r"^won[_.]", re.I)


def key_class(obj: str, column: str):
    n = norm(column)
    o = obj.lower()
    if "cik" in n:
        return "cik"
    if n.startswith("fips"):
        return "fips_county" if "county" in n else "fips_state"
    if "sic" in n:
        return "sic"
    if n == "loc":
        return "state"
    if n == "state" or n.endswith("state"):
        return "state"
    if n == "code":
        if "state" in o:
            return "state"
        if "sic" in o:
            return "sic"
        return None
    if n == "id" and "station" in o:
        return "station_id"
    return None


SHORT_INT = re.compile(r"^\d{1,9}$")
CIK10 = re.compile(r"^\d{10}$")
US_LOC = re.compile(r"^US-[A-Z]{2}$")
STATE2 = re.compile(r"^[A-Z]{2}$")


def all_match(rx, values):
    return len(values) > 0 and all(rx.match(v) for v in values)


def transform_from_samples(a: list[str], b: list[str]):
    """(transform, transformed side 'a' | 'b' | None)."""
    if all_match(SHORT_INT, a) and all_match(CIK10, b):
        return "lpad10", "a"
    if all_match(SHORT_INT, b) and all_match(CIK10, a):
        return "lpad10", "b"
    if all_match(US_LOC, a) and all_match(STATE2, b):
        return "substr(4,2)", "a"
    if all_match(US_LOC, b) and all_match(STATE2, a):
        return "substr(4,2)", "b"
    return "identity", None


def distinct_of(c):
    return c["distinct"] if isinstance(c.get("distinct"), int) else None


def baseline(probes: list[dict], limit: int = 6) -> list[dict]:
    usable = [(i, p) for i, p in enumerate(probes) if not REFUSED.match(p["object"])]
    out = []
    for (ia, pa), (ib, pb) in combinations(usable, 2):
        if pa["object"] == pb["object"]:
            continue
        for ca in pa["candidates"]:
            cls = key_class(pa["object"], ca["column"])
            if cls is None:
                continue
            for cb in pb["candidates"]:
                if key_class(pb["object"], cb["column"]) != cls:
                    continue
                transform, side = transform_from_samples(ca["samples"], cb["samples"])
                da, db = distinct_of(ca), distinct_of(cb)
                if side == "a":
                    left, right, il, ir = (pa, ca), (pb, cb), ia, ib
                elif side == "b":
                    left, right, il, ir = (pb, cb), (pa, ca), ib, ia
                else:
                    a_first = not (da is not None and db is not None and db < da)
                    left, right, il, ir = ((pa, ca), (pb, cb), ia, ib) if a_first else ((pb, cb), (pa, ca), ib, ia)
                reasons = []
                score = 0
                if transform != "identity":
                    score += 2
                    reasons.append(f"samples need {transform}")
                if norm(ca["column"]) == norm(cb["column"]):
                    score += 1
                    reasons.append("same column name")
                dl, dr = distinct_of(left[1]), distinct_of(right[1])
                if dl is not None and dr is not None and dr >= dl:
                    score += 1
                    reasons.append("right side has at least as many distinct keys")
                if cls in SPECIFIC:
                    score += 1
                    reasons.append(f"specific key class {cls}")
                out.append({
                    "left": {"object": left[0]["object"], "column": left[1]["column"]},
                    "right": {"object": right[0]["object"], "column": right[1]["column"]},
                    "transform": transform, "key_class": cls, "score": score, "reasons": reasons,
                    "_sort": (-score, CLASS_ORDER.index(cls), il, ir, left[1]["column"], right[1]["column"]),
                })
    out.sort(key=lambda c: c["_sort"])
    for c in out:
        del c["_sort"]
    return out[:limit]


def probe(obj, *cands):
    return {"object": obj, "candidates": [{"column": c, "distinct": d, "rows": r, "samples": s} for c, d, r, s in cands]}


def demo_probes() -> list[dict]:
    """Synthetic probes shaped like the Crosswalk sources (made-up CIKs 0009000001.., states, ids)."""
    return [
        probe("cw.seed_submissions_snapshot",
              ("cik10", 43, 43, ["0009000001", "0009000002", "0009000003"]),
              ("sic", 4, 43, ["4911", "4931", "4900"]),
              ("hq_state", 30, 43, ["CA", "OH", "WI"])),
        probe("cw.frames_Revenues_CY2025Q1",
              ("cik", 1900, 1900, ["9000001", "9000002", "12345"]),
              ("loc", 55, 1900, ["US-CA", "US-OH", "US-NY"])),
        probe("cw.fema_declarations_dr_2025q1",
              ("state", 8, 116, ["KY", "CA", "AK"]),
              ("disaster_number", 10, 116, ["9001", "9002"]),
              ("fips_state_code", 8, 116, ["21", "06", "02"])),
        probe("cw.utility_states",
              ("cik", 43, 97, ["0009000001", "0009000002"]),
              ("state", 43, 97, ["CA", "OH"])),
        probe("cw.states",
              ("code", 51, 51, ["CA", "OH", "KY"]),
              ("fips", 51, 51, ["06", "39", "21"])),
        probe("cw.seed_stations",
              ("state", 43, 56, ["CA", "OH"]),
              ("id", 56, 56, ["USW00099001", "USW00099002"])),
        probe("cw.stations",
              ("state", 52, 133000, ["CA", "", "OH"]),
              ("id", 133000, 133000, ["USW00099001", "CA000000001"])),
        probe("cw.sic_codes",
              ("code", 1005, 1005, ["4911", "4931", "0100"])),
    ]


# ---------------------------------------------------------------- the governed USL plan (seeds/usl-plan.json)
COL_RE = re.compile(r"^(\w+)\s+(varchar\(\d+\)|int|double)(.*)$")
FK_RE = re.compile(r"FOREIGN KEY REFERENCES (\w+)\((\w+)\)")
# revenue_quarter.cik is activated as LPAD(CAST(f.cik AS STRING), 10, '0'); every other FK joins as stored.
FK_TRANSFORMS = {"revenue_quarter.cik": "lpad10"}


def governed_plan(sql_text: str) -> tuple[dict, str]:
    """The plan of zetaris/sql/07_cw_usl_create.sql and the COMPILE statement as written there (no trailing semicolon)."""
    start = sql_text.index("COMPILE USL IF NOT EXISTS")
    end = sql_text.index(";\n\n", sql_text.index("CREATE TABLE revenue_quarter", start))
    compile_sql = sql_text[start:end]
    head, *blocks = re.split(r";\nCREATE TABLE ", compile_sql.replace("DDL\nCREATE TABLE ", "DDL\n;\nCREATE TABLE ", 1))
    m = re.match(r"COMPILE USL IF NOT EXISTS (\w+) DEPLOY NAMESPACE ([\w.]+) DDL", head)
    usl, namespace = m.group(1), m.group(2)
    descriptions = dict(re.findall(r"UPDATE USL [\w.]+\.crosswalk_usl\.(\w+) SET TABLE DESCRIPTION (.+?);\n", sql_text))
    model_desc = re.search(r"UPDATE USL [\w.]+\.crosswalk_usl SET DESCRIPTION (.+?);\n", sql_text).group(1)
    sources = {}
    for table, body in re.findall(r"ACTIVATE USL TABLE [\w.]+\.crosswalk_usl\.(\w+) AS\n(.*?);\n", sql_text, re.S):
        sources[table] = ", ".join(sorted(set(re.findall(r"\bcw\.\w+", body))))
    tables, fks = [], []
    for block in blocks:
        name, rest = block.split(" (\n", 1)
        lines = [ln.strip().rstrip(",") for ln in rest.rsplit("\n)", 1)[0].split("\n")]
        columns, pk = [], []
        for ln in lines:
            if ln.startswith("PRIMARY KEY ("):
                pk = [c.strip() for c in ln[len("PRIMARY KEY ("):-1].split(",")]
                continue
            cm = COL_RE.match(ln)
            col, typ, tail = cm.group(1), cm.group(2), cm.group(3)
            columns.append({"name": col, "type": typ, "nullable": "NOT NULL" not in tail})
            if "PRIMARY KEY" in tail and "FOREIGN" not in tail.split("PRIMARY KEY")[0]:
                pk = [col]
            fm = FK_RE.search(tail)
            if fm:
                fks.append({"from": f"{name}.{col}", "to": f"{fm.group(1)}.{fm.group(2)}",
                            "transform": FK_TRANSFORMS.get(f"{name}.{col}", "identity")})
        tables.append({"name": name, "source": sources[name], "description": descriptions[name], "columns": columns, "pk": pk})
    plan = {
        "_comment": "The governed USL lightning.metastore.crosswalk.crosswalk_usl as compiled on 2026-10-25 (zetaris/sql/07_cw_usl_create.sql), "
                    "written by agent/test/fixtures/make_discovery_fixtures.py. compile_usl diffs the plan rendered from a run's verified keys against it.",
        "usl": usl, "namespace": namespace, "description": model_desc, "tables": tables, "fks": fks,
    }
    return plan, compile_sql


# ---------------------------------------------------------------- host-run tools (discovery.ts): known answers
VERIFIED_AT, PARTIAL_AT = 0.95, 0.80


def verdict(rate: float) -> str:
    return "VERIFIED" if rate >= VERIFIED_AT else "PARTIAL" if rate >= PARTIAL_AT else "REJECTED"


def measure_case(name, proposal, counts_cols, counts_row, orphan_cols=None, orphan_rows=None, known=None, route=None, key=None, orientation=None):
    rec = dict(zip(counts_cols, counts_row)) if counts_row is not None else None
    case = {"name": name, "proposal": proposal, "known_templates": known,
            "replies": {}, "expected": {"status": "unmeasurable", "route": None, "key": None}}
    if rec is None:
        return case
    lk, mk = rec["left_keys"], rec["matched_keys"]
    lr, mr = rec.get("left_rows", lk), rec.get("matched_rows", mk)
    case["replies"]["counts"] = {"columns": counts_cols, "rows": [counts_row]}
    orphans = []
    if orphan_cols and mr < lr:
        case["replies"]["orphans"] = {"columns": orphan_cols, "rows": orphan_rows}
        for r in orphan_rows[:10]:
            first, *rest = [str(v) for v in r]
            rest = [x for x in rest if x != ""]
            orphans.append(f"{first} ({', '.join(rest)})" if rest else first)
    rate = 0 if lr == 0 else mr / lr
    extra = {"state_equal": rec["state_equal"]} if "state_equal" in rec else {}
    case["expected"] = {"status": "measured", "route": route, "key": key, "left_rows": lr, "matched_rows": mr, "left_keys": lk,
                        "matched_keys": mk, "rate": rate, "rate_distinct": 0 if lk == 0 else mk / lk, "verdict": verdict(rate),
                        "orphans": orphans, "extra": extra, "orientation": orientation}
    return case


def choice(lo, lc, ro, rc, t):
    return {"left": {"object": lo, "column": lc}, "right": {"object": ro, "column": rc}, "transform": t}


def orient(left, right, on):
    """D18: the canonical orientation of the statement (left = the side whose rows are counted)."""
    return {"left": left, "right": right, "transform_on": on}


def measure_cases() -> list[dict]:
    jm = ["joinmap_cik", "joinmap_cik_orphans", "joinmap_loc", "joinmap_fema_state", "joinmap_fema_state_orphans",
          "joinmap_station", "joinmap_sic", "joinmap_sic_orphans"]
    mr = jm + ["match_rate", "match_rate_orphans"]
    f25 = "cw.frames_Revenues_CY2025Q1"
    snap = "cw.seed_submissions_snapshot"
    return [
        measure_case("cik_lpad10_frames_first", choice(f25, "cik", snap, "cik10", "lpad10"),
                     ["left_keys", "matched_keys"], [43, 42], ["orphan_cik", "name"], [["0009000099", "SYNTHETIC UTILITY A"]],
                     jm, "cik", "cik@CY2025Q1", orient(f"{snap}.cik10", "cw.frames_*_CY2025Q1.cik", "right")),
        measure_case("sic_rows_and_codes", choice(snap, "sic", "cw.sic_codes", "code", "identity"),
                     ["left_keys", "matched_keys", "left_rows", "matched_rows"], [4, 3, 43, 42],
                     ["orphan_sic", "cik", "name"], [["4900", "0009000042", "SYNTHETIC UTILITY B"]], jm, "sic", "sic@all",
                     orient(f"{snap}.sic", "cw.sic_codes.code", "left")),
        measure_case("fema_state_partial", choice("cw.fema_declarations_dr_2025q1", "state", "cw.utility_states", "state", "identity"),
                     ["left_keys", "matched_keys"], [8, 7], ["orphan_state"], [["AK"]], jm, "fema_state", "fema_state@CY2025Q1",
                     orient("cw.fema_declarations_dr_2025q1.state", "cw.utility_states.state", "left")),
        measure_case("fema_state_proposed_reversed", choice("cw.utility_states", "state", "cw.fema_declarations_dr_2025q1", "state", "identity"),
                     ["left_keys", "matched_keys"], [8, 7], ["orphan_state"], [["AK"]], jm, "fema_state", "fema_state@CY2025Q1",
                     orient("cw.fema_declarations_dr_2025q1.state", "cw.utility_states.state", "left")),
        measure_case("station_reversed", choice("cw.stations", "id", "cw.seed_stations", "id", "identity"),
                     ["left_keys", "matched_keys", "state_equal"], [56, 56, 55], None, None, jm, "station", "station@all",
                     orient("cw.seed_stations.id", "cw.stations.id", "left")),
        measure_case("loc_substr", choice(f25, "loc", snap, "hq_state", "substr(4,2)"),
                     ["left_keys", "matched_keys"], [42, 42], None, None, jm, "loc", "loc@CY2025Q1",
                     orient("cw.frames_*_CY2025Q1.loc", f"{snap}.hq_state", "left")),
        measure_case("cik_identity_no_control_template", choice(snap, "cik10", f25, "cik", "identity"),
                     None, None, known=jm),
        measure_case("cik_identity_control", choice(snap, "cik10", f25, "cik", "identity"),
                     ["left_keys", "matched_keys"], [43, 0], None, None, jm + ["joinmap_cik_control"], "cik_control", "cik_control@CY2025Q1",
                     orient(f"{snap}.cik10", "cw.frames_*_CY2025Q1.cik", "right")),
        measure_case("unrouted_pair", choice("cw.utility_states", "cik", snap, "cik10", "identity"), None, None, known=jm),
        measure_case("loc_strip_prefix_not_routed", choice(f25, "loc", snap, "hq_state", "strip_prefix('US-')"),
                     None, None, known=jm),
        # D16: with the gateway's match_rate template, a pair no named statement measures is measured as proposed.
        measure_case("generic_pair_match_rate", choice("cw.utility_states", "state", "cw.states", "code", "identity"),
                     ["left_keys", "matched_keys"], [43, 43], None, None, mr, "match_rate",
                     "pair:cw.utility_states.state~cw.states.code|identity",
                     orient("cw.utility_states.state", "cw.states.code", "left")),
        measure_case("generic_pair_with_orphans", choice(f25, "loc", "cw.states", "code", "substr(4,2)"),
                     ["left_keys", "matched_keys"], [53, 49], ["orphan"], [["AS"], ["GU"], ["PR"], ["VI"]], mr, "match_rate",
                     "pair:cw.frames_revenues_cy2025q1.loc~cw.states.code|substr(4,2)",
                     orient(f"{f25}.loc", "cw.states.code", "left")),
    ]

# FK -> what supports it (the same rule the TypeScript states; recomputed here for the expected status).
FK_SUPPORT = {
    "utility.sic -> sic_code.sic": ("key", "sic"),
    "revenue_quarter.cik -> utility.cik": ("key", "cik"),
    "station.state -> state.code": ("key", "station"),
    "fema_declaration.state -> state.code": ("live_dq", "fema_declaration.state"),
    "utility_state.state -> state.code": ("live_dq", "utility_state.state"),
    "utility_state.cik -> utility.cik": ("onboarding_dq", "utility_state.cik"),
}


def compile_case(name, plan, verified_routes, live, onboarding):
    """live: rule -> (total, valid, invalid); onboarding: rule -> (total, valid, invalid) or None (no file)."""
    missing = []
    for fk in plan["fks"]:
        fkn = f"{fk['from']} -> {fk['to']}"
        kind, ref = FK_SUPPORT[fkn]
        if kind == "key":
            ok = ref in verified_routes
        elif kind == "live_dq":
            t = live.get(ref)
            ok = bool(t and t[0] and t[1] / t[0] >= VERIFIED_AT)
        else:
            t = (onboarding or {}).get(ref)
            ok = True if t is None else bool(t[0] and t[1] / t[0] >= VERIFIED_AT)
        if not ok:
            missing.append(fkn)
    return {"name": name, "verified_routes": verified_routes,
            "live": {k: {"columns": ["total", "valid", "invalid"], "rows": [list(v)]} for k, v in live.items()},
            "onboarding": None if onboarding is None else {
                "ran_at": "2026-10-25T10:00:00+08:00",
                "rules": [{"rule": k, "total": v[0], "valid": v[1], "invalid": v[2], "elapsed_s": 1.5} for k, v in onboarding.items()],
                "invalid_rows": [{"rule": "utility.sic", "row": ["0009000042", "SYNTHETIC UTILITY B", "SYN", "4900"]}]},
            "expected": {"matches_governed": not missing, "status": "matches_governed" if not missing else "new_version",
                         "usl": "crosswalk_usl" if not missing else "crosswalk_usl_v2", "missing_fks": missing,
                         "fks_in_ddl": len(plan["fks"]) - len(missing)}}


def answer_case() -> dict:
    """Synthetic answer_fema_utilities / answer_revenue / weather_quarter replies and the expected table."""
    fema_cols = ["cik", "name", "ticker", "state", "declarations", "severe_storm", "fire", "flood", "other_incidents"]
    fema_rows = [
        ["0009000001", "SYNTHETIC POWER A", "SYA", "KY", 1, 1, 0, 0, 0],
        ["0009000002", "SYNTHETIC POWER B", None, "CA", 1, 0, 1, 0, 0],
        ["0009000002", "SYNTHETIC POWER B", None, "OR", 1, 1, 0, 0, 0],
        ["0009000003", "SYNTHETIC POWER C", "SYC", "WV", 1, 1, 0, 0, 0],
    ]
    rev_cols = ["cik", "xbrl_tag", "val", "accn"]
    rev_cur = [["0009000001", "Revenues", 1200.0, "0009000001-25-000001"],
               ["0009000002", "Revenues", 900.0, "0009000002-25-000001"],
               ["0009000003", "RegulatedAndUnregulatedOperatingRevenue", 500.0, "0009000003-25-000001"]]
    rev_prev = [["0009000001", "Revenues", 1000.0, "0009000001-24-000001"],
                ["0009000003", "Revenues", 450.0, "0009000003-24-000001"]]
    w_cols = ["station_id", "year", "quarter", "hdd", "cdd", "days_observed", "days_in_quarter", "coverage"]
    w_cur = [["USW00099001", 2025, 1, 2000.0, 10.0, 90, 90, 1.0], ["USW00099002", 2025, 1, 1500.0, 30.0, 90, 90, 1.0],
             ["USW00099003", 2025, 1, 1800.0, 0.0, 70, 90, 0.7778]]
    w_prev = [["USW00099001", 2024, 1, 1800.0, 20.0, 91, 91, 1.0], ["USW00099002", 2024, 1, 1400.0, 20.0, 91, 91, 1.0],
              ["USW00099003", 2024, 1, 1700.0, 0.0, 91, 91, 1.0]]
    stations = {"0009000001": ["USW00099001", "USW00099002"], "0009000002": ["USW00099003"], "0009000003": []}

    def wcell(ids):
        def tdd(rows):
            return {r[0]: r[3] + r[4] for r in rows if r[7] >= 0.9}
        c, p = tdd(w_cur), tdd(w_prev)
        used = [s for s in ids if s in c and s in p]
        if not used:
            return None
        mc, mp = sum(c[s] for s in used) / len(used), sum(p[s] for s in used) / len(used)
        return {"stations": used, "tdd_current": mc, "tdd_previous": mp, "change": mc / mp - 1}

    by_cik: dict[str, dict] = {}
    for r in fema_rows:
        rec = dict(zip(fema_cols, r))
        u = by_cik.setdefault(rec["cik"], {"cik": rec["cik"], "name": rec["name"], "ticker": rec["ticker"], "states": [],
                                            "declarations": 0, "by_incident_type": {}})
        bt = {k: rec[k] for k in ["severe_storm", "fire", "flood", "other_incidents"]}
        u["states"].append({"state": rec["state"], "declarations": rec["declarations"], "by_incident_type": bt})
        u["declarations"] += rec["declarations"]
        for k, v in bt.items():
            u["by_incident_type"][k] = u["by_incident_type"].get(k, 0) + v
    cur = {r[0]: dict(zip(rev_cols, r)) for r in rev_cur}
    prev = {r[0]: dict(zip(rev_cols, r)) for r in rev_prev}
    expected = []
    for u in sorted(by_cik.values(), key=lambda x: (-x["declarations"], x["name"], x["cik"])):
        c, p = cur.get(u["cik"]), prev.get(u["cik"])
        if c is None:
            rev = None
        elif p is None:
            rev = {"tag": c["xbrl_tag"], "current": c["val"], "previous": None, "change": None, "current_accn": c["accn"],
                   "previous_accn": None, "note": "no fact a year earlier"}
        elif p["xbrl_tag"] != c["xbrl_tag"]:
            rev = {"tag": c["xbrl_tag"], "current": c["val"], "previous": None, "change": None, "current_accn": c["accn"],
                   "previous_accn": p["accn"], "note": f"a year earlier the first available tag is {p['xbrl_tag']}, not {c['xbrl_tag']}: not compared"}
        else:
            rev = {"tag": c["xbrl_tag"], "current": c["val"], "previous": p["val"], "change": c["val"] / p["val"] - 1,
                   "current_accn": c["accn"], "previous_accn": p["accn"], "note": None}
        expected.append({**u, "revenue": rev, "weather": wcell(stations[u["cik"]])})
    return {"quarter": "CY2025Q1", "stations_by_cik": stations,
            "replies": {"fema": {"columns": fema_cols, "rows": fema_rows}, "revenue_current": {"columns": rev_cols, "rows": rev_cur},
                        "revenue_previous": {"columns": rev_cols, "rows": rev_prev}, "weather_current": {"columns": w_cols, "rows": w_cur},
                        "weather_previous": {"columns": w_cols, "rows": w_prev}},
            "expected_order": [e["cik"] for e in expected], "expected": expected}


def registered_objects_py(manifest: dict) -> list[str]:
    out: list[str] = []
    for s in manifest["sources"]:
        objs = s.get("objects") or {}
        names: list[str] = []
        for key in ("views", "view", "frames"):
            v = objs.get(key)
            if isinstance(v, str):
                names.append(v)
            elif isinstance(v, list):
                names.extend(x for x in v if isinstance(x, str))
        for n in names:
            if n == "cw.frames_<tag>_<period>":
                out += [f"cw.frames_{t}_{p}" for p in ("CY2025Q1", "CY2024Q1")
                        for t in ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RegulatedAndUnregulatedOperatingRevenue")]
            elif re.fullmatch(r"cw\.[A-Za-z0-9_]+", n):
                out.append(n)
    return list(dict.fromkeys(out))


def registrations_needed(quarter: str, registered: set[str]) -> list[dict]:
    year, q = int(quarter[2:6]), int(quarter[7])
    out = [{"catalogue_id": "openfema_disaster_declarations", "params": {"quarter": quarter}, "object": f"cw.fema_declarations_dr_{year}q{q}"}]
    if q == 4:
        return out
    low = {o.lower() for o in registered}
    for period in (quarter, f"CY{year - 1}Q{q}"):
        for tag in ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RegulatedAndUnregulatedOperatingRevenue"):
            obj = f"cw.frames_{tag}_{period}"
            if obj.lower() not in low:
                out.append({"catalogue_id": "sec_frames", "params": {"tag": tag, "period": period}, "object": obj})
    return out


# ---------------------------------------------------------------- inputs
def fema_catalogue_rows() -> list[dict]:
    """Synthetic rows in the shape of cw.fema_catalogue (dataset names are public; versions and titles made up)."""
    return [
        {"name": "DisasterDeclarationsSummaries", "version": 2, "title": "Disaster Declarations Summaries (synthetic title)",
         "api_endpoint": "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries", "last_dataset_refresh": "2026-10-25T00:00:00.000Z"},
        {"name": "FemaWebDisasterDeclarations", "version": 1, "title": "FEMA Web Disaster Declarations (synthetic title)",
         "api_endpoint": "https://www.fema.gov/api/open/v1/FemaWebDisasterDeclarations", "last_dataset_refresh": "2026-10-20T00:00:00.000Z"},
        {"name": "PublicAssistanceProjectsStatus", "version": 1, "title": "Public Assistance Projects Status (synthetic title)",
         "api_endpoint": "https://www.fema.gov/api/open/v1/PublicAssistanceProjectsStatus", "last_dataset_refresh": "2026-10-19T00:00:00.000Z"},
        {"name": "NfipResidentialPenetrationRates", "version": 1, "title": "NFIP Residential Penetration Rates (synthetic title)",
         "api_endpoint": "", "last_dataset_refresh": "2026-09-01T00:00:00.000Z"},
    ]


def getting_started() -> dict:
    """Synthetic entries in the shape of the getting-started manifest (ids and statuses as the vendor lists them)."""
    return {"version": 1, "sources": [
        {"id": "pudl", "kind": "filestore", "status": "known_to_fail",
         "summary": "Public Utility Data Liberation project electricity utility data (synthetic summary)"},
        {"id": "nasa_donki", "kind": "rest", "status": "known_to_fail",
         "summary": "Space weather notifications (synthetic summary)"},
        {"id": "company_dns", "kind": "rest", "status": "verified",
         "summary": "US SIC code hierarchy from the company_dns service (synthetic summary)"},
    ]}


def main() -> None:
    catalogue = json.loads((REPO / "seeds" / "catalogue.json").read_text(encoding="utf-8"))
    manifest = json.loads((REPO / "zetaris" / "manifest.json").read_text(encoding="utf-8"))
    fema_rows = fema_catalogue_rows()
    gs = getting_started()
    entries = (entries_from_catalogue(catalogue) + entries_from_manifest(manifest)
               + entries_from_fema_catalogue(fema_rows) + entries_from_manifest(gs, prefix="gs:"))
    queries = [
        ("FEMA major disaster declarations by state", 8),
        ("utility revenue SEC frames", 8),
        ("weather stations GHCN state", 5),
        ("SIC code reference", 4),
        ("electric utility data PUDL", 6),
        ("zzz nothing matches qqq", 8),
    ]
    tokenize_cases = ["DisasterDeclarationsSummaries", "utilities served states", "the FEMA's Q1-2025 DR filter",
                      "cw.fema_declarations_dr_2025q1", "glass ss bus"]
    probe_cases = [
        {"object": "cw.fema_declarations_dr_2025q1", "columns": [
            {"name": n, "type": "string"} for n in ["disaster_number", "state", "declaration_date", "incident_type",
                                                     "declaration_title", "declaration_type", "fips_state_code",
                                                     "fips_county_code", "designated_area"]]},
        {"object": "cw.frames_Revenues_CY2025Q1", "columns": [
            {"name": "cik", "type": "bigint"}, {"name": "entityName", "type": "string"}, {"name": "loc", "type": "string"},
            {"name": "start", "type": "string"}, {"name": "end", "type": "string"}, {"name": "val", "type": "double"},
            {"name": "accn", "type": "string"}]},
        {"object": "cw.seed_utilities", "columns": [
            {"name": n, "type": "string"} for n in ["cik", "name", "ticker", "sic", "hq_state"]]},
        {"object": "cw.stations", "columns": [
            {"name": "id", "type": "string"}, {"name": "state", "type": "string"}, {"name": "name", "type": "string"},
            {"name": "latitude", "type": "double"}, {"name": "longitude", "type": "double"}]},
        {"object": "cw.sic_codes", "columns": [
            {"name": n, "type": "string"} for n in ["code", "description", "division", "division_desc", "major_group",
                                                     "major_group_desc"]]},
        {"object": "cw.fema_catalogue", "columns": [
            {"name": n, "type": "string"} for n in ["name", "version", "title", "api_endpoint", "last_dataset_refresh"]]},
        {"object": "cw.synthetic_wide", "columns": [
            {"name": "period", "type": "string"}, {"name": "state_fips", "type": "string"}, {"name": "loc_id", "type": "string"},
            {"name": "CIK", "type": "string"}, {"name": "score_id", "type": "double"}, {"name": "zip", "type": "string"}]},
    ]
    for c in probe_cases:
        c["expected"] = candidate_key_columns(c["columns"])
        c["expected_max_2"] = candidate_key_columns(c["columns"], 2)

    probes = demo_probes()
    no_samples = [{**p, "candidates": [{**c, "samples": []} for c in p["candidates"]]} for p in probes]
    with_won = probes[:2] + [probe("won.seed_utilities", ("cik", 43, 43, ["0009000001"]))]
    baseline_cases = [
        {"name": "demo_shape_limit_6", "probes": probes, "limit": 6},
        {"name": "demo_shape_limit_30", "probes": probes, "limit": 30},
        {"name": "no_samples_identity_only", "probes": no_samples, "limit": 6},
        {"name": "won_object_refused", "probes": with_won, "limit": 6},
    ]
    for c in baseline_cases:
        c["expected"] = baseline(c["probes"], c["limit"])
    key_class_cases = [
        {"object": o, "column": col, "expected": key_class(o, col)} for o, col in [
            ("cw.seed_utilities", "cik"), ("cw.frames_x", "loc"), ("cw.states", "code"), ("cw.sic_codes", "code"),
            ("cw.other", "code"), ("cw.seed_stations", "id"), ("cw.other", "id"), ("cw.fema_x", "fips_state_code"),
            ("cw.fema_x", "fips_county_code"), ("cw.seed_utilities", "hq_state"), ("cw.fema_x", "disaster_number"),
            ("cw.states", "fips")]]
    transform_cases = [
        {"a": a, "b": b, "expected": list(transform_from_samples(a, b))} for a, b in [
            (["12345", "9000001"], ["0009000001"]), (["0009000001"], ["12345"]), (["US-CA", "US-NY"], ["CA"]),
            (["CA"], ["US-CA"]), (["US-CA", "CA"], ["CA"]), ([], ["0009000001"]), (["CA"], ["OH"])]]

    plan, compile_sql = governed_plan((REPO / "zetaris" / "sql" / "07_cw_usl_create.sql").read_text(encoding="utf-8"))
    (REPO / "seeds" / "usl-plan.json").write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8", newline="\n")
    all_routes = ["cik", "loc", "fema_state", "station", "sic"]
    ok_live = {"fema_declaration.state": (116, 116, 0), "utility_state.state": (97, 97, 0)}
    onboarding = {"utility.sic": (43, 42, 1), "utility_state.cik": (97, 97, 0)}
    compile_cases = [
        compile_case("all_keys_verified", plan, all_routes, ok_live, onboarding),
        compile_case("sic_key_not_measured", plan, ["cik", "loc", "fema_state", "station"], ok_live, onboarding),
        compile_case("fema_rule_fails_no_onboarding_file", plan, all_routes,
                     {"fema_declaration.state": (116, 100, 16), "utility_state.state": (97, 97, 0)}, None),
    ]
    registered = set(registered_objects_py(manifest))
    discovery_tools = {
        "governed": {"plan_file": "seeds/usl-plan.json", "compile_sql": compile_sql, "tables": len(plan["tables"]), "fks": len(plan["fks"])},
        "registered_objects": sorted(registered),
        "measure": measure_cases(),
        "compile": compile_cases,
        "answer": answer_case(),
        "registrations": [{"quarter": q, "expected": registrations_needed(q, registered)} for q in ("CY2025Q1", "CY2024Q1", "CY2025Q4")],
    }

    payload = {
        "synthetic": True,
        "note": "catalogue and manifest are copies of the committed seeds/catalogue.json and zetaris/manifest.json; every other value is synthetic",
        "search": {
            "inputs": {"catalogue": catalogue, "manifest": manifest, "fema_catalogue_rows": fema_rows, "getting_started": gs},
            "entries": entries,
            "tokenize": [{"text": t, "expected": tokenize(t)} for t in tokenize_cases],
            "cases": [{"query": q, "limit": n, "expected": search(q, entries, n)} for q, n in queries],
        },
        "probe": {"cases": probe_cases},
        "baseline": {"key_class": key_class_cases, "transform": transform_cases, "cases": baseline_cases},
        "tools": discovery_tools,
    }
    path = HERE / "crosswalk-discovery.json"
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path.name}: {len(entries)} catalogue entries, {len(queries)} search cases, "
          f"{len(probe_cases)} probe cases, {len(baseline_cases)} baseline cases")


if __name__ == "__main__":
    main()
