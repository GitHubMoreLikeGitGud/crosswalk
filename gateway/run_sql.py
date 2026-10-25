"""Run zetaris/sql/*.sql files (or one statement) over JDBC, one statement per call.

Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

    python -m gateway.run_sql zetaris/sql/00_won_base_create.sql --dry-run
    python -m gateway.run_sql zetaris/sql/01_sec_frames_select.sql
    python -m gateway.run_sql --sql "SELECT 1"

Every statement passes the `onboard` allowlist and is logged to
data/evidence/sql_log.jsonl with the timeout used. Results print as JSON lines.

Defaults that keep the sources safe without flags:
- a statement that may call SEC EDGAR (names data.sec.gov or a CW_SEC.* table
  and is a CREATE, DESCRIBE, CACHE or SELECT) waits until at least
  SEC_MIN_SPACING_S after the previous one, the SEC's 10 requests per second
  (--spacing can only raise this); the User-Agent placeholder in a script is
  replaced from CW_USER_AGENT and is never hard-coded;
- RUN DQ and SHOW DQ are bounded at DQ_TIMEOUT_S, everything else at
  DEFAULT_TIMEOUT_S (--timeout overrides both).
COUNT queries and RUN DQ also log their first result rows (result_head).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

from . import allowlist
from .jdbc import LightningConnection, QueryTimeout, ZetarisError, apply_user_agent, load_env, split_statements
from .sqllog import log_statement, sha256

ALREADY_EXISTS = re.compile(r"already exist", re.I)
CALLS_SOURCE = re.compile(r"^\s*(CREATE\s+LIGHTNING\s+(REST|FILESTORE)\s+TABLE|CACHE\s+TABLE|DESCRIBE)\b", re.I)
TOUCHES_SEC = re.compile(r"data\.sec\.gov|\bCW_SEC\.", re.I)
NO_SOURCE_CALL = re.compile(r"^\s*(UNCACHE\s+TABLE|UNCACHE\s+LIGHTNING|SHOW)\b", re.I)
DQ_STATEMENT = re.compile(r"^\s*(RUN|SHOW)\s+DQ\b", re.I)
HEAD_LOGGED = re.compile(r"^\s*RUN\s+DQ\b|^\s*SELECT\b.*\bCOUNT\s*\(", re.I | re.S)
SEC_MIN_SPACING_S = 0.1
DQ_TIMEOUT_S = 120.0
DEFAULT_TIMEOUT_S = 600.0
HEAD_ROWS = 5


def touches_sec(sql: str) -> bool:
    """True if the statement may call SEC EDGAR (CREATE, DESCRIBE, CACHE, or a read
    of a CW_SEC table that is not cached)."""
    return bool(TOUCHES_SEC.search(sql)) and not NO_SOURCE_CALL.match(sql)


def timeout_for(sql: str, override: float | None) -> float:
    if override is not None:
        return override
    return DQ_TIMEOUT_S if DQ_STATEMENT.match(sql) else DEFAULT_TIMEOUT_S


def result_head(rows: list) -> list:
    return [[v if not isinstance(v, str) or len(v) <= 200 else v[:200] + "..." for v in r] for r in rows[:HEAD_ROWS]]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("files", nargs="*")
    p.add_argument("--sql", help="run one statement instead of files")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--skip-exists", action="store_true", help="treat 'already exists' as done")
    p.add_argument("--timeout", type=float, default=None,
                   help=f"bounded wait per statement, seconds (default {DQ_TIMEOUT_S:g} for RUN/SHOW DQ, else {DEFAULT_TIMEOUT_S:g})")
    p.add_argument("--spacing", type=float, default=0.0,
                   help=f"seconds to wait before each statement that may call a source API (SEC: at least {SEC_MIN_SPACING_S:g})")
    p.add_argument("--show", type=int, default=20, help="rows to print per statement")
    p.add_argument("--keep-going", action="store_true")
    args = p.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    load_env()
    statements: list[tuple[str, str]] = []
    if args.sql:
        statements.append(("--sql", args.sql.strip()))
    for f in args.files:
        for s in split_statements(Path(f).read_text(encoding="utf-8")):
            statements.append((Path(f).name, s))
    if not statements:
        p.error("nothing to run")

    for _, s in statements:
        allowlist.check(apply_user_agent(s) if not args.dry_run else s, "onboard")
    if args.dry_run:
        for i, (src, s) in enumerate(statements, 1):
            spaced = f", SEC-spaced >= {max(args.spacing, SEC_MIN_SPACING_S):g} s" if touches_sec(s) else ""
            print(f"-- [{i}] {src} (timeout {timeout_for(s, args.timeout):g} s{spaced})\n{s}\n")
        return 0

    conn = LightningConnection.from_env("admin")
    failures = 0
    last_source_call = 0.0
    last_sec_call = 0.0
    for i, (src, s) in enumerate(statements, 1):
        sql = apply_user_agent(s)
        calls_source, sec = bool(CALLS_SOURCE.match(sql)), touches_sec(sql)
        wait = 0.0
        if calls_source and args.spacing:
            wait = args.spacing - (time.time() - last_source_call)
        if sec:
            wait = max(wait, max(args.spacing, SEC_MIN_SPACING_S) - (time.time() - last_sec_call))
        if wait > 0:
            time.sleep(wait)
        timeout = timeout_for(sql, args.timeout)
        entry = {"source_file": src, "role": "onboard", "sql": s, "sql_sha256": sha256(s), "timeout_s": timeout}
        if wait > 0:
            entry["spaced_s"] = round(wait, 2)
        try:
            res = conn.execute(sql, timeout_s=timeout)
            entry.update(elapsed_ms=res.elapsed_ms, row_count=res.row_count, executed_at=res.executed_at, error=None)
            if HEAD_LOGGED.match(sql):
                entry.update(columns=res.columns, result_head=result_head(res.rows))
            out = {"i": i, "file": src, "ok": True, "elapsed_ms": res.elapsed_ms, "row_count": res.row_count,
                   "columns": res.columns, "rows": res.rows[: args.show], "sql": " ".join(s.split())[:160]}
        except (QueryTimeout, ZetarisError) as e:
            skipped = args.skip_exists and ALREADY_EXISTS.search(str(e))
            entry.update(error=str(e), timeout=isinstance(e, QueryTimeout), skipped_exists=bool(skipped))
            out = {"i": i, "file": src, "ok": bool(skipped), "skipped_exists": bool(skipped), "error": str(e),
                   "timeout": isinstance(e, QueryTimeout), "sql": " ".join(s.split())[:160]}
            if not skipped:
                failures += 1
        finally:
            now = time.time()
            if calls_source:
                last_source_call = now
            if sec:
                last_sec_call = now
        log_statement(entry)
        print(json.dumps(out, ensure_ascii=False, default=str), flush=True)
        if failures and not args.keep_going:
            break
    conn.close()
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
