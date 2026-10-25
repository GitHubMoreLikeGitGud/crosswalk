"""Cache state of the raw tables and views, read from the Zetaris driver's Spark UI.

Adapted from Weather-or-Not and ClearShelf (same author, Apache-2.0).

Measured on 2026-10-23 (Zetaris 2.4.3.1): CACHE TABLE is held by the driver,
not the JDBC session. A table cached on one connection answers from cache on
a new connection and after the first connection closes. `SHOW CACHE TABLES`
returned no rows. The Spark UI storage API (127.0.0.1:4040, read-only) lists
each cached table as an "In-memory table <db>.<table>" RDD, so it is used as
the source of truth. A driver restart drops every cache; the app id changes.
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from urllib.request import urlopen

from .sqllog import LOG_PATH

SPARK_UI = os.environ.get("ZETARIS_SPARK_UI", "http://127.0.0.1:4040")
_CACHE_STMT = re.compile(r"^\s*CACHE\s+TABLE\s+((?:cw|CW_[A-Z]+)\.[A-Za-z0-9_]+)\s*$", re.I)


def spark_storage(timeout: float = 2.0) -> dict | None:
    """{"app_id", "started_at_ms", "cached": set[str]} or None if the UI is unreachable."""
    try:
        with urlopen(f"{SPARK_UI}/api/v1/applications", timeout=timeout) as r:
            apps = json.loads(r.read().decode())
        app = apps[0]
        with urlopen(f"{SPARK_UI}/api/v1/applications/{app['id']}/storage/rdd", timeout=timeout) as r:
            rdds = json.loads(r.read().decode())
    except Exception:
        return None
    cached = set()
    for rdd in rdds:
        name = str(rdd.get("name", ""))
        if name.startswith("In-memory table ") and rdd.get("numCachedPartitions", 0) > 0:
            cached.add(name[len("In-memory table "):].strip().lower())
    started = app.get("attempts", [{}])[0].get("startTimeEpoch")
    return {"app_id": app["id"], "started_at_ms": started, "cached": cached}


def _parse_ts(text: str) -> datetime | None:
    for fmt in ("%Y-%m-%dT%H:%M:%S%z",):
        try:
            return datetime.strptime(text, fmt)
        except (TypeError, ValueError):
            pass
    return None


def last_cache_events(since_ms: int | None = None, path=None) -> dict[str, str]:
    """Latest successful CACHE TABLE time per object (lower-cased) from the SQL log,
    ignoring events before the driver started (they were lost with the old driver)."""
    path = path or LOG_PATH
    out: dict[str, str] = {}
    if not os.path.exists(path):
        return out
    floor = datetime.fromtimestamp(since_ms / 1000, tz=timezone.utc) if since_ms else None
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            m = _CACHE_STMT.match(rec.get("sql", "") or "")
            if not m or rec.get("error"):
                continue
            ts_text = rec.get("executed_at") or rec.get("logged_at")
            ts = _parse_ts(ts_text)
            if floor and ts and ts < floor:
                continue
            out[m.group(1).lower()] = ts_text
    return out


def resolve(raw_objects: tuple[str, ...], params: dict) -> list[str]:
    """Raw object names with "{name}" placeholders replaced by the (validated) parameters."""
    out = []
    for o in raw_objects:
        for k, v in (params or {}).items():
            o = o.replace("{" + k + "}", str(v))
        out.append(o)
    return out


def cache_state(raw_objects: tuple[str, ...], params: dict, storage: dict | None) -> tuple[str, dict, dict]:
    """(state, per-object detail, source_cached_at). state is hit when every raw object is
    held by the driver, miss otherwise, unknown with no raw objects or no Spark UI."""
    objs = resolve(raw_objects, params)
    if not objs:
        return "unknown", {}, {}
    if storage is None:
        return "unknown", {o: "spark_ui_unreachable" for o in objs}, {}
    detail = {o: ("hit" if o.lower() in storage["cached"] else "miss") for o in objs}
    state = "hit" if all(s == "hit" for s in detail.values()) else "miss"
    events = last_cache_events(storage.get("started_at_ms"))
    cached_at = {o: events[o.lower()] for o in objs if o.lower() in events}
    return state, detail, cached_at


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")
