"""Server test fixtures from two saved runs, with every source value replaced by a synthetic one.

The server's read routes (join map, answer cells, replay, telemetry, USL) are tested against the
real SHAPE of a cold and a warm run of the demo question: the chain, the chunks, the planner calls,
the join map with its SQL and counts, the USL comparison, the answer rows and their provenance, the
evidence records. Source values never enter the repository (AGENTS.md rules 6 and 9): revenue values
and accession numbers (SEC), degree days (NOAA) and sample rows are replaced by deterministic
synthetic numbers that keep the sign of each change and the arithmetic of the answer (change =
current / previous - 1; a utility's degree days = the mean over its listed stations); rows of other
statements are dropped unless they are counts or schemas. Identifiers already in seeds/ (CIK, name,
ticker, state, station id, SIC) and counts stay. The script checks its own output: no real revenue
value, accession number or degree-day value of the inputs may appear in a fixture.

Run from the repository root on a machine that has the saved runs (data/ is not committed):

    python agent/test/fixtures/make_server_fixtures.py [--cold <run_id>] [--warm <run_id>]

Writes agent/test/fixtures/server-run-cold.json, server-run-warm.json and server-dq-latest.json.
Deterministic: the same inputs give byte-identical outputs.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
COLD = "r20261025T14571773a0"
WARM = "r20261025T145128a180"

# Statements whose rows are counts or schemas (kept); every other statement's rows are dropped.
KEEP_ROWS = re.compile(r"^(joinmap_\w+|dq_run|describe_object|distinct_counts|answer_fema_utilities|fema_by_state)$")
DETAIL_KEYS = ("tool", "id", "measure", "object", "columns", "status")
NOTE = (
    "Synthetic values: revenue values, accession numbers, degree days and sample rows are replaced by "
    "synthetic numbers (signs of changes and the answer arithmetic kept). Structure, SQL text, counts, "
    "timings and identifiers from seeds/ come from the saved run named in from_run."
)


def sign(x):
    return 0 if x is None else (1 if x > 0 else (-1 if x < 0 else 0))


def synth_revenue(answer):
    """cik -> {period: (val, accn)} for every answer row, keeping each change's sign."""
    out = {}
    for i, row in enumerate(answer["rows"]):
        rev = row.get("revenue") or {}
        prev = 1_000_000_000 + 25_000_000 * i
        cur = round(prev * (1 + sign(rev.get("change")) * 0.04 * (1 + i % 3))) if rev.get("change") is not None else 2_000_000_000 + 25_000_000 * i
        out[row["cik"]] = {"current": (cur, f"0000000000-26-{i + 1:06d}"), "previous": (prev, f"0000000000-25-{i + 1:06d}")}
    return out


def synth_weather(run):
    """(year, station) -> (hdd, cdd); years are the two weather statements' years."""
    provs = run["answer"]["rows"][0]["provenance"].get("weather") or [] if run["answer"]["rows"] else []
    if not provs:
        return {}
    stations = sorted(provs[0]["params"]["station_list"].split(","))
    years = sorted({p["params"]["year"] for p in provs})
    table = {}
    for j, st in enumerate(stations):
        for k, y in enumerate(years):
            table[(y, st)] = (round(1000 + 37 * j + 60 * k + 0.25, 2), round(10 + 3 * j + 0.5, 2))
    return table


def redact_rows(template, columns, rows, run, rev, wx, period=None, year=None):
    if template == "answer_revenue":
        cur_period = run["answer"]["quarter"]
        which = "current" if period == cur_period else "previous"
        out = []
        for n, r in enumerate(rows):
            cik = r[0]
            val, accn = rev.get(cik, {}).get(which, (900_000_000 + 1_000_000 * n, f"0000000000-24-{n + 1:06d}"))
            out.append([cik, r[1], val, accn])
        return out
    if template == "weather_quarter":
        cols = [c.lower() for c in columns]
        out = []
        for r in rows:
            r = list(r)
            hdd, cdd = wx.get((str(year), r[cols.index("station_id")]), (0.0, 0.0))
            r[cols.index("hdd")] = hdd
            r[cols.index("cdd")] = cdd
            out.append(r)
        return out
    if template and KEEP_ROWS.match(template):
        return rows
    return []


