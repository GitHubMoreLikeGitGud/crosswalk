"""Re-cache every Weather-or-Not view before a demo and print the timings.

    .venv/Scripts/python scripts/warmup.py            # CACHE the views the driver does not hold
    .venv/Scripts/python scripts/warmup.py --force    # CACHE every view again (no UNCACHE first)
    .venv/Scripts/python scripts/warmup.py --refresh  # UNCACHE then CACHE every view (re-reads S3)
    .venv/Scripts/python scripts/warmup.py --targets won.ghcn_2025_tmax,won.ghcn_2025_tmin
    .venv/Scripts/python scripts/warmup.py --skip-dq  # caches only; no onboarding DQ pass at the end

The Zetaris cache is driver-wide and is lost when the driver restarts, so the
gateway warms up at start and on a driver app-id change (gateway/app.py); this
script does the same from the command line, in the gateway's order (the demo year
first), and reports per view: state before, the statement run, its time, the
in-memory size the Spark UI shows afterwards, and a COUNT(*) read time. Targets
come from gateway.app.CACHE_TARGETS (WON_CACHE_TARGETS overrides) and every
statement passes the registrar allowlist, so only won.* / WON_*.* objects can be
cached or uncached here. Each statement is logged to data/evidence/sql_log.jsonl.

At the end it runs the onboarding DQ pass (scripts/dq_onboard.py: RUN DQ
coverage_ok and SHOW DQ INVALID RECORD coverage_ok on the USL weather_quarter
table, 9 to 12 minutes on this instance) and writes data/dq/latest.json, which the
agent's DQ gate reads; --skip-dq leaves that out.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import dq_onboard  # noqa: E402
from gateway import allowlist, cache  # noqa: E402
from gateway.app import CACHE_TIMEOUT_S, cache_targets  # noqa: E402
from gateway.jdbc import LightningConnection, QueryTimeout, ZetarisError, load_env  # noqa: E402
from gateway.sqllog import log_statement, sha256  # noqa: E402

COUNT_TIMEOUT_S = 120.0


def in_memory_bytes() -> dict[str, int]:
    """Bytes per cached table (lower-cased name) from the Spark UI storage API, {} if unreachable."""
    try:
        with urlopen(f"{cache.SPARK_UI}/api/v1/applications", timeout=2) as r:
            app = json.loads(r.read().decode())[0]
        with urlopen(f"{cache.SPARK_UI}/api/v1/applications/{app['id']}/storage/rdd", timeout=2) as r:
            rdds = json.loads(r.read().decode())
    except Exception:
        return {}
    out = {}
    for rdd in rdds:
        name = str(rdd.get("name", ""))
        if name.startswith("In-memory table "):
            out[name[len("In-memory table "):].strip().lower()] = int(rdd.get("memoryUsed", 0))
    return out


def run(conn: LightningConnection, sql: str, timeout_s: float) -> tuple[int | None, str | None, list]:
    """(elapsed_ms, error, rows) for one allowlisted statement, logged either way."""
    allowlist.check(sql, "registrar")
    entry = {"source_file": "scripts.warmup", "role": "registrar", "sql": sql, "sql_sha256": sha256(sql), "timeout_s": timeout_s}
    try:
        res = conn.execute(sql, timeout_s=timeout_s)
    except (QueryTimeout, ZetarisError) as e:
        entry.update(error=str(e), timeout=isinstance(e, QueryTimeout))
        log_statement(entry)
        return None, str(e), []
    entry.update(elapsed_ms=res.elapsed_ms, row_count=res.row_count, executed_at=res.executed_at, error=None)
    log_statement(entry)
    return res.elapsed_ms, None, res.rows


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--force", action="store_true", help="CACHE every target, cached or not")
    p.add_argument("--refresh", action="store_true", help="UNCACHE TABLE IF EXISTS, then CACHE, every target")
    p.add_argument("--targets", help="comma-separated qualified names instead of the gateway's cache targets")
    p.add_argument("--no-count", action="store_true", help="skip the COUNT(*) read after caching")
    p.add_argument("--skip-dq", action="store_true", help="do not run the onboarding DQ pass (scripts/dq_onboard.py) at the end")
    args = p.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    load_env()

    targets = [t.strip() for t in args.targets.split(",") if t.strip()] if args.targets else cache_targets()
    for t in targets:
        allowlist.check(f"CACHE TABLE {t}", "registrar")
    storage = cache.spark_storage()
    cached_before = storage["cached"] if storage else set()
    print(f"driver app: {storage['app_id'] if storage else 'spark ui unreachable'}; targets: {len(targets)}")

    conn = LightningConnection.from_env("admin")
    rows_out = []
    failures = 0
    total_started = time.time()
    for t in targets:
        before = "hit" if t.lower() in cached_before else ("miss" if storage else "unknown")
        actions, errors = [], []
        if args.refresh:
            ms, err, _ = run(conn, f"UNCACHE TABLE IF EXISTS {t}", 60.0)
            actions.append(f"uncache {ms} ms" if err is None else "uncache failed")
            if err:
                errors.append(err[:160])
        if args.refresh or args.force or before != "hit":
            ms, err, _ = run(conn, f"CACHE TABLE {t}", CACHE_TIMEOUT_S)
            actions.append(f"cache {ms} ms" if err is None else "cache FAILED")
            if err:
                errors.append(err[:160])
                failures += 1
        else:
            actions.append("already cached")
        count = ""
        if not args.no_count:
            ms, err, rows = run(conn, f"SELECT COUNT(*) AS n FROM {t}", COUNT_TIMEOUT_S)
            count = f"{rows[0][0]} rows in {ms} ms" if err is None and rows else f"count failed: {err[:100]}"
        rows_out.append((t, before, "; ".join(actions), count, errors))
        print(f"{t:28} before={before:7} {'; '.join(actions):28} {count}", flush=True)
        for e in errors:
            print(f"    error: {e}")
    conn.close()

    mem = in_memory_bytes()
    print(f"\nin-memory sizes after warm-up (Spark UI {cache.SPARK_UI}):")
    for t in targets:
        size = mem.get(t.lower())
        print(f"  {t:28} {size if size is not None else 'not in storage':>14} bytes" if size is not None else f"  {t:28} not in storage")
    print(f"total {time.time() - total_started:.1f} s, failures {failures}")
    if args.skip_dq:
        return 1 if failures else 0
    print("\nonboarding DQ pass (scripts/dq_onboard.py; 9 to 12 minutes on this instance; --skip-dq to leave it out)", flush=True)
    dq_failed = dq_onboard.main([])
    return 1 if failures or dq_failed else 0


if __name__ == "__main__":
    sys.exit(main())
