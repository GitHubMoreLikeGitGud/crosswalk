"""Join-map measurements for the evaluation report; writes data/eval/joinmap.json.

    .venv/Scripts/python scripts/eval_joinmap.py
    .venv/Scripts/python scripts/eval_joinmap.py --out data/eval/joinmap.json --timeout 60 --skip-station

One-off, read-only Lightning SQL statements (the reader allowlist, one statement per JDBC
call, every statement bounded at --timeout seconds, default 60) that measure how the
Zetaris objects join, over the 43 seed utilities of seeds/utilities.json and the 56
stations of seeds/stations.json:

  (a) frames `cik` (LPAD(CAST(cik AS STRING), 10, '0')) matched against the seeds'
      submission views, per revenue tag and comparison period, with the no-LPAD control
      (integer against zero-padded string: expected 0) and the integer IN count the
      frames_seeds template uses (expected equal to the LPAD count);
  (b) frames `loc` (US-XX) against each seed's business-address state from its submission
      view: equal / different / missing, per tag and period, with the differing rows listed;
  (c) station -> state: the USL station table against seeds/stations.json (the one statement
      that reads a GHCN-backed object; it costs 44 to 88 s on this instance, so it runs last
      and is recorded as not measured when it exceeds the bound);
  (d) the SIC orphan among the seeds (submissions `sic` LEFT JOIN cw.sic_codes), measured in
      plain SQL; the RUN DQ result of the USL utility FK rule is quoted from the onboarding
      record in zetaris/README.md, not re-run (each DQ run on that table takes minutes).

GHCN views (cw.ghcn_*) are never read here. Every statement is logged to
data/evidence/sql_log.jsonl with its sha256 and timing. The output document holds every
statement's text, elapsed ms, row count and rows, plus the structured results that
agent/src/eval/run.ts folds into docs/eval-report.md.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from gateway import allowlist, cache, templates  # noqa: E402
from gateway.jdbc import LightningConnection, QueryTimeout, ZetarisError, load_env  # noqa: E402
from gateway.sqllog import log_statement, sha256  # noqa: E402

DEFAULT_OUT = ROOT / "data" / "eval" / "joinmap.json"
STATIONS_PATH = ROOT / "seeds" / "stations.json"
DEFAULT_BOUND_S = 60.0
TAGS = ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RegulatedAndUnregulatedOperatingRevenue")
PERIODS = ("CY2025Q1", "CY2024Q1")
MAX_ROWS_KEPT = 60

# The RUN DQ result of the USL utility FK rule (sic -> sic_code.code), recorded at Day-1
# onboarding (zetaris/README.md, "SEC-side verification and DQ"); not re-run here.
RECORDED_SIC_FK = {
    "source": "zetaris/README.md, SEC-side verification and DQ (Day 1 onboarding record)",
    "statement": f"RUN DQ sic TABLE {templates.USL}.utility",
    "result": {"type": "Foreign Key Constraint", "total": 43, "valid": 42, "invalid": 1},
    "elapsed_s": 79.1,
    "invalid_record": {"cik": "0001161728", "name": "MGE ENERGY INC", "ticker": "MGEE", "sic": "4900", "hq_state": "WI"},
    "invalid_record_statement": f"SHOW DQ INVALID RECORD sic TABLE {templates.USL}.utility",
    "invalid_record_elapsed_s": 93.3,
    "note": "SIC 4900 has no row in the company_dns V4 list; MGE Energy is a target-only seed (never a peer).",
}


def union_submissions() -> str:
    parts = [f"SELECT cik, name, sic, state FROM {v}" for v in templates.USL_UTILITY_VIEWS]
    return " UNION ALL ".join(parts)


def frames_view(tag: str, period: str) -> str:
    return templates.FRAMES_VIEW.format(tag=tag, period=period)


def statements_a_b() -> list[dict]:
    u = union_submissions()
    out: list[dict] = []
    for tag in TAGS:
        for period in PERIODS:
            f = frames_view(tag, period)
            out.append({
                "id": f"lpad_loc.{tag}.{period}",
                "group": "cik_lpad_and_loc",
                "tag": tag, "period": period,
                "sql": (
                    "SELECT COUNT(*) AS matched, "
                    "SUM(CASE WHEN f.loc = CONCAT('US-', u.state) THEN 1 ELSE 0 END) AS loc_equal, "
                    "SUM(CASE WHEN f.loc IS NULL OR f.loc = '' THEN 1 ELSE 0 END) AS loc_missing "
                    f"FROM {f} f JOIN ({u}) u ON LPAD(CAST(f.cik AS STRING), 10, '0') = u.cik"
                ),
            })
            out.append({
                "id": f"in_count.{tag}.{period}",
                "group": "cik_in_count",
                "tag": tag, "period": period,
                "sql": f"SELECT COUNT(*) AS seeds_present FROM {f} WHERE CAST(cik AS BIGINT) IN ({templates.SEED_CIK_INTS_SQL})",
            })
    out.append({
        "id": "no_lpad_control.Revenues.CY2025Q1",
        "group": "cik_no_lpad_control",
        "tag": "Revenues", "period": "CY2025Q1",
        "sql": f"SELECT COUNT(*) AS matched FROM {frames_view('Revenues', 'CY2025Q1')} f JOIN ({u}) u ON CAST(f.cik AS STRING) = u.cik",
    })
    for period in PERIODS:
        inner = " UNION ALL ".join(
            f"SELECT cik FROM {frames_view(t, period)} WHERE CAST(cik AS BIGINT) IN ({templates.SEED_CIK_INTS_SQL})" for t in TAGS)
        out.append({
            "id": f"seeds_any_tag.{period}",
            "group": "cik_any_tag",
            "period": period,
            "sql": f"SELECT COUNT(DISTINCT cik) AS seeds_any_tag FROM ({inner}) x",
        })
    return out


def statement_loc_rows(tag: str, period: str) -> dict:
    u = union_submissions()
    f = frames_view(tag, period)
    return {
        "id": f"loc_rows.{tag}.{period}",
        "group": "loc_differing_rows",
        "tag": tag, "period": period,
        "sql": (
            "SELECT u.cik, u.name, f.loc, u.state "
            f"FROM {f} f JOIN ({u}) u ON LPAD(CAST(f.cik AS STRING), 10, '0') = u.cik "
            "WHERE f.loc IS NULL OR f.loc = '' OR f.loc <> CONCAT('US-', u.state) ORDER BY u.cik"
        ),
    }


def statement_sic_orphans() -> dict:
    u = union_submissions()
    return {
        "id": "sic_orphans",
        "group": "sic_fk_plain_sql",
        "sql": f"SELECT u.cik, u.name, u.sic FROM ({u}) u LEFT JOIN {templates.SIC_VIEW} r ON r.code = u.sic WHERE r.code IS NULL ORDER BY u.cik",
    }


def statement_station() -> dict:
    return {
        "id": "usl_station_rows",
        "group": "station_state",
        "sql": f"SELECT id, state, name FROM {templates.USL}.station ORDER BY id",
    }


def run_one(conn: LightningConnection, st: dict, bound_s: float) -> dict:
    sql = st["sql"]
    allowlist.check(sql, "reader")
    rec = {**{k: v for k, v in st.items() if k != "sql"}, "sql": sql, "sql_sha256": sha256(sql), "bound_s": bound_s,
           "started_at": cache.now_iso(), "elapsed_ms": None, "row_count": None, "columns": [], "rows": [],
           "error": None, "timeout": False, "measured": False}
    entry = {"source_file": "scripts.eval_joinmap", "role": "reader", "sql": sql, "sql_sha256": rec["sql_sha256"], "timeout_s": bound_s}
    started = time.time()
    try:
        res = conn.execute(sql, timeout_s=bound_s)
    except (QueryTimeout, ZetarisError) as e:
        elapsed = int((time.time() - started) * 1000)
        rec.update(elapsed_ms=elapsed, error=str(e), timeout=isinstance(e, QueryTimeout))
        log_statement({**entry, "error": str(e), "timeout": isinstance(e, QueryTimeout), "elapsed_ms": elapsed})
        return rec
    rec.update(elapsed_ms=res.elapsed_ms, row_count=res.row_count, columns=res.columns,
               rows=res.rows[:MAX_ROWS_KEPT], measured=True)
    log_statement({**entry, "elapsed_ms": res.elapsed_ms, "row_count": res.row_count, "executed_at": res.executed_at,
                   "columns": res.columns, "result_head": res.rows[:5], "error": None})
    return rec


def first_row(rec: dict) -> list:
    return rec["rows"][0] if rec.get("rows") else []


def summarise(records: list[dict], seed_stations: list[dict]) -> dict:
    by_id = {r["id"]: r for r in records}
    seeds = len(templates.SEED_CIKS)
    cik: dict[str, dict] = {}
    loc: dict[str, dict] = {}
    for tag in TAGS:
        for period in PERIODS:
            a = by_id.get(f"lpad_loc.{tag}.{period}")
            b = by_id.get(f"in_count.{tag}.{period}")
            key = f"{tag}.{period}"
            if a and a["measured"]:
                matched, equal, missing = (int(v) for v in first_row(a)[:3])
                cik[key] = {"tag": tag, "period": period, "seeds": seeds, "lpad_matched": matched,
                            "in_count": int(first_row(b)[0]) if b and b["measured"] else None,
                            "agree": (b is not None and b["measured"] and int(first_row(b)[0]) == matched) or None,
                            "elapsed_ms": a["elapsed_ms"]}
                loc[key] = {"tag": tag, "period": period, "present": matched, "equal": equal,
                            "different": matched - equal - missing, "missing": missing, "elapsed_ms": a["elapsed_ms"]}
            else:
                cik[key] = {"tag": tag, "period": period, "seeds": seeds, "measured": False,
                            "error": (a or {}).get("error"), "elapsed_ms": (a or {}).get("elapsed_ms")}
                loc[key] = {"tag": tag, "period": period, "measured": False}
    control = by_id.get("no_lpad_control.Revenues.CY2025Q1")
    any_tag = {}
    for period in PERIODS:
        r = by_id.get(f"seeds_any_tag.{period}")
        any_tag[period] = {"seeds_with_a_fact": int(first_row(r)[0]) if r and r["measured"] else None,
                           "seeds": seeds, "elapsed_ms": (r or {}).get("elapsed_ms"), "measured": bool(r and r["measured"])}
    loc_rows = []
    for r in records:
        if r["group"] == "loc_differing_rows" and r["measured"]:
            for row in r["rows"]:
                loc_rows.append({"tag": r["tag"], "period": r["period"], "cik": row[0], "name": row[1], "loc": row[2], "state": row[3]})
    sic = by_id.get("sic_orphans")
    sic_summary = {
        "measured": bool(sic and sic["measured"]),
        "seeds": seeds,
        "orphans": [{"cik": row[0], "name": row[1], "sic": row[2]} for row in (sic["rows"] if sic and sic["measured"] else [])],
        "joined": (seeds - sic["row_count"]) if sic and sic["measured"] else None,
        "elapsed_ms": (sic or {}).get("elapsed_ms"),
        "recorded_run_dq": RECORDED_SIC_FK,
    }
    st = by_id.get("usl_station_rows")
    station: dict = {"seed_stations": len(seed_stations), "measured": bool(st and st["measured"]),
                     "elapsed_ms": (st or {}).get("elapsed_ms"), "bound_s": (st or {}).get("bound_s"),
                     "timeout": (st or {}).get("timeout", False), "error": (st or {}).get("error"), "skipped": st is None}
    if st and st["measured"]:
        usl = {row[0]: {"state": row[1], "name": row[2]} for row in st["rows"]}
        present = [s for s in seed_stations if s["id"] in usl]
        equal = [s for s in present if usl[s["id"]]["state"] == s["state"]]
        different = [{"id": s["id"], "seed_state": s["state"], "usl_state": usl[s["id"]]["state"]} for s in present if usl[s["id"]]["state"] != s["state"]]
        missing = [s["id"] for s in seed_stations if s["id"] not in usl]
        extra = sorted(set(usl) - {s["id"] for s in seed_stations})
        station.update(usl_rows=st["row_count"], present=len(present), state_equal=len(equal), state_different=different,
                       missing=missing, extra_in_usl=extra)
    return {
        "seeds": seeds,
        "cik_lpad": cik,
        "cik_no_lpad_control": {"matched": int(first_row(control)[0]) if control and control["measured"] else None,
                                "elapsed_ms": (control or {}).get("elapsed_ms"), "measured": bool(control and control["measured"])},
        "cik_any_tag": any_tag,
        "loc": loc,
        "loc_differing_rows": loc_rows,
        "sic": sic_summary,
        "station": station,
    }


def write_atomic(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False, default=str) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def connect(role: str) -> tuple[LightningConnection, str]:
    """The reader login when the instance has one; otherwise the admin login under the reader allowlist."""
    if role == "reader":
        try:
            conn = LightningConnection.from_env("reader")
            conn.connect()
            return conn, "reader"
        except (ZetarisError, KeyError, RuntimeError) as e:
            print(f"reader login unavailable ({str(e)[:120]}); admin login under the reader allowlist", flush=True)
    conn = LightningConnection.from_env("admin")
    return conn, "admin"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", default=str(DEFAULT_OUT))
    p.add_argument("--timeout", type=float, default=DEFAULT_BOUND_S, help=f"bound per statement, seconds (default {DEFAULT_BOUND_S:g})")
    p.add_argument("--role", default="reader", choices=("reader", "admin"), help="login to try first (the allowlist is always the reader's)")
    p.add_argument("--skip-station", action="store_true", help="do not read the USL station table (the one GHCN-backed statement)")
    p.add_argument("--dry-run", action="store_true", help="print the statements and exit")
    args = p.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    load_env()
    seed_stations = json.loads(STATIONS_PATH.read_text(encoding="utf-8"))["stations"]

    plan = statements_a_b()
    if args.dry_run:
        for st in plan + [statement_sic_orphans(), statement_station()]:
            allowlist.check(st["sql"], "reader")
            print(f"-- {st['id']}\n{st['sql'][:400]}{'...' if len(st['sql']) > 400 else ''}\n")
        return 0

    doc: dict = {"measured_at": cache.now_iso(), "bound_s": args.timeout, "login": None, "statements": [], "results": None, "elapsed_s": None}
    started = time.time()
    conn, login = connect(args.role)
    doc["login"] = login
    records: list[dict] = []
    try:
        for st in plan:
            r = run_one(conn, st, args.timeout)
            records.append(r)
            print(f"{r['id']}: {'%d ms' % r['elapsed_ms'] if r['elapsed_ms'] is not None else '-'} rows={r['row_count']} {first_row(r) if r['measured'] else r['error'][:160]}", flush=True)
        # (b) the differing rows, only where a count says there are any
        for tag in TAGS:
            for period in PERIODS:
                a = next((r for r in records if r["id"] == f"lpad_loc.{tag}.{period}"), None)
                if a and a["measured"]:
                    matched, equal, missing = (int(v) for v in first_row(a)[:3])
                    if matched - equal > 0:
                        r = run_one(conn, statement_loc_rows(tag, period), args.timeout)
                        records.append(r)
                        print(f"{r['id']}: {r['elapsed_ms']} ms rows={r['row_count']}", flush=True)
        r = run_one(conn, statement_sic_orphans(), args.timeout)
        records.append(r)
        print(f"{r['id']}: {r['elapsed_ms']} ms rows={r['row_count']} {r['rows'] if r['measured'] else r['error'][:160]}", flush=True)
        if not args.skip_station:
            print(f"usl_station_rows (GHCN-backed, 44 to 88 s on this instance, bound {args.timeout:g} s) ...", flush=True)
            r = run_one(conn, statement_station(), args.timeout)
            records.append(r)
            print(f"{r['id']}: {r['elapsed_ms']} ms rows={r['row_count']} {'' if r['measured'] else 'NOT MEASURED: ' + r['error'][:160]}", flush=True)
    finally:
        conn.close()
    doc["statements"] = records
    doc["results"] = summarise(records, seed_stations)
    doc["elapsed_s"] = round(time.time() - started, 1)
    out = Path(args.out)
    write_atomic(out, doc)
    not_measured = [r["id"] for r in records if not r["measured"]]
    print(f"wrote {out} ({doc['elapsed_s']} s, {len(records)} statements, not measured: {not_measured or 'none'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
