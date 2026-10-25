"""Onboarding data-quality pass for the Crosswalk USL; writes data/dq/latest.json.

    .venv/Scripts/python scripts/dq_onboard.py                 # RUN DQ coverage_ok, then SHOW DQ INVALID RECORD coverage_ok
    .venv/Scripts/python scripts/dq_onboard.py --skip-run      # the invalid records only (about half the time)
    .venv/Scripts/python scripts/dq_onboard.py --out data/dq/latest.json --timeout 600

Runs the two gateway DQ templates (gateway/templates.py) over JDBC under the reader allowlist,
in order: dq_run_coverage (RUN DQ coverage_ok on the USL weather_quarter table: total, valid and
invalid counts) and dq_invalid (SHOW DQ INVALID RECORD coverage_ok: every station-quarter whose
coverage is below 0.9), and writes one JSON document:

    {"ran_at", "rule", "table", "elapsed_s", "ok", "run": {"total", "valid", "invalid", ...},
     "invalid_rows": [{"station_id", "year", "quarter", ...}], "statements": [...]}

The agent's dq_gate(cik) reads this file (the rule's last run time and the invalid station-
quarters) together with the coverage column of its own weather_quarter result, and the answer card
states ran_at. The per-question gate never runs DQ itself: a read of the USL weather_quarter table
materialises the four GHCN filestore views again, so each statement here takes minutes (live:
RUN DQ 361 s on Day 0 and 557 s on Day 1, SHOW DQ INVALID RECORD 181 s both days; the whole pass
9 to 12 minutes, --skip-run about 3). Run it at onboarding and after a registration that changes weather_quarter;
scripts/warmup.py runs it at the end unless --skip-dq is given. Never start it while another DQ
statement may still be running on the instance. Each statement is logged to
data/evidence/sql_log.jsonl. A statement that fails or times out is recorded in the file with its
error text, and the exit status is 1; DQ findings (invalid rows) are data, not a failure.
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

DEFAULT_OUT = ROOT / "data" / "dq" / "latest.json"
RULE = "coverage_ok"
TABLE = f"{templates.USL}.weather_quarter"
RUN_TEMPLATE = "dq_run_coverage"
INVALID_TEMPLATE = "dq_invalid"


def _count(columns: list[str], row: list, name: str, position: int):
    """A RUN DQ count by column name (total / valid / invalid), falling back to its position."""
    for i, c in enumerate(columns):
        if name in str(c).lower():
            return row[i]
    return row[position] if len(row) > position else None


def run_statement(conn: LightningConnection, template_id: str, timeout_s: float | None) -> dict:
    t, sql = templates.render(template_id, {})
    allowlist.check(sql, "reader")
    bound = timeout_s if timeout_s is not None else (t.timeout_s or templates.DQ_TIMEOUT_S)
    entry = {"source_file": "scripts.dq_onboard", "role": "reader", "template_id": template_id, "sql": sql,
             "sql_sha256": sha256(sql), "timeout_s": bound}
    out = {"template_id": template_id, "sql": sql, "sql_sha256": entry["sql_sha256"], "timeout_s": bound,
           "started_at": cache.now_iso(), "elapsed_s": None, "columns": [], "rows": [], "error": None}
    started = time.time()
    try:
        res = conn.execute(sql, timeout_s=bound)
    except (QueryTimeout, ZetarisError) as e:
        out.update(elapsed_s=round(time.time() - started, 1), error=str(e))
        log_statement({**entry, "error": str(e), "timeout": isinstance(e, QueryTimeout)})
        return out
    out.update(elapsed_s=round(res.elapsed_ms / 1000, 1), columns=res.columns, rows=res.rows)
    log_statement({**entry, "elapsed_ms": res.elapsed_ms, "row_count": res.row_count, "executed_at": res.executed_at,
                   "columns": res.columns, "result_head": res.rows[:5], "error": None})
    return out


def write_atomic(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False, default=str) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", default=str(DEFAULT_OUT), help="where to write the result (default data/dq/latest.json)")
    p.add_argument("--timeout", type=float, default=None, help=f"bounded wait per statement, seconds (default the templates' {templates.DQ_TIMEOUT_S:g})")
    p.add_argument("--skip-run", action="store_true", help="skip RUN DQ; only SHOW DQ INVALID RECORD")
    args = p.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    load_env()

    doc: dict = {"ran_at": cache.now_iso(), "rule": RULE, "table": TABLE, "elapsed_s": None, "ok": False,
                 "run": None, "invalid_rows": [], "invalid_columns": [], "statements": []}
    started = time.time()
    conn = LightningConnection.from_env("admin")
    failures = 0
    try:
        if not args.skip_run:
            print(f"RUN DQ {RULE} on {TABLE} (minutes) ...", flush=True)
            r = run_statement(conn, RUN_TEMPLATE, args.timeout)
            doc["statements"].append(r)
            if r["error"]:
                failures += 1
                print(f"  FAILED after {r['elapsed_s']} s: {r['error'][:300]}")
            else:
                row = r["rows"][0] if r["rows"] else []
                doc["run"] = {"total": _count(r["columns"], row, "total", 3), "valid": _count(r["columns"], row, "valid", 4),
                              "invalid": _count(r["columns"], row, "invalid", 5), "elapsed_s": r["elapsed_s"],
                              "columns": r["columns"], "row": row}
                print(f"  {r['elapsed_s']} s: total {doc['run']['total']}, valid {doc['run']['valid']}, invalid {doc['run']['invalid']}")
        print(f"SHOW DQ INVALID RECORD {RULE} (minutes) ...", flush=True)
        r = run_statement(conn, INVALID_TEMPLATE, args.timeout)
        doc["statements"].append(r)
        if r["error"]:
            failures += 1
            print(f"  FAILED after {r['elapsed_s']} s: {r['error'][:300]}")
        else:
            doc["invalid_columns"] = r["columns"]
            doc["invalid_rows"] = [dict(zip(r["columns"], row)) if r["columns"] else row for row in r["rows"]]
            print(f"  {r['elapsed_s']} s: {len(r['rows'])} invalid row(s)")
    finally:
        conn.close()
    doc["elapsed_s"] = round(time.time() - started, 1)
    doc["ok"] = failures == 0
    # The reply rows carry the statement text; the file keeps them (small) for the evidence drawer.
    for s in doc["statements"]:
        s["row_count"] = len(s["rows"])
        s["rows"] = s["rows"][:200]
    out = Path(args.out)
    write_atomic(out, doc)
    print(f"wrote {out} ({doc['elapsed_s']} s, ok={doc['ok']}, invalid_rows={len(doc['invalid_rows'])})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