def build(run):
    run = copy.deepcopy(run)
    rev = synth_revenue(run["answer"]) if run.get("answer") else {}
    wx = synth_weather(run) if run.get("answer") else {}
    a = run.get("answer")
    if a:
        for row in a["rows"]:
            r = row.get("revenue")
            s = rev[row["cik"]]
            if r:
                if r.get("current") is not None:
                    r["current"] = s["current"][0]
                if r.get("previous") is not None:
                    r["previous"] = s["previous"][0]
                if r.get("current_accn"):
                    r["current_accn"] = s["current"][1]
                if r.get("previous_accn"):
                    r["previous_accn"] = s["previous"][1]
                if r.get("change") is not None:
                    r["change"] = r["current"] / r["previous"] - 1
            w = row.get("weather")
            if w and w.get("stations"):
                cy = a["quarter"][2:6]
                py = a["previous"][2:6]
                cur = [sum(wx.get((cy, st), (0, 0))) for st in w["stations"]]
                prv = [sum(wx.get((py, st), (0, 0))) for st in w["stations"]]
                w["tdd_current"] = sum(cur) / len(cur)
                w["tdd_previous"] = sum(prv) / len(prv)
                w["change"] = w["tdd_current"] / w["tdd_previous"] - 1
            for key, p in (row.get("provenance") or {}).items():
                for q in p if isinstance(p, list) else [p]:
                    q["rows"] = redact_rows(q.get("template"), q.get("columns") or [], q.get("rows") or [], run, rev, wx, q.get("params", {}).get("period"), q.get("params", {}).get("year"))
        for q in a.get("provenance") or []:
            q["rows"] = redact_rows(q.get("template"), q.get("columns") or [], q.get("rows") or [], run, rev, wx, q.get("params", {}).get("period"), q.get("params", {}).get("year"))
    for e in run.get("evidence") or []:
        if "rows" in e:
            e["rows"] = redact_rows(e.get("template_id"), e.get("columns") or [], e.get("rows") or [], run, rev, wx, (e.get("params") or {}).get("period"), (e.get("params") or {}).get("year"))
        if isinstance(e.get("details"), dict):
            d = e["details"]
            e["details"] = {k: d[k] for k in DETAIL_KEYS if k in d}
            if e["details"].get("columns") and not all(isinstance(c, dict) and set(c) <= {"name", "type"} for c in e["details"]["columns"]):
                del e["details"]["columns"]
    for reg in run.get("registrations") or []:
        for q in reg.get("provenance") or []:
            if "rows" in q:
                q["rows"] = redact_rows(q.get("template"), q.get("columns") or [], q.get("rows") or [], run, rev, wx)
    if run.get("memo"):
        run["memo"]["text"] = "Synthetic note for the server tests. It names no source value; the join map, the answer and the Not-tested list are in their own sections."
        run["memo"]["words"] = len(run["memo"]["text"].split())
        run["memo"]["attempts_detail"] = []
    run["evidence_file"] = None
    run["fixture"] = {"synthetic_values": True, "from_run": run["run_id"], "generator": "agent/test/fixtures/make_server_fixtures.py", "note": NOTE}
    return run


def real_values(run):
    """Every source value of the input that must not survive: revenue values, accession numbers, degree days."""
    vals = set()
    for row in (run.get("answer") or {}).get("rows", []):
        r = row.get("revenue") or {}
        for k in ("current", "previous"):
            if isinstance(r.get(k), (int, float)):
                vals.add(f"{r[k]:.0f}" if float(r[k]).is_integer() else repr(r[k]))
        for k in ("current_accn", "previous_accn"):
            if r.get(k):
                vals.add(r[k])
        for p in (row.get("provenance") or {}).get("weather") or []:
            cols = [c.lower() for c in p.get("columns") or []]
            for rr in p.get("rows") or []:
                for c in ("hdd", "cdd"):
                    v = rr[cols.index(c)]
                    if isinstance(v, float) and abs(v) >= 100:
                        vals.add(repr(v))
    return vals


def dump(obj, path):
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"
    path.write_text(text, encoding="utf-8", newline="\n")
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cold", default=COLD)
    ap.add_argument("--warm", default=WARM)
    ap.add_argument("--data", default=str(ROOT / "data"))
    args = ap.parse_args()
    data = Path(args.data)
    failures = []
    for name, rid in (("cold", args.cold), ("warm", args.warm)):
        src = json.loads((data / "runs" / rid / "run.json").read_text(encoding="utf-8"))
        text = dump(build(src), OUT / f"server-run-{name}.json")
        for v in sorted(real_values(src)):
            if v in text:
                failures.append(f"{name}: source value {v} survived")
        # No local path (a drive path, the checkout's parent folder) and no e-mail address.
        for pat in (r"[A-Za-z]:\\\\", re.escape(ROOT.parent.name) if ROOT.parent.name else None, r"[\w.+-]+@[\w-]+\.[a-z]{2,}"):
            if pat and re.search(pat, text):
                failures.append(f"{name}: forbidden text matching {pat!r}")
        print(f"server-run-{name}.json from {rid}: {len(text):,} bytes")
    dq = json.loads((data / "dq" / "latest.json").read_text(encoding="utf-8"))
    text = dump(dq, OUT / "server-dq-latest.json")
    print(f"server-dq-latest.json: {len(text):,} bytes")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
