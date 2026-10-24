import json
from datetime import datetime, timezone

from gateway import cache

STORAGE = {"app_id": "local-1", "started_at_ms": 0,
           "cached": {"won.frames_revenues_cy2025q1", "won_ghcn.ghcn_2025_tmax"}}


def test_hit_miss_unknown():
    assert cache.cache_state(("won.frames_revenues_cy2025q1",), {}, STORAGE)[0] == "hit"
    assert cache.cache_state(("WON_GHCN.ghcn_2025_tmax",), {}, STORAGE)[0] == "hit"  # the Spark UI names are compared lower-cased
    assert cache.cache_state(("won.frames_revenues_cy2024q1",), {}, STORAGE)[0] == "miss"
    state, detail, _ = cache.cache_state(("won.frames_revenues_cy2025q1", "won.frames_revenues_cy2024q1"), {}, STORAGE)
    assert state == "miss" and detail == {"won.frames_revenues_cy2025q1": "hit", "won.frames_revenues_cy2024q1": "miss"}
    assert cache.cache_state((), {}, STORAGE)[0] == "unknown"
    state, detail, _ = cache.cache_state(("won.frames_revenues_cy2025q1",), {}, None)
    assert state == "unknown" and detail == {"won.frames_revenues_cy2025q1": "spark_ui_unreachable"}


def test_resolve_substitutes_validated_parameters():
    objs = cache.resolve(("won.frames_{tag}_{period}", "WON_GHCN.ghcn_{year}_{element}"),
                         {"tag": "Revenues", "period": "CY2025Q1", "year": "2025", "element": "TMAX"})
    assert objs == ["won.frames_Revenues_CY2025Q1", "WON_GHCN.ghcn_2025_TMAX"]
    assert cache.cache_state(("won.frames_{tag}_{period}",), {"tag": "Revenues", "period": "CY2025Q1"}, STORAGE)[0] == "hit"
    assert cache.cache_state(("won.frames_{tag}_{period}",), {"tag": "Revenues"}, STORAGE)[0] == "miss"  # unresolved placeholder


def test_cached_at_from_log_ignores_failures_other_schemas_and_events_before_driver_start(temp_sql_log):
    rows = [
        {"sql": "CACHE TABLE won.frames_revenues_cy2025q1", "executed_at": "2026-10-24T17:00:00+0800", "error": None},
        {"sql": "CACHE TABLE won.frames_revenues_cy2025q1", "executed_at": "2026-10-24T17:41:42+0800", "error": None},
        {"sql": "CACHE TABLE WON_GHCN.ghcn_2025_tmax", "executed_at": "2026-10-24T17:42:23+0800", "error": None},
        {"sql": "CACHE TABLE won.frames_revenues_cy2024q1", "executed_at": "2026-10-24T17:43:00+0800", "error": "boom"},
        {"sql": "CACHE TABLE clearshelf_fda.enforcement_undeclared", "executed_at": "2026-10-24T17:44:00+0800", "error": None},
    ]
    temp_sql_log.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    assert cache.last_cache_events() == {"won.frames_revenues_cy2025q1": "2026-10-24T17:41:42+0800",
                                         "won_ghcn.ghcn_2025_tmax": "2026-10-24T17:42:23+0800"}
    started_ms = int(datetime(2026, 10, 24, 9, 50, tzinfo=timezone.utc).timestamp() * 1000)
    assert cache.last_cache_events(since_ms=started_ms) == {}
    _, _, cached_at = cache.cache_state(("WON_GHCN.ghcn_2025_tmax", "won.frames_revenues_cy2024q1"), {}, STORAGE)
    assert cached_at == {"WON_GHCN.ghcn_2025_tmax": "2026-10-24T17:42:23+0800"}
