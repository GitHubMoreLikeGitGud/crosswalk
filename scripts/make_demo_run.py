"""The committed demo run: one saved cold run of the demo question, redacted, for a fresh clone's UI.

A fresh clone has no data/ (runs hold SEC values, which are queried live and never redistributed), so the
analyst UI would open on "No saved run yet". This script takes one saved cold run and redacts it exactly as
the server test fixtures are redacted (agent/test/fixtures/make_server_fixtures.py: revenue values,
accession numbers, degree days and sample rows replaced by synthetic numbers that keep each change's sign and
the answer arithmetic; structure, SQL text, counts, timings and seed identifiers kept), then writes it with an
index entry marked source "demo" to docs/demo-run/. The server lists it, as a REPLAY labelled "redacted demo
run", only while data/runs/ holds no run of its own; the USL screen falls back to docs/demo-run/dq/latest.json
(the onboarding DQ counts) only while data/dq/latest.json is absent.

Run from the repository root on a machine that has the saved runs:

    python -X utf8 scripts/make_demo_run.py [--run r20261025T1546471209]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "demo-run"
spec = importlib.util.spec_from_file_location("msf", ROOT / "agent" / "test" / "fixtures" / "make_server_fixtures.py")
msf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(msf)

NOTE_TEXT = "Redacted demo run: the model's note is replaced by this sentence, and revenue, accession and degree-day values are synthetic. The join map, its counts and its SQL are the saved run's."


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="r20261025T1546471209")
    ap.add_argument("--data", default=str(ROOT / "data"))
    args = ap.parse_args()
    src = json.loads((Path(args.data) / "runs" / args.run / "run.json").read_text(encoding="utf-8"))
    run = msf.build(src)
    if run.get("memo"):
        run["memo"]["text"] = NOTE_TEXT
        run["memo"]["words"] = len(NOTE_TEXT.split())
    run["saved"] = {"source": "demo", "note": "redacted demo run committed for a fresh clone", "at": (src.get("saved") or {}).get("at", src.get("finished_at"))}
    (OUT / "runs" / args.run).mkdir(parents=True, exist_ok=True)
    (OUT / "dq").mkdir(parents=True, exist_ok=True)
    text = msf.dump(run, OUT / "runs" / args.run / "run.json")
    failures = [f"source value {v} survived" for v in sorted(msf.real_values(src)) if v in text]
    for pat in (r"[A-Za-z]:\\\\", re.escape(ROOT.parent.name) if ROOT.parent.name else None, r"[\w.+-]+@[\w-]+\.[a-z]{2,}"):
        if pat and re.search(pat, text):
            failures.append(f"forbidden text matching {pat!r}")
    entry = {
        "run_id": run["run_id"],
        "quarter": run["quarter"],
        "mode": run["mode"],
        "question": run["question"],
        "utilities": len((run.get("answer") or {}).get("rows") or []),
        "keys": len(run.get("join_map") or []),
        "skipped": (run.get("telemetry") or {}).get("skipped_chunks", 0),
        "started_at": run["started_at"],
        "wall_ms": run["wall_ms"],
        "chunks": (run.get("markovian") or {}).get("chunks", 0),
        "memo_source": (run.get("memo") or {}).get("source"),
        "source": "demo",
    }
    msf.dump({"runs": [entry], "latest": {f"{run['quarter']}|{run['mode']}": run["run_id"]}}, OUT / "runs" / "index.json")
    msf.dump(json.loads((Path(args.data) / "dq" / "latest.json").read_text(encoding="utf-8")), OUT / "dq" / "latest.json")
    print(f"docs/demo-run/runs/{args.run}/run.json: {len(text):,} bytes; {entry['utilities']} answer rows, {entry['keys']} join-map rows")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
