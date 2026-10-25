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
        probe("cw.seed_utilities",
              ("cik", 43, 43, ["0009000001", "0009000002", "0009000003"]),
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
    }
    path = HERE / "crosswalk-discovery.json"
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path.name}: {len(entries)} catalogue entries, {len(queries)} search cases, "
          f"{len(probe_cases)} probe cases, {len(baseline_cases)} baseline cases")


if __name__ == "__main__":
    main()
